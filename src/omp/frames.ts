import type { Json, JsonRecord } from '../shared/types';
import { sanitizeDiagnostic } from './diagnostics';

export class RpcError extends Error {
  constructor(readonly kind: 'protocol' | 'command' | 'timeout' | 'closed' | 'invalid' | 'cancelled', message: string, readonly command: string | null = null, readonly code: string | null = null) {
    super(sanitizeDiagnostic(message)); this.name = 'RpcError';
  }
}
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJson(value);
}
export function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 128) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJson(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).every(item => isJson(item, depth + 1));
  return false;
}
export const PHYSICAL_LIMIT = 1048576;
export const LOGICAL_LIMIT = 67108864;
export const CHUNK_LIMIT = 262144;
interface ChunkSequence { id: string; count: number; length: number; index: number; received: number; parts: Buffer[] }

export class FrameDecoder {
  maxFrameBytes = PHYSICAL_LIMIT;
  maxReassembledFrameBytes = LOGICAL_LIMIT;
  protocolVersion = 1;
  negotiationRequestID: string | null = null;
  private line = Buffer.allocUnsafe(4096);
  private lineBytes = 0;
  private pending: ChunkSequence | null = null;
  configure(ready: JsonRecord): void {
    if (ready.protocolVersion !== 1 && ready.protocolVersion !== 2) throw new RpcError('protocol', 'Unsupported OMP protocol version.');
    if (ready.maxFrameBytes !== undefined) {
      if (typeof ready.maxFrameBytes !== 'number' || !Number.isSafeInteger(ready.maxFrameBytes) || ready.maxFrameBytes < 2) throw new RpcError('protocol', 'Invalid physical frame limit.');
      this.maxFrameBytes = Math.min(ready.maxFrameBytes, PHYSICAL_LIMIT);
    }
    if (ready.maxReassembledFrameBytes !== undefined) {
      if (typeof ready.maxReassembledFrameBytes !== 'number' || !Number.isSafeInteger(ready.maxReassembledFrameBytes) || ready.maxReassembledFrameBytes < this.maxFrameBytes) throw new RpcError('protocol', 'Invalid reassembled frame limit.');
      this.maxReassembledFrameBytes = Math.min(ready.maxReassembledFrameBytes, LOGICAL_LIMIT);
    }
    this.protocolVersion = ready.protocolVersion;
  }
  append(bytes: Uint8Array): JsonRecord[] {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const result: JsonRecord[] = [];
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      const nextLength = this.lineBytes + end - start;
      if (nextLength + 1 > this.maxFrameBytes) throw new RpcError('protocol', 'RPC physical frame exceeds its byte limit.');
      if (nextLength > this.line.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.maxFrameBytes, Math.max(nextLength, this.line.length * 2)));
        this.line.copy(grown, 0, 0, this.lineBytes); this.line = grown;
      }
      buffer.copy(this.line, this.lineBytes, start, end); this.lineBytes = nextLength;
      if (newline < 0) break;
      let line = this.line.subarray(0, this.lineBytes); this.lineBytes = 0;
      if (line[line.length - 1] === 13) line = line.subarray(0, -1);
      if (line.length) {
        const frame = this.accept(FrameDecoder.parse(line));
        if (frame) {
          if (frame.type === 'ready') this.configure(frame);
          if (frame.type === 'response' && frame.command === 'negotiate_protocol' && this.negotiationRequestID !== null && frame.id === this.negotiationRequestID && frame.success === true && isRecord(frame.data) && frame.data.protocolVersion === 2) this.protocolVersion = 2;
          result.push(frame);
        }
      } else if (this.pending) throw new RpcError('protocol', 'RPC chunk sequence interrupted by an empty frame.');
      start = newline + 1;
    }
    return result;
  }
  finish(): void {
    if (this.lineBytes) throw new RpcError('protocol', 'RPC stream ended inside a JSONL frame.');
    if (this.pending) throw new RpcError('protocol', 'RPC stream ended inside a chunk sequence.');
  }
  private static parse(bytes: Buffer): JsonRecord {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RpcError('protocol', 'OMP emitted malformed JSON or invalid UTF-8.'); }
    if (!isRecord(value) || typeof value.type !== 'string' || !value.type) throw new RpcError('protocol', 'RPC frame must be an object with a type.');
    return value;
  }
  private accept(frame: JsonRecord): JsonRecord | null {
    if (frame.type !== 'rpc_chunk') {
      if (this.pending) throw new RpcError('protocol', 'RPC chunk sequence interrupted.');
      return frame;
    }
    if (this.protocolVersion !== 2) throw new RpcError('protocol', 'OMP sent chunks before v2 negotiation.');
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== 'string' || !chunkId || chunkId.length > 128 || typeof index !== 'number' || !Number.isSafeInteger(index) || typeof count !== 'number' || !Number.isSafeInteger(count) || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || index < 0 || count < 2 || index >= count || count > Math.ceil(LOGICAL_LIMIT / CHUNK_LIMIT) || byteLength < this.maxFrameBytes || byteLength > this.maxReassembledFrameBytes) throw new RpcError('protocol', 'Invalid RPC chunk metadata.');
    if (typeof data !== 'string' || !data || data.length > Math.ceil(CHUNK_LIMIT / 3) * 4) throw new RpcError('protocol', 'Invalid RPC chunk payload.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.length > CHUNK_LIMIT) throw new RpcError('protocol', 'Invalid RPC chunk base64 payload.');
    if (!this.pending) {
      if (index !== 0) throw new RpcError('protocol', 'RPC chunk sequence must begin at zero.');
      this.pending = { id: chunkId, count, length: byteLength, index: 0, received: 0, parts: [] };
    }
    const sequence = this.pending;
    if (sequence.id !== chunkId || sequence.count !== count || sequence.length !== byteLength || sequence.index !== index) throw new RpcError('protocol', 'RPC chunk sequence mismatch.');
    sequence.received += bytes.length;
    if (sequence.received > sequence.length) throw new RpcError('protocol', 'RPC chunks exceed declared byte length.');
    sequence.parts.push(bytes); sequence.index++;
    if (sequence.index !== sequence.count) return null;
    if (sequence.received !== sequence.length) throw new RpcError('protocol', 'RPC reassembled byte length mismatch.');
    this.pending = null;
    const logical = FrameDecoder.parse(Buffer.concat(sequence.parts, sequence.length));
    if (logical.type === 'rpc_chunk') throw new RpcError('protocol', 'Nested RPC chunk frames are invalid.');
    return logical;
  }
}
