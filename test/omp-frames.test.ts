import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, RpcError } from '../src/omp/frames';
import { DiagnosticBuffer, sanitizeDiagnostic } from '../src/omp/diagnostics';
import type { JsonRecord } from '../src/shared/types';

const ready: JsonRecord = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1024, maxReassembledFrameBytes: 4096 };
function chunks(frame: JsonRecord): Buffer {
  const bytes = Buffer.from(JSON.stringify(frame));
  const middle = Math.ceil(bytes.length / 2);
  return Buffer.from([bytes.subarray(0, middle), bytes.subarray(middle)].map((part, index) => JSON.stringify({ type: 'rpc_chunk', chunkId: 'chunk', index, count: 2, byteLength: bytes.length, data: part.toString('base64') }) + '\n').join(''));
}

test('JSONL splits UTF-8 arbitrarily, handles CRLF and rejects nonobjects/invalid UTF-8', () => {
  const decoder = new FrameDecoder();
  const bytes = Buffer.from('{"type":"notice","message":"🌱 café"}\r\n\n');
  const frames: JsonRecord[] = [];
  for (const byte of bytes) frames.push(...decoder.append(Buffer.from([byte])));
  assert.deepEqual(frames, [{ type: 'notice', message: '🌱 café' }]); decoder.finish();
  for (const invalid of [Buffer.from('null\n'), Buffer.from('[]\n'), Buffer.from('{broken}\n'), Buffer.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 255, 34, 125, 10])]) assert.throws(() => new FrameDecoder().append(invalid), RpcError);
});

test('ready and correlated negotiation update decoder before next coalesced physical line', () => {
  const decoder = new FrameDecoder(); decoder.negotiationRequestID = 'negotiation';
  const logical = { type: 'notice', message: 'x'.repeat(1100) };
  const input = Buffer.concat([Buffer.from(JSON.stringify(ready) + '\n'), Buffer.from(JSON.stringify({ type: 'response', id: 'negotiation', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } }) + '\n'), chunks(logical)]);
  const frames = decoder.append(input);
  assert.equal(decoder.protocolVersion, 2); assert.deepEqual(frames.at(-1), logical);
  const uncorrelated = new FrameDecoder(); uncorrelated.configure(ready); uncorrelated.negotiationRequestID = 'other';
  assert.throws(() => uncorrelated.append(input.subarray(input.indexOf(10) + 1)), /before v2/);
});

test('physical limits include newline and CR; logical reassembly checks metadata and EOF', () => {
  const decoder = new FrameDecoder(); decoder.configure({ ...ready, maxFrameBytes: 32 });
  assert.throws(() => decoder.append(Buffer.from('x'.repeat(32))), /physical frame/);
  const unfinished = new FrameDecoder(); unfinished.append(Buffer.from('{"type":"notice"}')); assert.throws(() => unfinished.finish(), /JSONL/);
  const logical = { type: 'notice', message: 'x'.repeat(1100) };
  const lines = chunks(logical).toString().trim().split('\n');
  for (const variation of ['reversed', 'interleaved', 'empty', 'bad-base64', 'bad-length', 'fractional', 'oversized', 'nested']) {
    const current = new FrameDecoder(); current.configure(ready); current.protocolVersion = 2;
    let input = chunks(logical);
    if (variation === 'reversed') input = Buffer.from([...lines].reverse().join('\n') + '\n');
    if (variation === 'interleaved') input = Buffer.from((lines[0] ?? '') + '\n{"type":"notice"}\n' + (lines[1] ?? '') + '\n');
    if (variation === 'empty') input = Buffer.from((lines[0] ?? '') + '\n\n');
    if (variation === 'bad-base64') input = Buffer.from(input.toString().replace('"data":"', '"data":"!'));
    if (variation === 'bad-length') input = Buffer.from(input.toString().replace(/"byteLength":\d+/g, '"byteLength":1500'));
    if (variation === 'fractional') input = Buffer.from(input.toString().replace('"index":0', '"index":0.5'));
    if (variation === 'oversized') input = Buffer.from(input.toString().replace(/"byteLength":\d+/g, '"byteLength":5000'));
    if (variation === 'nested') input = chunks({ type: 'rpc_chunk', padding: 'x'.repeat(1100) });
    assert.throws(() => current.append(input), RpcError, variation);
  }
  const incomplete = new FrameDecoder(); incomplete.configure(ready); incomplete.protocolVersion = 2;
  incomplete.append(Buffer.from((lines[0] ?? '') + '\n')); assert.throws(() => incomplete.finish(), /chunk sequence/);
});

test('advertised limits cannot loosen client limits, accept fractional counters or invalid versions', () => {
  for (const frame of [{ ...ready, protocolVersion: 3 }, { ...ready, maxFrameBytes: 1 }, { ...ready, maxFrameBytes: 1024.5 }, { ...ready, maxReassembledFrameBytes: 100 }]) assert.throws(() => new FrameDecoder().configure(frame), RpcError);
  const decoder = new FrameDecoder(); decoder.configure({ ...ready, maxFrameBytes: 999999999, maxReassembledFrameBytes: 999999999 });
  assert.equal(decoder.maxFrameBytes, 1048576); assert.equal(decoder.maxReassembledFrameBytes, 67108864);
});

test('chunk sequences reject duplicates, changed metadata, invalid reassembled UTF-8, arrays and JSON', () => {
  const invalidBodies = [Buffer.alloc(1100, 255), Buffer.alloc(1100, 32), Buffer.from('[' + ' '.repeat(1100) + ']')];
  for (const bytes of invalidBodies) {
    const decoder = new FrameDecoder(); decoder.configure(ready); decoder.protocolVersion = 2;
    const lines = [bytes.subarray(0, 600), bytes.subarray(600)].map((part, index) => JSON.stringify({ type: 'rpc_chunk', chunkId: 'body', index, count: 2, byteLength: bytes.length, data: part.toString('base64') }) + '\n').join('');
    assert.throws(() => decoder.append(Buffer.from(lines)), RpcError);
  }
  const frames = chunks({ type: 'notice', message: 'x'.repeat(1100) }).toString().trim().split('\n');
  const first = frames[0] ?? '', second = frames[1] ?? '';
  for (const final of [first, second.replace('"chunkId":"chunk"', '"chunkId":"other"'), second.replace('"count":2', '"count":3')]) {
    const decoder = new FrameDecoder(); decoder.configure(ready); decoder.protocolVersion = 2;
    decoder.append(Buffer.from(first + '\n'));
    assert.throws(() => decoder.append(Buffer.from(final + '\n')), /mismatch/);
  }
  const logical = { type: 'notice', message: '東京'.repeat(180) };
  const bytes = chunks(logical);
  const decoder = new FrameDecoder(); decoder.configure(ready); decoder.protocolVersion = 2;
  const result: JsonRecord[] = [];
  for (const byte of bytes) result.push(...decoder.append(Buffer.from([byte])));
  assert.deepEqual(result, [logical]); decoder.finish();
});

test('diagnostic redaction occurs across batches before truncation and omits oversized records', () => {
  const buffer = new DiagnosticBuffer();
  buffer.append(Buffer.from('authorization: Bear')); buffer.append(Buffer.from('er sk-abcdef0123456789\nhttps://alice:password@host/path?token=private\n'));
  assert.doesNotMatch(buffer.text, /abcdef0123456789|alice:password|token=private/);
  buffer.append(Buffer.from('x'.repeat(8192) + 'api_key=secret')); buffer.finish();
  assert.match(buffer.text, /Oversized diagnostic/); assert.doesNotMatch(buffer.text, /api_key=secret/);
  assert.doesNotMatch(sanitizeDiagnostic('\x1b[31mapi_key="something"\x1b[0m'), /something|\x1b/);
});
