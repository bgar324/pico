import { randomUUID } from 'node:crypto';
import type { ChatMessage, DialogRequest, Json, JsonRecord, ModelChoice, RuntimeEvent, RuntimeSnapshot, RuntimeSummary, ThreadRecord, WorkPeriod } from '../shared/types';
import { isBusy, isReady } from '../shared/types';
import { RpcClient } from './RpcClient';
import { isRecord, RpcError } from './frames';
import { MessageStore } from './MessageStore';
import { dialogResponse, parseDialog } from './dialogs';
import { sanitizeDiagnostic } from './diagnostics';
import { committedTodoPhases, parseTodoPhases } from '../shared/todos';
import { isImageContent } from '../shared/validation';

interface LiveDialog { request: DialogRequest; token: string; timer: NodeJS.Timeout | undefined; submission: AbortController | null }
interface StateRead { state: JsonRecord; generation: number; lifecycle: number; config: number; thinking: number; usage: number; title: number }

export class ThreadRuntime {
  readonly recordID: string;
  readonly client = new RpcClient();
  onActivity: (() => void) | null = null;
  onToolEnd: (() => void) | null = null;
  onEditorText: ((text: string) => void) | null = null;
  onSessionName: ((name: string) => void) | null = null;
  onNativeTitleAttempt: ((sessionID: string) => boolean) | null = null;
  private readonly state: RuntimeSummary;
  private readonly store: MessageStore;
  private readonly dialogs = new Map<string, LiveDialog>();
  private readonly subagentParents = new Map<string, string>();
  private readonly pendingPrompts = new Set<string>();
  private optimisticPrompt: { id: string; message: ChatMessage } | null = null;
  private readonly workPeriods: WorkPeriod[] = [];
  private unanchoredUserMessageID: string | null = null;
  private advisorContinuationID: string | null = null;
  private generation = 0;
  private lifecycleEpoch = 0;
  private configEpoch = 0;
  private thinkingRevision = 0;
  private titleRevision = 0;
  private sessionID: string | null = null;
  private nativeSessionName: string | null = null;
  private naming: { name: string } | null = null;
  private titleCommandOutput: string | null = null;
  private nativeTitleRequest: { sessionID: string } | null = null;
  private modelRefresh: AbortController | null = null;
  private stateRead: Promise<StateRead> | null = null;
  private contextRefresh: Promise<void> | null = null;
  private contextUsageEpoch = 0;
  private activity: 'idle' | 'running' | 'background' | 'stopping' = 'idle';
  private historyBuffer: JsonRecord[] | null = null;
  private historyBoundarySeen = false;

  constructor(readonly record: ThreadRecord, private readonly emit: (event: RuntimeEvent) => void, initialRevision = 0) {
    this.recordID = record.id;
    this.state = { id: record.id, revision: initialRevision, status: { kind: 'closed', reason: null }, error: null, notice: null, models: [], selectedModelID: '', thinkingLevels: [], thinkingLevel: '', contextUsage: null, dialogs: [], subagents: [], todoPhases: [], queuedFollowUps: [], queuedSteers: [], workPeriods: this.workPeriods };
    this.store = new MessageStore(message => this.emit({ kind: 'message', threadID: this.recordID, revision: ++this.state.revision, message: { ...message, toolIDs: [...message.toolIDs], ...(message.images ? { images: message.images.map(image => ({ ...image })) } : {}), ...(message.details ? { details: structuredClone(message.details) } : {}) } }), tool => this.emit({ kind: 'tool', threadID: this.recordID, revision: ++this.state.revision, tool: { ...tool } }));
    this.client.on('event', frame => {
      if (this.historyBuffer && (frame.type === 'message_start' || frame.type === 'message_update' || frame.type === 'message_end' || (typeof frame.type === 'string' && frame.type.startsWith('tool_')))) {
        this.historyBuffer.push(frame);
      } else this.consume(frame);
    });
  }
  snapshot(): RuntimeSnapshot {
    return { ...this.summary(), messages: [...this.store.messages.values(), ...(this.optimisticPrompt ? [this.optimisticPrompt.message] : [])].map(message => ({ ...message, toolIDs: [...message.toolIDs], ...(message.images ? { images: message.images.map(image => ({ ...image })) } : {}), ...(message.details ? { details: structuredClone(message.details) } : {}) })), tools: [...this.store.tools.values()].map(tool => ({ ...tool })) };
  }
  summary(): RuntimeSummary { return structuredClone(this.state); }
  get sessionName(): string | null { return this.nativeSessionName; }

  async connect(executable: string): Promise<void> {
    if (isReady(this.state.status) || this.state.status.kind === 'connecting') return;
    const generation = ++this.generation;
    this.lifecycleEpoch++; this.configEpoch++; this.contextUsageEpoch++;
    this.titleRevision++; this.sessionID = null; this.nativeSessionName = null; this.naming = null;
    this.workPeriods.length = 0;
    this.optimisticPrompt = null;
    this.unanchoredUserMessageID = null;
    this.advisorContinuationID = null;
    this.state.status = { kind: 'connecting' }; this.state.error = null; this.state.contextUsage = null;
    this.state.notice = this.record.wasRunning ? 'The previous process was interrupted. Saved history is restored; no action will be replayed.' : null;
    this.historyBuffer = []; this.historyBoundarySeen = false; this.changed();
    try {
      await this.client.start({ executable, projectPath: this.record.projectPath, sessionDirectory: this.record.ompSessionDirectory, resume: true });
      if (generation !== this.generation) return;
      const catalogEpoch = this.configEpoch;
      const catalog = await this.client.request('get_available_models', {}, { timeout: 60000 });
      if (generation !== this.generation) return;
      if (!isRecord(catalog) || !Array.isArray(catalog.models)) throw new RpcError('protocol', 'OMP returned an invalid model catalog.');
      if (catalogEpoch === this.configEpoch) this.state.models = catalog.models.flatMap(value => { const model = ThreadRuntime.modelChoice(value); return model ? [model] : []; });
      const levelsEpoch = this.configEpoch;
      const levels = await this.client.request('get_available_thinking_levels');
      if (generation !== this.generation) return;
      if (levelsEpoch === this.configEpoch && isRecord(levels) && Array.isArray(levels.levels)) this.state.thinkingLevels = levels.levels.filter((value): value is string => typeof value === 'string');
      // Unsupported presentation optimizations must not prevent older engines from connecting.
      await this.client.request('set_event_filter', { events: null, messageUpdates: 'delta' }).catch(() => null);
      if (generation !== this.generation) return;
      await this.client.request('set_ask_dialog', { enabled: true }).catch(() => null);
      if (generation !== this.generation) return;
      const subscription = await this.client.request('set_subagent_subscription', { level: 'progress' }).catch(() => null);
      if (generation !== this.generation) return;
      if (isRecord(subscription) && subscription.level === 'progress') {
        const agents = await this.client.request('get_subagents').catch(() => null);
        if (generation !== this.generation) return;
        if (isRecord(agents) && Array.isArray(agents.subagents)) for (const agent of agents.subagents) this.reduceSubagent(agent);
      }
      const history = await this.loadHistory();
      if (generation !== this.generation) return;
      this.store.restore(history);
      this.resolveSubagentAnchors();
      const buffered = this.historyBuffer ?? []; this.historyBuffer = null;
      for (const frame of buffered) this.consume(frame);
      if (!history.length && (this.record.displayTitle !== 'New thread' || this.record.wasRunning)) this.state.notice = "Saved session missing or empty. OMP started an empty session in this thread's dedicated directory. No previous action was replayed.";
      // History hydration can change state; read authoritative defaults and usage only after it completes.
      await this.refreshState();
      if (generation !== this.generation) return;
      if (!this.state.models.length) this.state.notice = 'No models are available. Configure provider credentials with omp in Terminal, then reopen this thread.';
      this.state.status = { kind: 'ready', activity: this.activity };
      this.state.revision++; this.emit({ kind: 'snapshot', runtime: this.snapshot() });
      this.maybeGenerateNativeTitle();
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP failed to connect.');
      this.state.status = { kind: 'closed', reason: this.state.error };
      this.historyBuffer = null;
      await this.client.shutdown();
      if (generation !== this.generation) return;
      this.interrupt(); this.changed();
    }
  }

  private async loadHistory(): Promise<Json[]> {
    let history: Json[] = [], cursor: string | null = null, total: number | null = null;
    const seen = new Set<string>();
    try {
      do {
        const fields: JsonRecord = { limit: 100 };
        if (cursor !== null) fields.cursor = cursor;
        const page = await this.client.request('get_messages_page', fields, { timeout: 60000 });
        if (!isRecord(page) || !Array.isArray(page.messages) || typeof page.totalMessages !== 'number' || !Number.isSafeInteger(page.totalMessages) || page.totalMessages < 0 || (total !== null && total !== page.totalMessages)) throw new RpcError('protocol', 'OMP returned an invalid history page.');
        total = page.totalMessages;
        history.push(...page.messages);
        if (history.length > total) throw new RpcError('protocol', 'History page exceeded its declared message count.');
        if (page.nextCursor !== undefined && page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new RpcError('protocol', 'OMP returned an invalid history cursor.');
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
        if (cursor !== null) {
          if (!page.messages.length || !cursor || seen.has(cursor)) throw new RpcError('protocol', 'OMP returned a repeated or empty history cursor.');
          seen.add(cursor);
        }
      } while (cursor !== null);
      if (history.length !== total) throw new RpcError('protocol', 'OMP history pagination ended prematurely.');
      return history;
    } catch (error) {
      if (!(error instanceof RpcError) || error.kind !== 'command' || !(error.code === 'session_busy' || error.code === 'stale_cursor' || /unknown command/i.test(error.message))) throw error;
      const legacy = await this.client.request('get_messages', {}, { timeout: 60000 });
      if (!isRecord(legacy) || !Array.isArray(legacy.messages)) throw new RpcError('protocol', 'OMP returned an invalid history snapshot.');
      return legacy.messages;
    }
  }

  async sendPrompt(message: string, options: { steer?: boolean; images?: JsonRecord[] } = {}): Promise<boolean> {
    if (!isReady(this.state.status) || (!message.trim() && !options.images?.length)) return false;
    const generation = this.generation, id = randomUUID(), busy = isBusy(this.state.status);
    this.lifecycleEpoch++; this.pendingPrompts.add(id); this.activity = 'running';
    this.unanchoredUserMessageID = null;
    if (!busy) this.advisorContinuationID = null;
    if (!busy) {
      const messageID = `pending-${id}`;
      this.optimisticPrompt = { id, message: { id: messageID, role: 'user', text: message, thinking: '', error: null, isStreaming: false, toolIDs: [], ...(options.images ? { images: options.images.filter(isImageContent) } : {}) } };
      this.unanchoredUserMessageID = messageID;
    }
    this.beginWork();
    this.state.status = { kind: 'ready', activity: this.activity }; this.state.error = null;
    if (!busy) this.messagesChanged(); else this.changed();
    const fields: JsonRecord = { message };
    if (options.images?.length) fields.images = options.images;
    if (busy) fields.streamingBehavior = options.steer ? 'steer' : 'followUp';
    try {
      const result = await this.client.request('prompt', fields, { id, timeout: 60000 });
      if (generation !== this.generation) return false;
      if (isRecord(result) && result.agentInvoked === false) { this.discardOptimisticPrompt(id); this.pendingPrompts.delete(id); this.lifecycleEpoch++; await this.refreshState(); }
      if (generation !== this.generation) return false;
      this.onActivity?.(); this.changed(); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      if (!(error instanceof RpcError && error.kind === 'timeout')) { this.discardOptimisticPrompt(id); this.pendingPrompts.delete(id); this.lifecycleEpoch++; }
      this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP rejected the prompt.');
      const state = await this.refreshState(5000).catch(() => null);
      if (generation !== this.generation) return false;
      if (state?.isSettled === true) { this.discardOptimisticPrompt(id); this.pendingPrompts.delete(id); this.applyActivity(state); }
      this.changed(); return false;
    }
  }
  async stop(): Promise<void> {
    if (!isReady(this.state.status) || !isBusy(this.state.status)) return;
    const generation = this.generation;
    this.activity = 'stopping'; this.state.status = { kind: 'ready', activity: 'stopping' };
    this.state.notice = 'Stopping. Waiting for OMP to settle its work.'; this.changed();
    try { await this.client.request('abort'); if (generation !== this.generation) return; await this.refreshState(); }
    catch (error) { if (generation === this.generation) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not stop.'); }
    if (generation === this.generation) this.changed();
  }
  async promoteQueued(message: string): Promise<boolean> {
    if (!isReady(this.state.status) || !this.state.queuedFollowUps.includes(message)) return false;
    const generation = this.generation;
    const result = await this.client.request('promote_queued_message', { message });
    if (generation !== this.generation) return false;
    if (!isRecord(result) || typeof result.promoted !== 'boolean') throw new RpcError('protocol', 'OMP returned an invalid queue promotion result.');
    await this.refreshState();
    return result.promoted;
  }
  async selectModel(id: string): Promise<void> {
    const model = this.state.models.find(choice => choice.id === id);
    if (!isReady(this.state.status) || !model) return;
    const generation = this.generation;
    this.modelRefresh?.abort(); const epoch = ++this.configEpoch; this.contextUsageEpoch++;
    try {
      await this.client.request('set_model', { provider: model.provider, modelId: model.modelID }, { timeout: 60000 });
      if (generation !== this.generation) return;
      // set_model may emit model_changed; refresh against its newer configuration epoch.
      await this.refreshModelConfiguration();
      if (generation !== this.generation) return;
      this.state.error = null; this.onActivity?.();
    } catch (error) { if (generation === this.generation && epoch <= this.configEpoch) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not select the model.'); }
    if (generation === this.generation) this.changed();
  }
  async selectThinking(level: string): Promise<void> {
    // RPC accepts inherit as a reset even though capability discovery omits it.
    if (!isReady(this.state.status) || (level !== 'inherit' && !this.state.thinkingLevels.includes(level))) return;
    const generation = this.generation;
    try { await this.client.request('set_thinking_level', { level }); if (generation !== this.generation) return; await this.refreshState(); this.state.error = null; }
    catch (error) { if (generation === this.generation) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not select thinking effort.'); }
    if (generation === this.generation) this.changed();
  }
  async setSessionName(name: string): Promise<void> {
    if (!isReady(this.state.status)) throw new Error('Open the conversation before renaming it.');
    if (this.naming) throw new Error('Wait for OMP to finish the current rename.');
    const generation = this.generation, naming = { name };
    this.naming = naming; this.titleRevision++;
    try {
      await this.client.request('set_session_name', { name });
      if (generation !== this.generation || !isReady(this.state.status)) throw new RpcError('cancelled', 'The conversation closed before OMP confirmed the rename. Reopen it to read its saved name.');
      this.titleRevision++;
      this.nativeTitleRequest = null;
      this.applySessionName(naming.name);
      this.state.error = null; this.changed();
    } catch (error) {
      if (generation === this.generation) { this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not rename the conversation.'); this.changed(); }
      throw error;
    } finally { if (this.naming === naming) this.naming = null; }
  }
  async refreshState(timeout = 30000): Promise<JsonRecord | null> {
    const generation = this.generation, lifecycle = this.lifecycleEpoch, config = this.configEpoch, thinking = this.thinkingRevision, usage = this.contextUsageEpoch;
    let read: StateRead;
    do {
      read = await this.readState(timeout);
      if (generation !== this.generation) return null;
    } while (read.config < config || read.lifecycle < lifecycle || read.thinking < thinking || read.usage < usage);
    if (config === this.configEpoch && read.config === this.configEpoch) this.applyConfiguration(read.state, thinking === this.thinkingRevision && read.thinking === this.thinkingRevision);
    this.applyContextUsage(read);
    this.applyTodos(read);
    this.applySessionInfo(read);
    if (lifecycle !== this.lifecycleEpoch || read.lifecycle !== this.lifecycleEpoch) return null;
    this.applyActivity(read.state);
    return read.state;
  }
  private readState(timeout = 30000): Promise<StateRead> {
    if (this.stateRead) return this.stateRead;
    const generation = this.generation, lifecycle = this.lifecycleEpoch, config = this.configEpoch, thinking = this.thinkingRevision, usage = this.contextUsageEpoch, title = this.titleRevision;
    const pending = this.client.request('get_state', {}, { timeout }).then(state => {
      if (!isRecord(state)) throw new RpcError('protocol', 'OMP returned an invalid state.');
      return { state, generation, lifecycle, config, thinking, usage, title };
    }).finally(() => { if (this.stateRead === pending) this.stateRead = null; });
    this.stateRead = pending;
    return pending;
  }
  private applySessionInfo(read: StateRead): void {
    if (read.generation !== this.generation || read.title !== this.titleRevision || this.naming || this.state.status.kind === 'closed') return;
    if (typeof read.state.sessionId === 'string' && read.state.sessionId) this.sessionID = read.state.sessionId;
    this.applySessionName(read.state.sessionName);
  }
  private applySessionName(value: Json | undefined): void {
    if (typeof value !== 'string' || !value.trim() || value === this.nativeSessionName) return;
    this.nativeSessionName = value;
    this.onSessionName?.(value);
  }
  private maybeGenerateNativeTitle(): void {
    const sessionID = this.sessionID, generation = this.generation;
    if (!sessionID || !isReady(this.state.status) || !this.state.models.length || this.nativeSessionName || this.naming || this.record.nativeTitleAttemptedFor === sessionID || !this.onNativeTitleAttempt) return;
    const messages = [...this.store.messages.values()];
    if (!messages.some(message => message.role === 'user') || !messages.some(message => message.role === 'assistant' && !message.isStreaming && !message.error && message.text.trim())) return;
    if (!this.onNativeTitleAttempt(sessionID)) return;
    this.record.nativeTitleAttemptedFor = sessionID;
    const request = { sessionID }; this.nativeTitleRequest = request;
    const current = (): boolean => this.nativeTitleRequest === request && generation === this.generation && sessionID === this.sessionID && isReady(this.state.status);
    void (async () => {
      const available = await this.client.request('get_available_commands');
      if (!current()) return;
      if (this.nativeSessionName || this.naming) { this.nativeTitleRequest = null; return; }
      if (!isRecord(available) || !Array.isArray(available.commands) || !available.commands.some(command => isRecord(command) && command.name === 'rename' && command.source === 'builtin')) {
        throw new Error('This OMP process does not expose its native /rename generator.');
      }
      const result = await this.client.request('prompt', { message: '/rename' }, { timeout: 60000 });
      if (current() && (!isRecord(result) || result.agentInvoked !== false)) throw new Error('OMP did not handle /rename as a native command.');
    })().catch(error => {
      if (!current()) return;
      this.nativeTitleRequest = null;
      if (this.nativeSessionName) return;
      this.state.notice = sanitizeDiagnostic(`OMP could not generate a chat title: ${error instanceof Error ? error.message : String(error)} The provisional title was kept.`);
      this.changed();
    });
  }
  private applyContextUsage(read: StateRead): boolean {
    if (read.generation !== this.generation || read.config !== this.configEpoch || read.usage !== this.contextUsageEpoch || this.state.status.kind === 'closed') return false;
    // OMP 18.6 get_state.contextUsage describes the current context, not session totals.
    const value = read.state.contextUsage;
    const usage = isRecord(value) && typeof value.tokens === 'number' && Number.isFinite(value.tokens) && value.tokens >= 0 && typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow) && value.contextWindow > 0 ? { tokens: value.tokens, contextWindow: value.contextWindow } : null;
    if (usage?.tokens === this.state.contextUsage?.tokens && usage?.contextWindow === this.state.contextUsage?.contextWindow) return false;
    this.state.contextUsage = usage;
    return true;
  }
  private applyTodos(read: StateRead): boolean {
    // A tool boundary invalidates in-flight reads before they can replace a newer result.
    if (read.generation !== this.generation || read.usage !== this.contextUsageEpoch || this.state.status.kind === 'closed') return false;
    const phases = parseTodoPhases(read.state.todoPhases);
    if (phases === null || JSON.stringify(phases) === JSON.stringify(this.state.todoPhases)) return false;
    this.state.todoPhases = phases;
    return true;
  }
  private applyQueueState(read: StateRead): boolean {
    if (read.generation !== this.generation || read.lifecycle !== this.lifecycleEpoch || this.state.status.kind === 'closed' || !isRecord(read.state.queuedMessages)) return false;
    return this.applyQueues(read.state.queuedMessages);
  }
  private refreshContextUsage(): void {
    this.contextUsageEpoch++;
    if (this.contextRefresh || !this.client.ready || this.state.status.kind === 'closed') return;
    const generation = this.generation;
    const refresh = async (): Promise<void> => {
      for (;;) {
        const read = await this.readState();
        if (generation !== this.generation || this.state.status.kind === 'closed') return;
        const usageChanged = this.applyContextUsage(read), todosChanged = this.applyTodos(read), queuesChanged = this.applyQueueState(read);
        this.applySessionInfo(read);
        if (usageChanged || todosChanged || queuesChanged) this.changed();
        // Boundaries arriving during a read need one trailing read, never parallel polls.
        if (read.usage === this.contextUsageEpoch && read.config === this.configEpoch && read.lifecycle === this.lifecycleEpoch) return;
      }
    };
    const pending = refresh().catch(() => {
      if (generation === this.generation && this.state.contextUsage !== null) { this.state.contextUsage = null; this.changed(); }
    }).finally(() => { if (this.contextRefresh === pending) this.contextRefresh = null; });
    this.contextRefresh = pending;
  }
  private async refreshModelConfiguration(): Promise<void> {
    this.modelRefresh?.abort();
    const controller = new AbortController(); this.modelRefresh = controller;
    const generation = this.generation, epoch = ++this.configEpoch, thinking = this.thinkingRevision;
    this.contextUsageEpoch++;
    if (this.state.contextUsage !== null) { this.state.contextUsage = null; this.changed(); }
    try {
      let read: StateRead;
      do {
        read = await this.readState();
        if (controller.signal.aborted || generation !== this.generation || epoch !== this.configEpoch) return;
      } while (read.config !== epoch);
      const levels = await this.client.request('get_available_thinking_levels', {}, { signal: controller.signal });
      const catalog = await this.client.request('get_available_models', {}, { timeout: 60000, signal: controller.signal });
      if (controller.signal.aborted || generation !== this.generation || epoch !== this.configEpoch) return;
      if (!isRecord(levels) || !Array.isArray(levels.levels) || !isRecord(catalog) || !Array.isArray(catalog.models)) throw new RpcError('protocol', 'OMP returned invalid model configuration.');
      this.state.models = catalog.models.flatMap(value => { const model = ThreadRuntime.modelChoice(value); return model ? [model] : []; });
      this.applyConfiguration(read.state, thinking === this.thinkingRevision);
      this.applyContextUsage(read);
      this.applyTodos(read);
      this.applySessionInfo(read);
      this.state.thinkingLevels = levels.levels.filter((value): value is string => typeof value === 'string');
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation && epoch === this.configEpoch) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not refresh model configuration.');
    } finally { if (this.modelRefresh === controller) this.modelRefresh = null; }
    if (!controller.signal.aborted && generation === this.generation && epoch === this.configEpoch) this.changed();
  }
  private applyConfiguration(state: JsonRecord, updateThinking: boolean): void {
    const model = ThreadRuntime.modelChoice(state.model);
    if (model) {
      this.state.selectedModelID = model.id;
      const index = this.state.models.findIndex(choice => choice.id === model.id);
      if (index >= 0) {
        if (isRecord(state.model) && state.model.input === undefined) model.supportsImages = this.state.models[index]?.supportsImages ?? false;
        this.state.models[index] = model;
      } else this.state.models.push(model);
    }
    if (updateThinking) {
      if (typeof state.thinkingLevel === 'string') this.state.thinkingLevel = state.thinkingLevel;
      // get_state omits the undefined effort produced by inherit.
      else if (state.thinkingLevel === undefined) this.state.thinkingLevel = 'inherit';
    }
  }
  private applyActivity(state: JsonRecord): void {
    const running = state.isStreaming === true || state.isCompacting === true;
    const settled = !running && !this.pendingPrompts.size && state.hasPendingAsyncWork !== true && state.isSettled !== false;
    if (settled) this.settle();
    else {
      this.beginWork();
      this.activity = state.hasPendingAsyncWork === true && !running ? 'background' : this.activity === 'stopping' ? 'stopping' : 'running';
      if (isReady(this.state.status)) this.state.status = { kind: 'ready', activity: this.activity };
    }
    if (isRecord(state.queuedMessages)) this.applyQueues(state.queuedMessages);
  }
  private static modelChoice(value: Json | undefined): ModelChoice | null {
    if (!isRecord(value) || typeof value.provider !== 'string' || !value.provider || typeof value.id !== 'string' || !value.id) return null;
    return { id: `${value.provider}/${value.id}`, provider: value.provider, modelID: value.id, name: typeof value.name === 'string' ? value.name : value.id, supportsImages: Array.isArray(value.input) && value.input.includes('image') };
  }

  consume(frame: JsonRecord): void {
    switch (frame.type) {
      case 'message_start':
      case 'message_end': {
        const confirmed = this.confirmOptimisticPrompt(frame);
        this.anchorWork(frame);
        if (isRecord(frame.message) && frame.message.role === 'custom' && frame.message.customType === 'advisor') {
          const previous = this.workPeriods.at(-1);
          if (previous?.endedAt !== null && previous?.messageID) this.advisorContinuationID = previous.id;
        }
        this.store.consume(frame);
        if (confirmed) this.messagesChanged();
        if (frame.type === 'message_start') return;
        if (this.resolveSubagentAnchors()) this.changed();
        if (isRecord(frame.message) && frame.message.role === 'toolResult' && frame.message.toolName === 'todo') {
          const phases = committedTodoPhases(frame.message);
          if (phases !== null) { this.state.todoPhases = phases; this.changed(); }
          this.refreshContextUsage();
        }
        if (isRecord(frame.message) && frame.message.role === 'assistant') this.refreshContextUsage();
        if (isRecord(frame.message) && frame.message.role === 'user') { this.lifecycleEpoch++; this.refreshContextUsage(); }
        return;
      }
      case 'message_update': this.store.consume(frame); return;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_stream_update': case 'tool_execution_end':
        this.store.consume(frame); this.onActivity?.();
        if (frame.type === 'tool_execution_end') {
          if (frame.toolName === 'todo' && frame.isError !== true) {
            const phases = committedTodoPhases(frame.result);
            if (phases !== null) { this.state.todoPhases = phases; this.changed(); }
          }
          // Eval can commit todos without a todo tool event. Read canonical state after every tool boundary.
          this.refreshContextUsage(); this.onToolEnd?.();
        }
        return;
      case 'agent_start': this.lifecycleEpoch++; this.beginWork(); this.activity = 'running'; if (isReady(this.state.status)) this.state.status = { kind: 'ready', activity: this.activity }; this.onActivity?.(); break;
      case 'agent_end': if (frame.awaitingAsyncWork === true) { this.beginWork(); this.activity = 'background'; if (isReady(this.state.status)) this.state.status = { kind: 'ready', activity: 'background' }; this.state.notice = 'Turn finished. Background work is still running.'; } this.refreshContextUsage(); break;
      case 'prompt_result': {
        if (typeof frame.id !== 'string' || !this.pendingPrompts.delete(frame.id)) return;
        this.lifecycleEpoch++;
        if (frame.status === 'error') this.state.error = sanitizeDiagnostic(isRecord(frame.error) && typeof frame.error.message === 'string' ? frame.error.message : 'The model request failed. Check provider credentials in Terminal.');
        if (frame.status === 'aborted') this.state.notice = 'The prompt was interrupted.';
        if (frame.sessionSettled === true && !this.pendingPrompts.size) this.settle();
        else if (this.activity !== 'background' && this.activity !== 'stopping') { this.activity = 'running'; if (isReady(this.state.status)) this.state.status = { kind: 'ready', activity: 'running' }; }
        this.refreshContextUsage();
        if (frame.status === 'completed') this.maybeGenerateNativeTitle();
        break;
      }
      case 'session_settled': this.lifecycleEpoch++; if (!this.pendingPrompts.size) this.settle(); this.refreshContextUsage(); break;
      case 'turn_end': case 'auto_compaction_end': this.refreshContextUsage(); return;
      case 'queue_update': this.lifecycleEpoch++; this.applyQueues(frame); break;
      case 'response': {
        if (this.historyBuffer && frame.success === true && (frame.command === 'get_messages' || (frame.command === 'get_messages_page' && !this.historyBoundarySeen))) { this.historyBuffer = []; this.historyBoundarySeen = true; }
        if (frame.success === true && frame.command === 'set_todos' && isRecord(frame.data)) {
          const phases = parseTodoPhases(frame.data.todoPhases);
          if (phases !== null) { this.contextUsageEpoch++; this.state.todoPhases = phases; this.changed(); }
          return;
        }
        if (frame.command === 'get_messages' || frame.command === 'get_messages_page') return;
        if (frame.success === true && frame.command === 'compact') { this.refreshContextUsage(); return; }
        if (frame.success === false) this.state.error = sanitizeDiagnostic(typeof frame.error === 'string' ? frame.error : 'OMP rejected a command.');
        if (typeof frame.id === 'string' && (frame.command === 'prompt' || frame.command === 'abort_and_prompt') && (frame.success === false || (isRecord(frame.data) && frame.data.agentInvoked === false)) && this.pendingPrompts.delete(frame.id)) { this.discardOptimisticPrompt(frame.id); this.lifecycleEpoch++; void this.refreshState().then(() => this.changed()).catch(() => this.changed()); }
        else return;
        break;
      }
      case 'transport_error': this.lifecycleEpoch++; this.state.error = sanitizeDiagnostic(typeof frame.error === 'string' ? frame.error : 'OMP disconnected. Reopen the thread.'); this.state.status = { kind: 'closed', reason: this.state.error }; this.interrupt(); break;
      case 'model_changed': void this.refreshModelConfiguration(); return;
      case 'thinking_level_changed': this.thinkingRevision++; if (typeof frame.level === 'string') this.state.thinkingLevel = frame.level; else if (typeof frame.thinkingLevel === 'string') this.state.thinkingLevel = frame.thinkingLevel; break;
      case 'session_info_update':
        if (this.state.status.kind === 'closed' || typeof frame.sessionId !== 'string' || !frame.sessionId || typeof frame.title !== 'string' || !frame.title.trim() || (this.sessionID !== null && frame.sessionId !== this.sessionID)) return;
        this.sessionID = frame.sessionId; this.titleRevision++;
        if (this.nativeTitleRequest?.sessionID === frame.sessionId) this.titleCommandOutput = `Session renamed to ${frame.title}.`;
        if (!this.naming) this.applySessionName(frame.title);
        return;
      case 'notice': case 'extension_error': {
        const text = sanitizeDiagnostic(typeof frame.message === 'string' ? frame.message : typeof frame.error === 'string' ? frame.error : 'OMP reported a problem.');
        if (frame.level === 'error' || frame.type === 'extension_error') this.state.error = text; else this.state.notice = text; break;
      }
      case 'extension_ui_request': this.reduceDialog(frame); break;
      case 'subagent_lifecycle': case 'subagent_progress': this.reduceSubagent(frame.payload); break;
      case 'command_output': {
        const text = typeof frame.text === 'string' ? frame.text : typeof frame.output === 'string' ? frame.output : '';
        if (text && text === this.titleCommandOutput) { this.titleCommandOutput = null; this.nativeTitleRequest = null; return; }
        if (this.nativeTitleRequest && (text.startsWith('Rename failed: ') || text === 'Could not generate a session title. Use /rename <title> to set one.' || text === 'Session name not changed (a user-set name takes precedence).')) {
          this.nativeTitleRequest = null;
          if (!this.nativeSessionName && this.state.status.kind !== 'closed') { this.state.notice = sanitizeDiagnostic(`OMP title generation: ${text}`); this.changed(); }
          return;
        }
        if (text) this.store.consume({ type: 'message_end', messageId: `command-${randomUUID()}`, message: { role: 'assistant', content: sanitizeDiagnostic(text, 65536) } });
        return;
      }
      case 'host_tool_call': case 'host_uri_request': this.failClosed('OMP requested an unsupported host interaction. Continue this session in Terminal.'); break;
      default: return;
    }
    this.changed();
  }
  private confirmOptimisticPrompt(frame: JsonRecord): boolean {
    const pending = this.optimisticPrompt;
    if (!pending || !isRecord(frame.message) || frame.message.role !== 'user' || typeof frame.messageId !== 'string' || !frame.messageId || this.store.messages.has(frame.messageId)) return false;
    // The next native user delivery owns the idle submission, even when a hook edits its content.
    this.optimisticPrompt = null;
    for (const period of this.workPeriods) if (period.messageID === pending.message.id) period.messageID = frame.messageId;
    return true;
  }
  private discardOptimisticPrompt(id: string): void {
    const pending = this.optimisticPrompt;
    if (pending?.id !== id) return;
    this.optimisticPrompt = null;
    for (const period of this.workPeriods) if (period.messageID === pending.message.id) period.messageID = null;
    this.messagesChanged();
  }
  private messagesChanged(): void { this.state.revision++; this.emit({ kind: 'snapshot', runtime: this.snapshot() }); }

  private beginWork(): void {
    if (this.state.status.kind === 'closed') return;
    const previous = this.workPeriods.at(-1);
    if (previous?.endedAt === null) return;
    if (previous && previous.id === this.advisorContinuationID && this.unanchoredUserMessageID === null) {
      previous.endedAt = null;
      this.advisorContinuationID = null;
      return;
    }
    this.advisorContinuationID = null;
    // Wall-clock adjustments must not reorder observed rounds.
    this.workPeriods.push({ id: randomUUID(), startedAt: Math.max(Date.now(), previous?.endedAt ?? 0), endedAt: null, messageID: this.unanchoredUserMessageID });
    this.unanchoredUserMessageID = null;
    if (this.workPeriods.length > 32) this.workPeriods.splice(0, this.workPeriods.length - 32);
  }
  private anchorWork(frame: JsonRecord): void {
    if (this.state.status.kind === 'closed' || !isRecord(frame.message) || frame.message.role !== 'user' || typeof frame.messageId !== 'string' || !frame.messageId || this.store.messages.get(frame.messageId)?.role === 'user') return;
    this.advisorContinuationID = null;
    const period = this.workPeriods.at(-1);
    if (!period || period.endedAt !== null) {
      // Native user delivery can precede agent_start; its ID, never its timestamp, is retained.
      this.unanchoredUserMessageID ??= frame.messageId;
    } else if (period.messageID === null) {
      period.messageID = frame.messageId;
      this.changed();
    }
  }
  private finishWork(): void {
    this.unanchoredUserMessageID = null;
    const period = this.workPeriods.at(-1);
    if (period?.endedAt === null) period.endedAt = Math.max(period.startedAt, Date.now());
  }
  private settle(): void {
    if (this.optimisticPrompt) this.discardOptimisticPrompt(this.optimisticPrompt.id);
    this.finishWork();
    this.activity = 'idle'; if (isReady(this.state.status)) this.state.status = { kind: 'ready', activity: 'idle' };
    this.store.settle();
    if (this.state.notice === 'Stopping. Waiting for OMP to settle its work.' || this.state.notice === 'Turn finished. Background work is still running.') this.state.notice = null;
    this.onActivity?.();
  }
  private applyQueues(frame: JsonRecord): boolean {
    const steering = Array.isArray(frame.steering) ? frame.steering.filter((value): value is string => typeof value === 'string') : [];
    const followUp = Array.isArray(frame.followUp) ? frame.followUp.filter((value): value is string => typeof value === 'string') : [];
    if (steering.length === this.state.queuedSteers.length && followUp.length === this.state.queuedFollowUps.length &&
      steering.every((text, index) => text === this.state.queuedSteers[index]) && followUp.every((text, index) => text === this.state.queuedFollowUps[index])) return false;
    this.state.queuedSteers = steering; this.state.queuedFollowUps = followUp;
    return true;
  }
  private reduceSubagent(value: Json | undefined): void {
    if (!isRecord(value)) return;
    const progress: JsonRecord = isRecord(value.progress) ? value.progress : {};
    const id = typeof value.id === 'string' ? value.id : typeof progress.id === 'string' ? progress.id : null;
    if (!id) return;
    if (typeof value.parentToolCallId === 'string') this.subagentParents.set(id, value.parentToolCallId);
    let agent = this.state.subagents.find(agent => agent.id === id);
    if (!agent) {
      const parent = this.subagentParents.get(id);
      const messages = [...this.store.messages.values()];
      const messageID = (parent ? messages.find(message => message.toolIDs.includes(parent)) : messages.reverse().find(message => message.role === 'assistant'))?.id ?? null;
      agent = { id, title: id, status: 'active', detail: '', messageID }; this.state.subagents.push(agent);
    }
    const title = value.name ?? value.label ?? progress.name ?? progress.label;
    const status = value.status ?? progress.status;
    const detail = progress.lastMessage ?? progress.message ?? progress.currentTool ?? value.task ?? value.assignment;
    if (typeof title === 'string') agent.title = sanitizeDiagnostic(title);
    if (typeof status === 'string') agent.status = status === 'started' ? 'active' : status;
    if (typeof detail === 'string') agent.detail = sanitizeDiagnostic(detail);
    this.resolveSubagentAnchors();
  }
  private resolveSubagentAnchors(): boolean {
    let changed = false;
    for (const agent of this.state.subagents) {
      if (agent.messageID !== null) continue;
      const parent = this.subagentParents.get(agent.id);
      if (!parent) continue;
      for (const message of this.store.messages.values()) {
        if (message.toolIDs.includes(parent)) { agent.messageID = message.id; changed = true; break; }
      }
    }
    return changed;
  }

  private reduceDialog(frame: JsonRecord): void {
    switch (frame.method) {
      case 'cancel': if (typeof frame.targetId === 'string') this.removeDialog(frame.targetId); return;
      case 'notify': if (frame.notifyType === 'error') this.state.error = sanitizeDiagnostic(typeof frame.message === 'string' ? frame.message : 'Extension error.'); else this.state.notice = sanitizeDiagnostic(typeof frame.message === 'string' ? frame.message : ''); return;
      case 'setStatus': this.state.notice = typeof frame.statusText === 'string' ? sanitizeDiagnostic(frame.statusText) : null; return;
      case 'setWidget': this.state.notice = Array.isArray(frame.widgetLines) ? sanitizeDiagnostic(frame.widgetLines.filter((line): line is string => typeof line === 'string').join('\n')) : null; return;
      case 'setTitle': return;
      case 'set_editor_text': if (typeof frame.text === 'string') this.onEditorText?.(frame.text); return;
      case 'open_url': this.state.notice = 'Provider sign-in requires Terminal. Open this session in Terminal and use omp login.'; return;
    }
    const request = parseDialog(frame);
    if (!request || this.dialogs.has(request.id)) {
      if (typeof frame.id === 'string') {
        this.removeDialog(frame.id);
        void this.client.send({ type: 'extension_ui_response', id: frame.id, cancelled: true }).catch(() => null);
      }
      this.failClosed('OMP requested an unsupported or malformed dialog. No approval was sent. Open the session in Terminal to continue safely.'); return;
    }
    const live: LiveDialog = { request, token: randomUUID(), timer: undefined, submission: null };
    this.dialogs.set(request.id, live);
    if (request.deadline !== null) live.timer = setTimeout(() => { void this.expireDialog(request.id); }, Math.max(0, request.deadline - Date.now()));
    this.state.dialogs.push(request); this.onActivity?.();
  }
  async respond(dialogID: string, fields: JsonRecord): Promise<boolean> {
    const live = this.dialogs.get(dialogID);
    if (!live) return false;
    if (live.request.deadline !== null && live.request.deadline <= Date.now()) { await this.expireDialog(dialogID); return false; }
    if (fields.cancelled === true) live.submission?.abort(); else if (live.submission) return false;
    const generation = this.generation, token = live.token, controller = new AbortController();
    live.submission = controller; live.request.error = null;
    try {
      const response = dialogResponse(live.request, fields);
      if (generation !== this.generation || this.dialogs.get(dialogID)?.token !== token) return false;
      await this.client.send(response, { signal: controller.signal });
      if (controller.signal.aborted || generation !== this.generation || this.dialogs.get(dialogID)?.token !== token) return false;
      this.removeDialog(dialogID); this.changed(); return true;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || this.dialogs.get(dialogID)?.token !== token) return false;
      live.request.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not receive the response.');
      this.state.error = live.request.error; live.submission = null; this.changed(); return false;
    }
  }
  private removeDialog(id: string): void {
    const live = this.dialogs.get(id);
    if (!live) return;
    this.dialogs.delete(id); clearTimeout(live.timer); live.submission?.abort();
    this.state.dialogs = this.state.dialogs.filter(dialog => dialog.id !== id);
  }
  private async expireDialog(id: string): Promise<void> {
    if (!this.dialogs.has(id)) return;
    this.removeDialog(id); this.state.notice = 'The agent dialog timed out.'; this.changed();
    try { await this.client.send({ type: 'extension_ui_response', id, cancelled: true, timedOut: true }); }
    catch (error) { this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not receive the cancellation.'); this.changed(); }
  }
  private failClosed(reason: string): void {
    this.state.error = reason;
    void this.client.request('abort').catch(() => null);
  }
  async sessionStats(): Promise<Json | null> {
    if (!isReady(this.state.status)) return null;
    try { return await this.client.request('get_session_stats'); }
    catch (error) { this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not retrieve session statistics.'); this.changed(); return null; }
  }
  async shutdown(): Promise<void> {
    ++this.generation; ++this.lifecycleEpoch; ++this.configEpoch;
    this.state.status = { kind: 'closed', reason: null };
    this.interrupt(); this.changed();
    await this.client.shutdown();
  }
  private interrupt(): void {
    if (this.optimisticPrompt) this.discardOptimisticPrompt(this.optimisticPrompt.id);
    this.finishWork();
    this.modelRefresh?.abort(); this.modelRefresh = null; this.historyBuffer = null; this.pendingPrompts.clear();
    this.titleRevision++; this.naming = null; this.titleCommandOutput = null; this.nativeTitleRequest = null;
    this.contextUsageEpoch++; this.state.contextUsage = null; this.stateRead = null; this.contextRefresh = null;
    this.store.interrupt(); this.activity = 'idle';
    for (const id of this.dialogs.keys()) this.removeDialog(id);
    this.state.queuedFollowUps = []; this.state.queuedSteers = [];
    for (const agent of this.state.subagents) if (agent.status === 'active' || agent.status === 'running' || agent.status === 'started') agent.status = 'interrupted';
  }
  private changed(): void { this.state.revision++; this.emit({ kind: 'summary', runtime: this.summary() }); }
}
