import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Json, JsonRecord } from '../shared/types';
import { toolEnvironment } from '../services/executable';
import { FrameDecoder, RpcError, isRecord } from './frames';
import { DiagnosticBuffer, sanitizeDiagnostic } from './diagnostics';
export { RpcError } from './frames';

interface Pending { command: string; resolve: (data: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; controller: AbortController; dispose: () => void }
interface WriteItem { bytes: Buffer; signal: AbortSignal | undefined; resolve: () => void; reject: (error: Error) => void; abort: () => void; started: boolean }
type Phase = 'idle' | 'starting' | 'ready' | 'closing' | 'failed';

export class RpcClient extends EventEmitter<{ event: [JsonRecord]; idle: [] }> {
  private phase: Phase = 'idle';
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new FrameDecoder();
  private diagnosticBuffer = new DiagnosticBuffer();
  private pending = new Map<string, Pending>();
  private issued = new Map<string, string>();
  private writes: WriteItem[] = [];
  private currentWrite: WriteItem | null = null;
  private queuedBytes = 0;
  private generation = 0;
  private readyFrame: JsonRecord | null = null;
  private readyResolve: ((frame: JsonRecord) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private closePromise: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | null = null;
  private startController: AbortController | null = null;
  get ready(): boolean { return this.phase === 'ready'; }
  get hasPendingRequests(): boolean { return this.pending.size > 0; }
  get maxInputFrameBytes(): number { return this.decoder.maxFrameBytes; }
  diagnostics(): string { return this.diagnosticBuffer.text; }

  async start(options: { executable: string; projectPath: string; sessionDirectory: string; resume: boolean; model?: string; sessionFile?: string }): Promise<void> {
    if (this.startController || this.phase === 'starting' || this.phase === 'ready' || this.phase === 'closing') throw new RpcError('invalid', 'This thread already owns an OMP process.');
    const controller = new AbortController();
    this.startController = controller;
    try {
      if (this.child) {
        if (!this.shutdownPromise) this.shutdownPromise = this.finishShutdown();
        try { await this.shutdownPromise; } finally { this.shutdownPromise = null; }
      }
      if (controller.signal.aborted) throw new RpcError('cancelled', 'OMP startup was cancelled.');
      await this.launch(options, controller.signal);
    } finally {
      if (this.startController === controller) this.startController = null;
      if (!this.child) this.phase = 'idle';
    }
  }

  private async launch(options: { executable: string; projectPath: string; sessionDirectory: string; resume: boolean; model?: string; sessionFile?: string }, signal: AbortSignal): Promise<void> {
    this.phase = 'starting';
    const projectPath = await realpath(options.projectPath).catch(() => { throw new RpcError('invalid', 'The project folder is missing. Locate it before reopening the thread.'); });
    if (!(await stat(projectPath)).isDirectory()) throw new RpcError('invalid', 'The project path is not a folder.');
    await access(options.executable, constants.X_OK).catch(() => { throw new RpcError('invalid', 'OMP cannot be executed. Choose a working executable in Settings.'); });
    if (signal.aborted) throw new RpcError('cancelled', 'OMP startup was cancelled.');
    await mkdir(options.sessionDirectory, { recursive: true });
    if (signal.aborted) throw new RpcError('cancelled', 'OMP startup was cancelled.');
    const generation = ++this.generation;
    this.decoder = new FrameDecoder(); this.diagnosticBuffer = new DiagnosticBuffer(); this.issued.clear(); this.readyFrame = null;
    this.phase = 'starting';
    const readyGate = Promise.withResolvers<JsonRecord>();
    const readyPromise = readyGate.promise;
    this.readyResolve = readyGate.resolve; this.readyReject = readyGate.reject;
    const timer = setTimeout(() => this.fail(new RpcError('timeout', 'OMP did not send its ready handshake before the deadline.')), 15000);
    const child = spawn(options.executable, ['--mode', 'rpc-ui', '--cwd', projectPath, '--session-dir', options.sessionDirectory, ...(options.sessionFile ? ['--resume', options.sessionFile] : options.resume ? ['--continue'] : []), ...(options.model ? ['--model', options.model] : [])], { cwd: projectPath, env: toolEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child = child;
    const closed = Promise.withResolvers<void>();
    child.once('close', () => closed.resolve());
    this.closePromise = closed.promise;
    child.stdout.on('data', (bytes: Buffer) => {
      if (generation !== this.generation || this.phase === 'failed') return;
      try { for (const frame of this.decoder.append(bytes)) this.handle(frame); }
      catch (error) { this.fail(error instanceof Error ? error : new RpcError('protocol', 'Invalid OMP output.')); }
    });
    child.stderr.on('data', (bytes: Buffer) => { if (generation === this.generation) this.diagnosticBuffer.append(bytes); });
    child.stderr.on('end', () => { if (generation === this.generation) this.diagnosticBuffer.finish(); });
    child.stdout.on('end', () => {
      if (generation !== this.generation) return;
      try { this.decoder.finish(); } catch (error) { if (this.phase !== 'closing') this.fail(error instanceof Error ? error : new RpcError('protocol', 'Incomplete OMP output.')); }
      if (this.phase !== 'closing' && this.phase !== 'failed') this.fail(new RpcError('closed', 'OMP closed its output unexpectedly. Reopen the thread to recover saved history.'));
    });
    child.stdout.on('error', error => { if (generation === this.generation && this.phase !== 'closing') this.fail(error); });
    child.stderr.on('error', () => this.diagnosticBuffer.finish());
    child.stdin.on('error', error => { if (generation === this.generation && this.phase !== 'closing') this.fail(error); });
    child.on('error', error => { if (generation === this.generation) this.fail(error); });
    try {
      const ready = await readyPromise;
      clearTimeout(timer);
      if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
        const negotiated = await this.request('negotiate_protocol', { protocolVersion: 2 }, { timeout: 10000 });
        if (!isRecord(negotiated) || negotiated.protocolVersion !== 2) throw new RpcError('protocol', 'OMP did not confirm protocol v2 negotiation.');
        this.decoder.protocolVersion = 2;
      }
      if (signal.aborted || this.phase !== 'starting' || generation !== this.generation) throw new RpcError('closed', 'OMP exited during startup.');
      this.phase = 'ready';
    } catch (error) {
      clearTimeout(timer);
      this.fail(error instanceof Error ? error : new RpcError('closed', 'OMP failed to start.'));
      await this.shutdown();
      throw error;
    }
  }

  request(type: string, fields: JsonRecord = {}, options: { timeout?: number; id?: string; signal?: AbortSignal } = {}): Promise<Json> {
    if (this.phase !== 'ready' && !(this.phase === 'starting' && this.readyFrame)) return Promise.reject(new RpcError('closed', 'OMP is not connected. Reopen the thread.'));
    const timeout = options.timeout ?? 30000;
    const id = options.id ?? randomUUID();
    if (!type || !id || !Number.isFinite(timeout) || timeout <= 0 || this.issued.has(id) || this.issued.size >= 100000) return Promise.reject(new RpcError('invalid', 'RPC requests require a positive timeout and a unique nonempty ID.'));
    if (options.signal?.aborted) return Promise.reject(new RpcError('cancelled', 'The request was cancelled.'));
    this.issued.set(id, type);
    if (type === 'negotiate_protocol') this.decoder.negotiationRequestID = id;
    const { promise, resolve, reject } = Promise.withResolvers<Json>();
    const controller = new AbortController();
    const abort = () => this.expire(id, new RpcError('cancelled', 'The request was cancelled.', type));
    const timer = setTimeout(() => this.expire(id, new RpcError('timeout', `OMP did not answer ${type} before the deadline. Admission is unknown; do not replay the action.`, type)), timeout);
    const dispose = () => options.signal?.removeEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    this.pending.set(id, { command: type, resolve, reject, timer, controller, dispose });
    void this.send({ ...fields, type, id }, { signal: controller.signal }).catch(error => this.expire(id, error instanceof Error ? error : new RpcError('closed', 'OMP stdin failed.')));
    return promise;
  }

  send(frame: JsonRecord, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.phase !== 'ready' && !(this.phase === 'starting' && this.readyFrame)) return Promise.reject(new RpcError('closed', 'OMP stdin is unavailable.'));
    if (options.signal?.aborted) return Promise.reject(new RpcError('cancelled', 'The response was cancelled.'));
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(frame) + '\n', 'utf8'); }
    catch { return Promise.reject(new RpcError('invalid', 'This request cannot be encoded.')); }
    if (bytes.length > this.decoder.maxFrameBytes) return Promise.reject(new RpcError('invalid', "This request exceeds OMP's input limit. Send less text or a smaller image."));
    if (this.queuedBytes + bytes.length > 8 * 1048576) return Promise.reject(new RpcError('invalid', 'OMP input is backed up. Wait for current work or stop it before sending more.'));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const item: WriteItem = { bytes, signal: options.signal, resolve, reject, started: false, abort: () => {
      if (item.started) {
        // Once a write starts, Node may have delivered a prefix. Never append another
        // frame to a cancelled prefix or allow queued approvals after it.
        this.fail(new RpcError('closed', 'OMP input was cancelled during a write. Reopen the thread; no action will be replayed.'));
      } else {
        const index = this.writes.indexOf(item);
        if (index >= 0) { this.writes.splice(index, 1); this.queuedBytes -= item.bytes.length; }
        item.signal?.removeEventListener('abort', item.abort);
        item.reject(new RpcError('cancelled', 'The response was cancelled before it was sent.'));
      }
    } };
    this.writes.push(item); this.queuedBytes += bytes.length;
    item.signal?.addEventListener('abort', item.abort, { once: true });
    this.drainInput();
    return promise;
  }

  private drainInput(): void {
    if (this.currentWrite || !this.child || this.phase === 'failed' || this.phase === 'closing') return;
    const item = this.writes.shift();
    if (!item) return;
    this.currentWrite = item; item.started = true;
    const generation = this.generation;
    this.child.stdin.write(item.bytes, error => {
      if (generation !== this.generation || this.currentWrite !== item) return;
      this.currentWrite = null; this.queuedBytes -= item.bytes.length;
      item.signal?.removeEventListener('abort', item.abort);
      if (error) { item.reject(error); this.fail(error); }
      else { item.resolve(); this.drainInput(); }
    });
  }
  private expire(id: string, error: Error): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id); clearTimeout(request.timer); request.dispose();
    request.reject(error); request.controller.abort();
  }
  private handle(frame: JsonRecord): void {
    if (frame.type === 'ready') {
      if (this.phase !== 'starting' || this.readyFrame) throw new RpcError('protocol', 'Unexpected duplicate OMP ready frame.');
      this.readyFrame = frame; this.readyResolve?.(frame); this.readyResolve = null; this.readyReject = null;
    } else if (frame.type === 'response') {
      const id = typeof frame.id === 'string' ? frame.id : null;
      const command = id === null ? undefined : this.issued.get(id);
      if (command !== undefined && (frame.command !== command || typeof frame.success !== 'boolean')) throw new RpcError('protocol', 'OMP response does not match its request.');
      const pending = id === null ? undefined : this.pending.get(id);
      if (pending && id !== null) {
        this.pending.delete(id); clearTimeout(pending.timer); pending.dispose();
        if (command === 'prompt' || command === 'abort_and_prompt' || command === 'get_messages' || command === 'get_messages_page' || (command === 'set_todos' && frame.success === true) || (command === 'compact' && frame.success === true)) this.emit('event', frame);
        if (frame.success === true) pending.resolve(frame.data ?? null);
        else pending.reject(new RpcError('command', typeof frame.error === 'string' ? frame.error : 'OMP rejected the command.', pending.command, typeof frame.code === 'string' ? frame.code : null));
        if (!this.pending.size) queueMicrotask(() => { if (this.phase === 'ready' && !this.pending.size) this.emit('idle'); });
      } else if (frame.success === false || command === 'prompt' || command === 'abort_and_prompt' || command === 'promote_queued_message' || command === 'compact') this.emit('event', frame);
    } else if (frame.type === 'rpc_frame_error') throw new RpcError('protocol', typeof frame.error === 'string' ? frame.error : 'OMP could not deliver a complete event.');
    else this.emit('event', frame);
  }
  private fail(error: Error): void {
    if (this.phase === 'failed' || this.phase === 'idle') return;
    this.phase = 'failed';
    this.readyReject?.(error); this.readyReject = null; this.readyResolve = null;
    this.rejectInput(error);
    for (const id of this.pending.keys()) this.expire(id, error);
    this.emit('event', { type: 'transport_error', error: sanitizeDiagnostic(error.message) });
    this.child?.stdin.destroy(); this.child?.kill('SIGTERM');
  }
  private rejectInput(error: Error): void {
    const items = [...this.writes, ...(this.currentWrite ? [this.currentWrite] : [])];
    this.writes = []; this.currentWrite = null; this.queuedBytes = 0;
    for (const item of items) { item.signal?.removeEventListener('abort', item.abort); item.reject(error); }
  }
  async shutdown(): Promise<void> {
    this.startController?.abort();
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.child) { this.phase = 'idle'; return; }
    this.shutdownPromise = this.finishShutdown();
    try { await this.shutdownPromise; } finally { this.shutdownPromise = null; }
  }
  private async finishShutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.phase = 'closing';
    const error = new RpcError('closed', 'OMP was shut down before replying.');
    this.readyReject?.(error); this.readyReject = null; this.readyResolve = null;
    this.rejectInput(error);
    for (const id of this.pending.keys()) this.expire(id, error);
    child.stdin.end();
    // Keep stdout/stderr actively draining through EOF and process close.
    const eofDeadline = Promise.withResolvers<void>();
    let timer = setTimeout(eofDeadline.resolve, 3000);
    await Promise.race([this.closePromise, eofDeadline.promise]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const terminateDeadline = Promise.withResolvers<void>();
      timer = setTimeout(terminateDeadline.resolve, 1000);
      await Promise.race([this.closePromise, terminateDeadline.promise]);
      clearTimeout(timer);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const drainDeadline = Promise.withResolvers<void>();
    timer = setTimeout(drainDeadline.resolve, 1000);
    await Promise.race([this.closePromise, drainDeadline.promise]);
    clearTimeout(timer);
    ++this.generation; child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    this.child = null; this.readyFrame = null; this.phase = 'idle'; this.diagnosticBuffer.finish();
  }
}
