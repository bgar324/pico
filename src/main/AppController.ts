import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, realpath, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import type { AppInfo, AppSnapshot, Manifest, Preferences, ThreadRecord, UiEvent, ImageAttachment, JsonRecord } from '../shared/types';
import { isBusy } from '../shared/types';
import { SIDEBAR_DEFAULT_WIDTH } from '../shared/sidebar-layout';
import { Persistence } from '../services/Persistence';
import { resolveExecutable } from '../services/executable';
import { RpcClient } from '../omp/RpcClient';
import { ThreadRuntime } from '../omp/ThreadRuntime';
import { IMAGE_BYTE_LIMIT, IMAGE_TOTAL_BYTE_LIMIT, isImageContent } from '../shared/validation';

export interface DesktopHost {
  chooseDirectory(title: string): Promise<string | null>;
  chooseExecutable(): Promise<string | null>;
  chooseImages(): Promise<string[]>;
  confirmDelete(thread: ThreadRecord): Promise<boolean>;
  confirmTerminal(thread: ThreadRecord): Promise<boolean>;
  reveal(path: string): Promise<void>;
  terminal(command: string): Promise<void>;
  darkMode(): boolean;
}
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
interface Opening { abort: AbortController; task: Promise<void>; reason: 'open' | 'provider-connections' }
export class AppController {
  manifest: Manifest = { projects: [], threads: [], selectedThreadID: null, sidebarVisible: true };
  preferences: Preferences = { executableOverride: '', appearance: 'system', defaultProjectPath: '', sidebarWidth: SIDEBAR_DEFAULT_WIDTH };
  executablePath: string | null = null;
  connectionStatus = 'Checking OMP…';
  error: string | null = null;
  readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly runtimeRevisions = new Map<string, number>();
  private readonly opening = new Map<string, Opening>();
  private readonly connectionTests = new Map<RpcClient, Promise<void>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly closing = new Set<string>();
  private readonly admitting = new Set<string>();
  private readonly providerConnectionRefreshes = new Map<string, ThreadRuntime>();
  private providerConnectionRevision = 0;
  private providerConnectionRefreshTask: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private saveChain: Promise<void> = Promise.resolve();
  private revision = 0;
  private connectionEpoch = 0;
  private writable = true;
  private stopping = false;
  private loaded = false;
  constructor(readonly persistence: Persistence, readonly host: DesktopHost, private readonly emit: (event: UiEvent) => void) {}

  async bootstrap(): Promise<void> {
    const connectionEpoch = ++this.connectionEpoch;
    try {
      this.manifest = await this.persistence.load();
      this.preferences = await this.persistence.loadPreferences();
      this.loaded = true;
    } catch (error) {
      this.writable = false;
      this.error = `Could not read local metadata. The original file was not overwritten. ${error instanceof Error ? error.message : String(error)}`;
    }
    this.notify();
    const executable = await this.connectionExecutable(connectionEpoch);
    if (!executable || this.stopping) return;
    const id = this.manifest.selectedThreadID;
    if (!id) { await this.probeConnection(executable, connectionEpoch); return; }
    if (connectionEpoch === this.connectionEpoch) { this.connectionStatus = 'Connecting to OMP…'; this.notify(); }
    if (this.stopping) return;
    const opening = this.openThread(id, false, executable);
    const runtime = this.runtimes.get(id);
    await opening;
    if (this.stopping || connectionEpoch !== this.connectionEpoch || !runtime || this.runtimes.get(id) !== runtime) return;
    const state = runtime.summary();
    if (state.status.kind === 'ready') this.connectionStatus = 'Connected to OMP';
    else if (state.error) this.connectionStatus = `OMP connection failed: ${state.error}`;
    this.notify();
  }
  info(): AppInfo {
    return { revision: this.revision, manifest: structuredClone(this.manifest), preferences: { ...this.preferences }, executablePath: this.executablePath, connectionStatus: this.connectionStatus, error: this.error,
      theme: this.preferences.appearance === 'system' ? this.host.darkMode() ? 'dark' : 'light' : this.preferences.appearance };
  }
  snapshot(): AppSnapshot { return { ...this.info(), runtimes: [...this.runtimes.values()].map(runtime => runtime.snapshot()) }; }
  notify(): void { this.revision += 1; this.emit({ kind: 'app', snapshot: this.info() }); }
  private requireThread(id: string): ThreadRecord {
    const record = this.manifest.threads.find(thread => thread.id === id);
    if (!record) throw new Error('This conversation no longer exists.');
    return record;
  }
  private requireWritable(): void {
    if (!this.writable || !this.loaded) throw new Error('Repair local metadata before changing saved conversations. Reveal storage in Settings.');
    if (this.stopping) throw new Error('The application is closing.');
  }
  async testConnection(): Promise<void> {
    const connectionEpoch = ++this.connectionEpoch;
    const executable = await this.connectionExecutable(connectionEpoch);
    if (executable) await this.probeConnection(executable, connectionEpoch);
  }
  private async connectionExecutable(connectionEpoch: number): Promise<string | null> {
    if (this.stopping) return null;
    const executable = await resolveExecutable(this.preferences.executableOverride);
    if (this.stopping) return null;
    if (connectionEpoch === this.connectionEpoch) {
      this.executablePath = executable;
      if (!executable) { this.connectionStatus = 'OMP executable not found. Choose an executable or install OMP.'; this.notify(); }
    }
    return executable;
  }
  private async probeConnection(executable: string, connectionEpoch: number): Promise<void> {
    if (this.stopping || connectionEpoch !== this.connectionEpoch) return;
    this.connectionStatus = 'Testing OMP connection…'; this.notify();
    if (this.stopping) return;
    const client = new RpcClient();
    client.on('event', (frame: JsonRecord) => {
      if (frame.type === 'extension_ui_request' && typeof frame.id === 'string') {
        void client.send({ type: 'extension_ui_response', id: frame.id, cancelled: true }).catch(() => undefined);
      }
    });
    const task = Promise.resolve().then(async () => {
      let root: string | undefined;
      try {
        root = await mkdtemp(join(tmpdir(), 'pi-desktop-connection-'));
        if (this.stopping) return;
        await client.start({ executable, projectPath: root, sessionDirectory: join(root, 'OMP'), resume: false });
        if (this.stopping) return;
        await client.request('get_state');
        if (!this.stopping && connectionEpoch === this.connectionEpoch) this.connectionStatus = 'Connected to OMP';
      } catch (error) {
        if (!this.stopping && connectionEpoch === this.connectionEpoch) {
          this.connectionStatus = `OMP connection failed: ${error instanceof Error ? error.message : String(error)}`;
          this.executablePath = null;
        }
      } finally {
        await client.shutdown();
        if (root) await rm(root, { recursive: true, force: true });
        if (!this.stopping && connectionEpoch === this.connectionEpoch) this.notify();
      }
    }).finally(() => { this.connectionTests.delete(client); });
    this.connectionTests.set(client, task);
    await task;
  }
  async openProject(): Promise<void> {
    const path = await this.host.chooseDirectory('Open project');
    if (path) await this.addProject(path);
  }
  async addProject(path: string): Promise<void> {
    this.requireWritable();
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Choose a project folder.');
    if (!this.manifest.projects.some(project => project.path === canonical)) this.manifest.projects.push({ id: randomUUID().toUpperCase(), path: canonical, expanded: true });
    await this.newThread(canonical);
  }
  async newThread(projectPath?: string): Promise<void> {
    this.requireWritable();
    const path = projectPath ?? this.manifest.threads.find(thread => thread.id === this.manifest.selectedThreadID)?.projectPath ??
      (this.preferences.defaultProjectPath || this.manifest.projects[0]?.path);
    if (!path) { await this.openProject(); return; }
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('The project folder is missing. Locate it before creating a thread.');
    const id = randomUUID().toUpperCase();
    const now = new Date().toISOString();
    const record: ThreadRecord = { id, projectPath: canonical, displayTitle: 'New thread', ompSessionDirectory: this.persistence.sessionDirectory(id), createdAt: now, updatedAt: now, draft: '', wasRunning: false };
    this.manifest.threads.push(record);
    if (!this.manifest.projects.some(project => project.path === canonical)) this.manifest.projects.push({ id: randomUUID().toUpperCase(), path: canonical, expanded: true });
    this.saveSoon(); this.notify(); await this.selectThread(id);
  }
  selectThread(id: string, reopen = false): Promise<void> {
    return this.openThread(id, reopen, this.executablePath);
  }
  async refreshProviderConnections(): Promise<void> {
    if (this.stopping) return;
    this.providerConnectionRevision++;
    for (const [id, runtime] of this.runtimes) {
      if (!this.closing.has(id) && !this.retiring.has(id)) this.providerConnectionRefreshes.set(id, runtime);
    }
    if (this.providerConnectionRefreshTask) return this.providerConnectionRefreshTask;
    const task = Promise.resolve().then(async () => {
      let revision: number;
      do {
        revision = this.providerConnectionRevision;
        const connectionEpoch = ++this.connectionEpoch;
        try {
          // Account setup must recover even when the original no-model probe failed.
          const executable = await this.connectionExecutable(connectionEpoch);
          if (!executable || this.stopping || connectionEpoch !== this.connectionEpoch) continue;
          const selected = this.manifest.selectedThreadID;
          if (selected && !this.runtimes.has(selected) && !this.closing.has(selected) && !this.retiring.has(selected)) {
            await this.openThread(selected, false, executable, 'provider-connections');
          }
          // Active conversations retain their pending entry until an idle notification.
          await Promise.all([...this.providerConnectionRefreshes].map(([id, runtime]) => this.refreshRuntimeProviderConnections(id, runtime)));
          if (this.stopping || connectionEpoch !== this.connectionEpoch) continue;
          if (!this.runtimes.size && !this.closing.size && !this.retiring.size) await this.probeConnection(executable, connectionEpoch);
          else this.updateRuntimeConnectionStatus();
        } catch (error) {
          if (!this.stopping && connectionEpoch === this.connectionEpoch) {
            this.connectionStatus = `OMP connection failed: ${error instanceof Error ? error.message : String(error)}`;
            this.notify();
          }
        }
      } while (!this.stopping && revision !== this.providerConnectionRevision);
    }).finally(() => {
      if (this.providerConnectionRefreshTask === task) this.providerConnectionRefreshTask = null;
    });
    this.providerConnectionRefreshTask = task;
    await task;
  }
  private updateRuntimeConnectionStatus(): void {
    const runtime = this.runtimes.get(this.manifest.selectedThreadID ?? '') ??
      [...this.runtimes.values()].find(candidate => candidate.summary().status.kind === 'ready');
    if (!runtime) return;
    const state = runtime.summary();
    const status = state.status.kind === 'ready' ? 'Connected to OMP' : state.status.kind === 'connecting' ? 'Connecting to OMP…' :
      state.error ? `OMP connection failed: ${state.error}` : this.connectionStatus;
    if (status !== this.connectionStatus) { this.connectionStatus = status; this.notify(); }
  }
  private refreshRuntimeProviderConnections(id: string, runtime: ThreadRuntime): Promise<void> {
    // Run after the current lifecycle frame, never from inside settle()/dialog reduction.
    return Promise.resolve().then(async () => {
      if (this.stopping || this.providerConnectionRefreshes.get(id) !== runtime || this.runtimes.get(id) !== runtime ||
        this.closing.has(id) || this.retiring.has(id) || this.admitting.has(id)) return;
      const opening = this.opening.get(id);
      if (opening) { await opening.task; return; }
      if (!runtime.canRefreshProviderConnections || !this.executablePath) return;
      const connectionEpoch = this.connectionEpoch;
      await this.openThread(id, true, this.executablePath, 'provider-connections');
      if (!this.stopping && connectionEpoch === this.connectionEpoch) this.updateRuntimeConnectionStatus();
    }).catch(error => {
      if (this.stopping || this.closing.has(id) || this.runtimes.get(id) !== runtime) return;
      this.error = `Could not refresh this conversation's provider models. Reopen it to try again. ${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    });
  }
  private async openThread(id: string, reopen: boolean, executable: string | null, reason: 'open' | 'provider-connections' = 'open'): Promise<void> {
    this.requireThread(id);
    if (this.stopping || this.closing.has(id) || this.retiring.has(id)) throw new Error('This conversation is being closed.');
    if (reason === 'open') { this.manifest.selectedThreadID = id; this.saveSoon(); this.notify(); }
    const pending = this.opening.get(id);
    if (pending) { await pending.task; return; }
    const existing = this.runtimes.get(id);
    if (existing && existing.summary().status.kind === 'ready' && !reopen) {
      this.emit({ kind: 'runtime', event: { kind: 'snapshot', runtime: existing.snapshot() } }); return;
    }
    if (existing && reopen && (isBusy(existing.summary().status) || existing.summary().dialogs.length || this.admitting.has(id))) throw new Error('Stop the active conversation before reopening it.');
    if (!executable) return;
    let retirement: Promise<void> | null = null;
    if (!existing && this.runtimes.size >= 3) {
      const idle = [...this.runtimes.entries()].find(([key, runtime]) => {
        const state = runtime.summary();
        return key !== id && !isBusy(state.status) && state.status.kind !== 'connecting' && !state.dialogs.length && !this.opening.has(key) && !this.closing.has(key) && !this.admitting.has(key);
      });
      if (!idle) throw new Error('Three conversations are active. Stop one before opening another. No active work was interrupted.');
      const [idleID, runtime] = idle;
      this.providerConnectionRefreshes.delete(idleID);
      retirement = runtime.shutdown();
      this.retiring.set(idleID, retirement);
      this.runtimeRevisions.set(idleID, Math.max(this.runtimeRevisions.get(idleID) ?? 0, runtime.summary().revision));
      this.runtimes.delete(idleID);
      void retirement.finally(() => this.retiring.delete(idleID));
    }
    const record = this.requireThread(id);
    const runtime: ThreadRuntime = existing ?? new ThreadRuntime({ ...record }, event => {
      if (this.runtimes.get(id) !== runtime) return;
      const revision = event.kind === 'snapshot' || event.kind === 'summary' ? event.runtime.revision : event.revision;
      this.runtimeRevisions.set(id, Math.max(this.runtimeRevisions.get(id) ?? 0, revision));
      this.emit({ kind: 'runtime', event });
      if ((event.kind === 'snapshot' || event.kind === 'summary') && this.providerConnectionRefreshes.get(id) === runtime) void this.refreshRuntimeProviderConnections(id, runtime);
    }, (this.runtimeRevisions.get(id) ?? 0) + 1);
    if (!existing) runtime.client.on('idle', () => {
      if (this.runtimes.get(id) === runtime && this.providerConnectionRefreshes.get(id) === runtime) void this.refreshRuntimeProviderConnections(id, runtime);
    });
    this.runtimes.set(id, runtime);
    this.runtimeRevisions.set(id, Math.max(this.runtimeRevisions.get(id) ?? 0, runtime.summary().revision));
    runtime.onActivity = () => {
      const current = this.manifest.threads.find(thread => thread.id === id);
      if (!current || this.closing.has(id) || this.runtimes.get(id) !== runtime) return;
      const state = runtime.summary();
      current.wasRunning = isBusy(state.status);
      if (state.selectedModelID) current.lastModel = state.selectedModelID;
      current.updatedAt = new Date().toISOString();
      this.saveSoon(); this.notify();
      if (this.providerConnectionRefreshes.get(id) === runtime) void this.refreshRuntimeProviderConnections(id, runtime);
    };
    runtime.onEditorText = text => {
      if (this.runtimes.get(id) !== runtime || this.opening.get(id)?.reason === 'provider-connections') return;
      this.setDraft(id, text); this.notify();
    };
    runtime.onSessionName = name => {
      const current = this.manifest.threads.find(thread => thread.id === id);
      if (!current || this.stopping || this.closing.has(id) || this.runtimes.get(id) !== runtime || current.displayTitle === name) return;
      current.displayTitle = name;
      this.saveSoon(); this.notify();
    };
    runtime.onNativeTitleAttempt = sessionID => {
      const current = this.manifest.threads.find(thread => thread.id === id);
      if (!current || !this.writable || !this.loaded || this.stopping || this.closing.has(id) || this.runtimes.get(id) !== runtime || current.nativeTitleAttemptedFor === sessionID) return false;
      current.nativeTitleAttemptedFor = sessionID;
      this.saveSoon(); this.notify();
      return true;
    };
    const abort = new AbortController();
    const task = Promise.resolve().then(async () => {
      if (retirement) await retirement;
      if (reopen) await runtime.shutdown();
      if (abort.signal.aborted || this.stopping || this.closing.has(id)) return;
      Object.assign(runtime.record, this.requireThread(id));
      // Changes received while shutting down are covered by this fresh process.
      if (this.providerConnectionRefreshes.get(id) === runtime) this.providerConnectionRefreshes.delete(id);
      await runtime.connect(executable, reason);
    }).finally(() => {
      if (this.opening.get(id)?.abort !== abort) return;
      this.opening.delete(id);
      if (this.providerConnectionRefreshes.get(id) === runtime) void this.refreshRuntimeProviderConnections(id, runtime);
    });
    this.opening.set(id, { abort, task, reason });
    this.emit({ kind: 'runtime', event: { kind: 'snapshot', runtime: { ...runtime.snapshot(), status: { kind: 'connecting' } } } });
    await task;
  }
  setDraft(id: string, text: string): void {
    const thread = this.manifest.threads.find(item => item.id === id);
    if (!thread || this.closing.has(id) || !this.writable) return;
    thread.draft = text; this.saveSoon();
  }
  async prompt(id: string, message: string, steer: boolean, images: JsonRecord[]): Promise<boolean> {
    this.requireWritable();
    if (this.closing.has(id) || this.opening.has(id) || this.admitting.has(id)) return false;
    const thread = this.requireThread(id);
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.summary().status.kind !== 'ready') throw new Error('Open the conversation before sending a message.');
    this.admitting.add(id);
    const draftAtAdmission = thread.draft;
    try {
      const accepted = await runtime.sendPrompt(message, { steer, images });
      if (accepted && this.manifest.threads.includes(thread) && !this.closing.has(id)) {
        if (thread.draft === draftAtAdmission) thread.draft = '';
        if (thread.displayTitle === 'New thread' && runtime.sessionName === null) {
          const title = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().split('. ')[0] ?? '';
          thread.displayTitle = title ? [...title].slice(0, 64).join('') : 'Image attachment';
        }
        thread.updatedAt = new Date().toISOString(); this.saveSoon(); this.notify();
      }
      return accepted;
    } finally {
      this.admitting.delete(id);
      if (this.providerConnectionRefreshes.get(id) === runtime) void this.refreshRuntimeProviderConnections(id, runtime);
    }
  }
  async editMessage(id: string, messageID: string, message: string): Promise<boolean> {
    this.requireWritable();
    if (this.closing.has(id) || this.opening.has(id) || this.admitting.has(id)) throw new Error('Wait for the current message operation to finish.');
    const thread = this.requireThread(id), runtime = this.runtimes.get(id);
    if (!runtime || runtime.summary().status.kind !== 'ready') throw new Error('Open the conversation before editing a message.');
    this.admitting.add(id);
    try {
      const accepted = await runtime.editMessage(messageID, message);
      if (accepted && this.manifest.threads.includes(thread) && !this.closing.has(id)) {
        // Editing a sent turn must not consume the unrelated composer draft.
        thread.updatedAt = new Date().toISOString(); this.saveSoon(); this.notify();
      }
      return accepted;
    } finally {
      if (this.manifest.threads.includes(thread) && this.runtimes.get(id) === runtime && runtime.record.ompSessionFile) {
        thread.ompSessionFile = runtime.record.ompSessionFile; this.saveSoon();
      }
      this.admitting.delete(id);
      if (this.providerConnectionRefreshes.get(id) === runtime) void this.refreshRuntimeProviderConnections(id, runtime);
    }
  }
  async runtimeFor(id: string): Promise<ThreadRuntime> {
    this.requireThread(id);
    if (this.closing.has(id)) throw new Error('This conversation is being closed.');
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error('Open this conversation first.');
    return runtime;
  }
  renameThread(id: string, title: string): Promise<void> {
    this.requireWritable();
    const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ +/g, ' ').trim();
    if (!clean) throw new Error('Enter a thread title.');
    this.requireThread(id);
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.summary().status.kind !== 'ready' || this.opening.has(id) || this.closing.has(id)) throw new Error('Open the conversation before renaming it.');
    return runtime.setSessionName([...clean].slice(0, 120).join(''));
  }
  async deleteThread(id: string): Promise<void> {
    this.requireWritable();
    const record = this.requireThread(id);
    if (this.closing.has(id) || !(await this.host.confirmDelete(record))) return;
    this.closing.add(id);
    try {
      await this.closeRuntime(id);
      await this.persistence.deleteThreadStorage(id);
      this.manifest.threads = this.manifest.threads.filter(thread => thread.id !== id);
      if (this.manifest.selectedThreadID === id) this.manifest.selectedThreadID = null;
      this.saveSoon(); this.notify();
    } finally { this.closing.delete(id); }
  }
  private async closeRuntime(id: string): Promise<void> {
    this.providerConnectionRefreshes.delete(id);
    const opening = this.opening.get(id);
    opening?.abort.abort();
    const runtime = this.runtimes.get(id);
    if (runtime) await runtime.shutdown();
    if (opening) await opening.task;
    const retiring = this.retiring.get(id);
    if (retiring) await retiring;
    if (runtime) await runtime.shutdown();
    if (runtime && this.runtimes.get(id) === runtime) {
      this.runtimeRevisions.set(id, Math.max(this.runtimeRevisions.get(id) ?? 0, runtime.summary().revision));
      this.runtimes.delete(id);
    }
  }
  removeProject(id: string): void {
    this.requireWritable(); this.manifest.projects = this.manifest.projects.filter(project => project.id !== id); this.saveSoon(); this.notify();
  }
  async locateProject(path: string): Promise<void> {
    this.requireWritable();
    const chosen = await this.host.chooseDirectory('Locate project folder');
    if (!chosen) return;
    const canonical = await realpath(chosen);
    const affected = this.manifest.threads.filter(thread => thread.projectPath === path);
    if (affected.some(thread => this.closing.has(thread.id) || this.admitting.has(thread.id) || isBusy(this.runtimes.get(thread.id)?.summary().status ?? { kind: 'closed', reason: null }))) throw new Error('Stop active conversations before relocating this project.');
    for (const thread of affected) this.closing.add(thread.id);
    try {
      for (const thread of affected) await this.closeRuntime(thread.id);
      for (const project of this.manifest.projects) if (project.path === path) project.path = canonical;
      for (const thread of affected) thread.projectPath = canonical;
      this.saveSoon(); this.notify();
    } finally { for (const thread of affected) this.closing.delete(thread.id); }
    if (this.manifest.selectedThreadID) await this.selectThread(this.manifest.selectedThreadID);
  }
  setSidebar(visible: boolean): void {
    this.requireWritable(); this.manifest.sidebarVisible = visible; this.saveSoon(); this.notify();
  }
  setProjectExpanded(id: string, expanded: boolean): void {
    this.requireWritable();
    const project = this.manifest.projects.find(item => item.id === id);
    if (!project) throw new Error('This project is no longer in the sidebar.');
    project.expanded = expanded; this.saveSoon(); this.notify();
  }
  async updatePreferences(preferences: Preferences): Promise<void> {
    this.requireWritable();
    await this.persistence.savePreferences(preferences);
    this.preferences = { ...preferences }; this.notify();
  }
  async chooseExecutable(): Promise<void> {
    const path = await this.host.chooseExecutable();
    if (!path) return;
    this.preferences.executableOverride = path;
    await this.persistence.savePreferences(this.preferences);
    await this.testConnection();
    if (!this.stopping && this.executablePath && this.manifest.selectedThreadID) await this.selectThread(this.manifest.selectedThreadID, true);
  }
  async attachImages(id: string): Promise<ImageAttachment[]> {
    const runtime = await this.runtimeFor(id);
    const state = runtime.summary();
    if (!state.models.find(model => model.id === state.selectedModelID)?.supportsImages) throw new Error('The current model does not support images.');
    const paths = await this.host.chooseImages();
    if (paths.length > 20) throw new Error('Attach at most 20 images.');
    const result: ImageAttachment[] = [];
    let size = 0;
    for (const path of paths) {
      const info = await stat(path); size += info.size;
      if (!info.isFile()) throw new Error('Choose image files, not folders.');
      if (info.size > IMAGE_BYTE_LIMIT) throw new Error('Choose images up to 32 MiB each.');
      if (size > IMAGE_TOTAL_BYTE_LIMIT) throw new Error('Attach images totaling at most 64 MiB.');
      const extension = extname(path).toLowerCase();
      const mime = IMAGE_MIME_BY_EXTENSION[extension];
      if (!mime) throw new Error('Choose PNG, JPEG, GIF, or WebP images.');
      const bytes = await readFile(path);
      const frame = { type: 'image', mimeType: mime, data: bytes.toString('base64') };
      if (!isImageContent(frame)) throw new Error('Could not read the selected image.');
      result.push({ id: randomUUID(), name: path.split('/').pop() ?? path, byteCount: bytes.length, frame });
    }
    return result;
  }
  async terminal(id: string): Promise<void> {
    const thread = this.requireThread(id);
    if (this.closing.has(id) || !(await this.host.confirmTerminal(thread))) return;
    this.closing.add(id);
    try {
      await this.closeRuntime(id);
      const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resume = thread.ompSessionFile ? `--resume ${quote(thread.ompSessionFile)}` : '--continue';
      await this.host.terminal(`cd ${quote(thread.projectPath)} && ${quote(this.executablePath ?? 'omp')} --session-dir ${quote(thread.ompSessionDirectory)} ${resume}`);
      this.notify();
    } finally { this.closing.delete(id); }
  }
  async diagnostics(): Promise<void> {
    const directory = join(this.persistence.root, 'Logs'); await mkdir(directory, { recursive: true });
    const report = [...this.runtimes.entries()].map(([id, runtime]) => `Thread ${id}\n${runtime.client.diagnostics()}`).join('\n\n') || 'No live OMP stderr diagnostics recorded.\n';
    await writeFile(join(directory, 'last-diagnostics.txt'), report, { mode: 0o600 }); await this.host.reveal(this.persistence.root);
  }
  saveSoon(): void {
    if (!this.loaded || !this.writable || this.stopping) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const manifest = structuredClone(this.manifest);
      this.saveChain = this.saveChain.then(() => this.persistence.save(manifest)).catch(error => { this.error = `Could not save thread metadata: ${error instanceof Error ? error.message : String(error)}`; this.notify(); });
    }, 250);
  }
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.providerConnectionRefreshes.clear();
    clearTimeout(this.saveTimer);
    for (const opening of this.opening.values()) opening.abort.abort();
    await Promise.all([
      ...[...this.runtimes.values()].map(runtime => runtime.shutdown()),
      ...[...this.connectionTests.keys()].map(client => client.shutdown()),
    ]);
    await Promise.all([...this.opening.values()].map(opening => opening.task));
    await Promise.all(this.connectionTests.values());
    if (this.providerConnectionRefreshTask) await this.providerConnectionRefreshTask;
    await Promise.all(this.retiring.values());
    await this.saveChain;
    if (this.loaded && this.writable) {
      for (const thread of this.manifest.threads) thread.wasRunning = false;
      await this.persistence.save(this.manifest);
    }
  }
}
