import { randomUUID } from 'node:crypto';
import type { ChatMessage, DialogRequest, ImageContent, Json, JsonRecord, ModelChoice, RetractedMessage, RuntimeEvent, RuntimeSnapshot, RuntimeSummary, ThreadRecord, WorkPeriod } from '../shared/types';
import { isBusy, isReady } from '../shared/types';
import { RpcClient } from './RpcClient';
import { isRecord, RpcError } from './frames';
import { MessageStore } from './MessageStore';
import { dialogResponse, parseDialog } from './dialogs';
import { sanitizeDiagnostic } from './diagnostics';
import { committedTodoPhases, parseTodoPhases } from '../shared/todos';
import { IMAGE_TOTAL_BYTE_LIMIT, imageByteCount, isImageContent } from '../shared/validation';
import { QueueAttachments, type QueueEntry, type QueueSnapshot } from './QueueAttachments';
import { editableEntry } from './MessageEdit';

interface LiveDialog { request: DialogRequest; token: string; timer: NodeJS.Timeout | undefined; submission: AbortController | null }
interface StateRead { state: JsonRecord; generation: number; lifecycle: number; config: number; thinking: number; usage: number; title: number }
interface QueuedDelivery {
  submissionID: string | null;
  entry: QueueEntry | null;
  queue: 'steering' | 'followUp';
  text: string;
  images: readonly ImageContent[];
  state: 'pending' | 'queued' | 'removed' | 'dropped' | 'delivered';
  projection: (ChatMessage & { delivery: NonNullable<ChatMessage['delivery']> }) | null;
  promotionID: string | null;
  withdrawn: boolean;
}

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
  private readonly streamingToolBlocks = new Map<string, Set<number>>();
  private readonly queueAttachments = new QueueAttachments();
  private readonly queuedDeliveries: QueuedDelivery[] = [];
  private queuePromotion: Promise<void> = Promise.resolve();
  private readonly promotionResolutions = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private optimisticPrompt: { id: string; message: ChatMessage } | null = null;
  private readonly workPeriods: WorkPeriod[] = [];
  private unanchoredUserMessageID: string | null = null;
  private advisorContinuationID: string | null = null;
  private generation = 0;
  private lifecycleEpoch = 0;
  private configEpoch = 0;
  private configurationChanges = 0;
  private thinkingRevision = 0;
  private titleRevision = 0;
  private sessionID: string | null = null;
  private nativeSessionName: string | null = null;
  private naming: { name: string } | null = null;
  private titleCommandOutput: string | null = null;
  private nativeTitleRequest: { sessionID: string } | null = null;
  private nativeTitleTask: Promise<void> | null = null;
  private modelRefresh: AbortController | null = null;
  private stateRead: Promise<StateRead> | null = null;
  private contextRefresh: Promise<void> | null = null;
  private contextUsageEpoch = 0;
  private activity: 'idle' | 'running' | 'background' | 'stopping' = 'idle';
  private historyBuffer: JsonRecord[] | null = null;
  private historyBoundarySeen = false;
  private historyEditing = false;

  constructor(readonly record: ThreadRecord, private readonly emit: (event: RuntimeEvent) => void, initialRevision = 0) {
    this.recordID = record.id;
    this.state = { id: record.id, revision: initialRevision, status: { kind: 'closed', reason: null }, error: null, notice: null, models: [], selectedModelID: '', thinkingLevels: [], thinkingLevel: '', contextUsage: null, dialogs: [], subagents: [], todoPhases: [], queuedFollowUps: [], queuedSteers: [], workPeriods: this.workPeriods };
    this.store = new MessageStore(message => {
      if (this.historyEditing) return;
      this.emit({ kind: 'message', threadID: this.recordID, revision: ++this.state.revision, message: { ...message, toolIDs: [...message.toolIDs], ...(message.images ? { images: message.images.map(image => ({ ...image })) } : {}), ...(message.details ? { details: structuredClone(message.details) } : {}) } });
    }, tool => {
      if (!this.historyEditing) this.emit({ kind: 'tool', threadID: this.recordID, revision: ++this.state.revision, tool: { ...tool } });
    });
    this.client.on('event', frame => {
      if (this.state.status.kind === 'closed') return;
      if (this.historyBuffer && (frame.type === 'message_start' || frame.type === 'message_update' || frame.type === 'message_end' || (typeof frame.type === 'string' && frame.type.startsWith('tool_')))) {
        this.historyBuffer.push(frame);
      } else this.consume(frame);
    });
  }
  snapshot(): RuntimeSnapshot {
    const projected = this.queuedDeliveries.flatMap<ChatMessage>(delivery => {
      const message = delivery.projection;
      if (!message || delivery.state === 'delivered' || delivery.withdrawn) return [];
      if (delivery.state !== 'removed' && delivery.state !== 'dropped') return [message];
      if (message.delivery.status !== 'accepted') return [];
      const { delivery: _, ...retained } = message;
      return [{ ...retained, error: 'Steer left the native queue before delivery was confirmed. Your original message is kept here and was not resent.' }];
    });
    return { ...this.summary(), messages: [...this.store.messages.values(), ...(this.optimisticPrompt ? [this.optimisticPrompt.message] : []), ...projected].map(message => ({ ...message, toolIDs: [...message.toolIDs], ...(message.images ? { images: message.images.map(image => ({ ...image })) } : {}), ...(message.delivery ? { delivery: { ...message.delivery } } : {}), ...(message.details ? { details: structuredClone(message.details) } : {}) })), tools: [...this.store.tools.values()].map(tool => ({ ...tool })) };
  }
  summary(): RuntimeSummary { return structuredClone(this.state); }
  getQueuedImages(imageRef: string): readonly ImageContent[] { return this.queueAttachments.getImages(imageRef); }
  get sessionName(): string | null { return this.nativeSessionName; }
  get canRefreshProviderConnections(): boolean {
    return this.state.status.kind === 'closed' ||
      (this.state.status.kind === 'ready' && this.state.status.activity === 'idle' && !this.historyEditing && !this.pendingPrompts.size && !this.client.hasPendingRequests &&
        !this.dialogs.size && !this.naming && !this.nativeTitleTask && !this.modelRefresh && !this.configurationChanges &&
        !this.state.queuedFollowUps.length && !this.state.queuedSteers.length && !this.queuedDeliveries.some(delivery => delivery.state === 'pending'));
  }

  async connect(executable: string, reason: 'open' | 'provider-connections' = 'open'): Promise<void> {
    if (isReady(this.state.status) || this.state.status.kind === 'connecting') return;
    const generation = ++this.generation;
    this.lifecycleEpoch++; this.configEpoch++; this.contextUsageEpoch++;
    this.titleRevision++; this.sessionID = null; this.nativeSessionName = null; this.naming = null;
    if (reason === 'open') this.workPeriods.length = 0;
    this.optimisticPrompt = null;
    this.queuedDeliveries.length = 0;
    this.unanchoredUserMessageID = null;
    this.advisorContinuationID = null;
    this.state.status = { kind: 'connecting' }; this.state.error = null; this.state.contextUsage = null;
    this.state.notice = this.record.wasRunning ? 'The previous process was interrupted. Saved history is restored; no action will be replayed.' : null;
    this.historyBuffer = []; this.historyBoundarySeen = false; this.changed();
    try {
      await this.client.start({ executable, projectPath: this.record.projectPath, sessionDirectory: this.record.ompSessionDirectory, resume: true, ...(this.record.ompSessionFile ? { sessionFile: this.record.ompSessionFile } : {}) });
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
      if (!this.state.models.length) this.state.notice = 'No models are available. Connect a provider in Settings → Connections.';
      this.state.status = { kind: 'ready', activity: this.activity };
      this.state.revision++; this.emit({ kind: 'snapshot', runtime: this.snapshot() });
      if (reason === 'open') this.maybeGenerateNativeTitle();
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

  private editIdleState(value: Json): JsonRecord {
    if (!isRecord(value) || value.isSettled !== true || value.isStreaming === true || value.isCompacting === true || value.hasPendingAsyncWork === true ||
        value.queuedMessageCount !== 0 || (typeof value.liveSteered === 'number' && value.liveSteered > 0) ||
        !isRecord(value.queuedMessages) || !Array.isArray(value.queuedMessages.steering) || value.queuedMessages.steering.length ||
        !Array.isArray(value.queuedMessages.followUp) || value.queuedMessages.followUp.length ||
        !isReady(this.state.status) || isBusy(this.state.status) || this.state.queuedFollowUps.length || this.state.queuedSteers.length || this.pendingPrompts.size || this.configurationChanges || this.modelRefresh) {
      throw new Error('Wait for current and queued work to finish before sending this edit.');
    }
    return value;
  }

  async editMessage(messageID: string, text: string): Promise<boolean> {
    if (this.historyEditing || !isReady(this.state.status) || isBusy(this.state.status) || this.pendingPrompts.size || this.dialogs.size || this.nativeTitleTask || this.naming) throw new Error('Wait for the current work to finish before sending this edit.');
    const source = this.store.userSource(messageID);
    if (!source || this.store.messages.get(messageID)?.role !== 'user') throw new Error('This sent message is no longer available to edit.');
    const generation = this.generation;
    const oldPeriods = structuredClone(this.workPeriods);
    let originalFile: string | null = null, transitioned = false, entered = false;
    this.historyEditing = true;
    try {
      const state = this.editIdleState(await this.refreshState());
      if (generation !== this.generation) return false;
      if (typeof state.sessionFile !== 'string' || !state.sessionFile) throw new Error('Save this conversation before editing a sent message.');
      originalFile = state.sessionFile; this.record.ompSessionFile = originalFile;
      const entry = editableEntry(await this.client.request('get_entries'), source);
      if (generation !== this.generation) return false;
      const nativeMessage = entry.message;
      const images: JsonRecord[] = [];
      if (Array.isArray(nativeMessage.content)) for (const block of nativeMessage.content) {
        if (isRecord(block) && block.type === 'image') {
          if (!isImageContent(block)) throw new Error('This message has an image that cannot be resent safely.');
          images.push(block);
        }
      }
      if (!text.trim() && !images.length) throw new Error('Enter a message to send.');
      const fields: JsonRecord = { message: text, ...(images.length ? { images } : {}) };
      if (Buffer.byteLength(JSON.stringify({ ...fields, type: 'prompt', id: randomUUID() }) + '\n') > this.client.maxInputFrameBytes) throw new Error("This edit exceeds OMP's input limit. Shorten the message before resending.");
      // History reads can be slow; branch itself has no native busy refusal.
      const checked = this.editIdleState(await this.client.request('get_state'));
      if (generation !== this.generation) return false;
      if (checked.sessionFile !== originalFile || checked.sessionId !== state.sessionId) throw new Error('The active conversation changed while preparing this edit. No message was resent.');
      this.historyBuffer = []; this.historyBoundarySeen = false;
      const branched = await this.client.request('branch', { entryId: entry.id });
      if (!isRecord(branched) || typeof branched.cancelled !== 'boolean') throw new RpcError('protocol', 'OMP returned an invalid branch result.');
      if (branched.cancelled) throw new Error('OMP cancelled the edit. Your original conversation is unchanged.');
      transitioned = true;
      this.lifecycleEpoch++; this.contextUsageEpoch++; this.titleRevision++;
      const branchState = await this.refreshState();
      if (generation !== this.generation) return false;
      if (typeof branchState?.sessionFile !== 'string' || branchState.sessionFile === originalFile) throw new RpcError('protocol', 'OMP did not create a separate edited conversation.');
      this.record.ompSessionFile = branchState.sessionFile;
      const prefix = await this.loadHistory();
      if (generation !== this.generation) return false;
      this.workPeriods.length = 0;
      const accepted = await this.submitPrompt(text, { images });
      if (generation !== this.generation) return false;
      const buffered = this.historyBuffer ?? [];
      entered = accepted || this.pendingPrompts.size > 0 || buffered.some(frame => (frame.type === 'message_start' || frame.type === 'message_end') && isRecord(frame.message) && frame.message.role === 'user');
      if (!entered) throw new Error(this.state.error ?? 'OMP did not admit the edited message. Your edit is still here.');
      // A lost acknowledgement is not permission to replay or roll back a possibly admitted turn.
      if (!accepted) this.state.notice = 'The edited message may have been admitted. Do not resend it while OMP resolves its current work.';
      this.store.restore(prefix); this.state.subagents = []; this.subagentParents.clear();
      this.historyBuffer = null;
      for (const frame of buffered) this.consume(frame);
      this.historyEditing = false;
      this.messagesChanged();
      this.onActivity?.();
      return true;
    } catch (failure) {
      if (generation !== this.generation) return false;
      // Hooks may throw after changing sessions. Read back instead of assuming no transition.
      if (originalFile && !entered) {
        try {
          const current = await this.client.request('get_state');
          if (!isRecord(current)) throw new Error('OMP could not identify the active session.');
          if (current.sessionFile !== originalFile) {
            const rollback = await this.client.request('switch_session', { sessionPath: originalFile });
            if (!isRecord(rollback) || rollback.cancelled !== false) throw new Error('OMP cancelled restoring the original conversation.');
            const restored = await this.client.request('get_state');
            if (!isRecord(restored) || restored.sessionFile !== originalFile) throw new Error('OMP did not restore the original conversation.');
          }
          this.record.ompSessionFile = originalFile;
          this.workPeriods.splice(0, this.workPeriods.length, ...oldPeriods);
          this.optimisticPrompt = null;
          this.lifecycleEpoch++; this.contextUsageEpoch++; this.titleRevision++;
          await this.refreshState();
        } catch (rollbackFailure) {
          this.state.notice = 'The original branch is saved, but restoring it failed. Keep your edit and reopen this conversation before continuing.';
          this.state.error = sanitizeDiagnostic(rollbackFailure instanceof Error ? rollbackFailure.message : 'OMP could not restore the original conversation.');
          await this.shutdown();
          throw new Error(this.state.notice);
        }
      }
      if (transitioned) this.state.error = null;
      throw failure;
    } finally {
      if (generation === this.generation) { this.historyBuffer = null; this.historyEditing = false; this.changed(); }
      else this.historyEditing = false;
    }
  }

  async sendPrompt(message: string, options: { steer?: boolean; images?: JsonRecord[] } = {}): Promise<boolean> {
    if (this.historyEditing) return false;
    return this.submitPrompt(message, options);
  }
  private async submitPrompt(message: string, options: { steer?: boolean; images?: JsonRecord[] } = {}): Promise<boolean> {
    if (!isReady(this.state.status) || (!message.trim() && !options.images?.length)) return false;
    const generation = this.generation, id = randomUUID(), busy = isBusy(this.state.status);
    const images = options.images?.filter(isImageContent) ?? [];
    this.lifecycleEpoch++;
    if (busy) {
      const queue = options.steer ? 'steering' : 'followUp';
      this.queueAttachments.submitted(id, queue, message, images);
      const delivery: QueuedDelivery = { submissionID: id, entry: null, queue, text: message, images, state: 'pending', projection: null, promotionID: null, withdrawn: false };
      this.queuedDeliveries.push(delivery);
      if (options.steer) this.projectSteer(delivery, 'sending');
    } else { this.pendingPrompts.add(id); this.activity = 'running'; }
    this.unanchoredUserMessageID = null;
    if (!busy) this.advisorContinuationID = null;
    if (!busy) {
      const messageID = `pending-${id}`;
      this.optimisticPrompt = { id, message: { id: messageID, role: 'user', text: message, thinking: '', error: null, isStreaming: false, toolIDs: [], ...(options.images ? { images } : {}) } };
      this.unanchoredUserMessageID = messageID;
    }
    this.beginWork();
    this.state.status = { kind: 'ready', activity: this.activity }; this.state.error = null;
    if (!busy || options.steer) this.messagesChanged(); else this.changed();
    const fields: JsonRecord = { message };
    if (options.images?.length) fields.images = options.images;
    if (busy) fields.streamingBehavior = options.steer ? 'steer' : 'followUp';
    try {
      const result = await this.client.request('prompt', fields, { id, timeout: 60000 });
      if (generation !== this.generation) return false;
      // Admission is reduced synchronously before the request resolves so a
      // later queue event cannot be attributed to an earlier prompt reply.
      if (isRecord(result) && result.agentInvoked === false) await this.refreshState();
      if (generation !== this.generation) return false;
      this.onActivity?.(); this.changed(); return true;
    } catch (error) {
      if (generation !== this.generation || !isReady(this.state.status)) return false;
      if (!(error instanceof RpcError && error.kind === 'timeout')) {
        this.queueAttachments.rejected(id);
        this.discardQueuedSubmission(id);
        this.applyQueueSnapshot(this.queueAttachments.snapshot());
        this.discardOptimisticPrompt(id); this.pendingPrompts.delete(id); this.lifecycleEpoch++;
      }
      this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP rejected the prompt.');
      const state = await this.refreshState(5000).catch(() => null);
      if (generation !== this.generation) return false;
      if (!busy && state?.isSettled === true) { this.discardOptimisticPrompt(id); this.pendingPrompts.delete(id); this.applyActivity(state); }
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
  promoteQueued(message: string): Promise<boolean> {
    const generation = this.generation;
    if (!isReady(this.state.status)) return Promise.resolve(false);
    const entry = this.queueAttachments.entries('followUp').find(item => item.text === message && !this.queuedDeliveries.some(delivery => delivery.entry === item && delivery.promotionID !== null));
    if (!entry) return Promise.resolve(false);
    const initialDelivery = this.queuedDeliveries.find(item => item.entry === entry);
    if (!initialDelivery) return Promise.resolve(false);
    let delivery: QueuedDelivery = initialDelivery;
    const id = randomUUID();
    const resolution = Promise.withResolvers<void>();
    this.promotionResolutions.set(id, resolution);
    let unresolved = false;
    delivery.promotionID = id;
    this.projectSteer(delivery, 'sending');
    this.messagesChanged();
    const operation = this.queuePromotion.then(async () => {
      if (generation !== this.generation || !isReady(this.state.status)) return false;
      const promotion = this.queueAttachments.promote(message);
      if (!promotion?.entry) {
        if (delivery.promotionID === id) {
          delivery.promotionID = null;
          if (delivery.state !== 'delivered') { delivery.projection = null; this.messagesChanged(); }
        }
        resolution.resolve(); this.promotionResolutions.delete(id);
        return false;
      }
      // Native promotion targets the surviving FIFO occurrence at dispatch time.
      if (promotion.entry !== delivery.entry) {
        if (delivery.promotionID === id) {
          delivery.promotionID = null;
          if (delivery.state !== 'delivered') delivery.projection = null;
        }
        const surviving = this.queuedDeliveries.find(item => item.entry === promotion.entry);
        if (!surviving || (surviving.promotionID !== null && surviving.promotionID !== id)) {
          resolution.resolve(); this.promotionResolutions.delete(id);
          this.queueAttachments.finishPromotion(promotion);
          this.messagesChanged();
          return false;
        }
        delivery = surviving;
        delivery.promotionID = id;
        this.projectSteer(delivery, 'sending');
        this.messagesChanged();
      }
      this.lifecycleEpoch++;
      unresolved = false;
      try {
        const result = await this.client.request('promote_queued_message', { message }, { id });
        if (generation !== this.generation) return false;
        if (!isRecord(result) || typeof result.promoted !== 'boolean') throw new RpcError('protocol', 'OMP returned an invalid queue promotion result.');
        resolution.resolve(); this.promotionResolutions.delete(id);
        if (!result.promoted) {
          delivery.projection = null;
          await this.refreshState();
        } else if (delivery.projection) delivery.projection.delivery.status = 'accepted';
        this.messagesChanged();
        return result.promoted;
      } catch (error) {
        if (generation !== this.generation) return false;
        unresolved = error instanceof RpcError && error.kind === 'timeout';
        if (!unresolved && isReady(this.state.status)) delivery.projection = null;
        this.messagesChanged();
        throw error;
      } finally {
        if (unresolved) void resolution.promise.then(() => this.queueAttachments.finishPromotion(promotion));
        else {
          resolution.resolve(); this.promotionResolutions.delete(id);
          this.queueAttachments.finishPromotion(promotion);
        }
        if (!unresolved && generation === this.generation && delivery.promotionID === id) delivery.promotionID = null;
      }
    });
    this.queuePromotion = operation.then(() => {}, () => {}).then(() => unresolved ? resolution.promise : undefined);
    return operation;
  }
  retractQueued(queue: 'steering' | 'followUp', message: string, imageRef: string | null): Promise<RetractedMessage | null> {
    const generation = this.generation;
    const operation = this.queuePromotion.then(async () => {
      if (generation !== this.generation || !isReady(this.state.status)) return null;
      await this.refreshState();
      if (generation !== this.generation || !isReady(this.state.status)) return null;
      const retraction = this.queueAttachments.prepareRetraction(queue, message, imageRef);
      if (!retraction) return null;
      let restored: RetractedMessage | null = null;
      const delivery = this.queuedDeliveries.find(item => item.entry === retraction.entry);
      if (delivery) delivery.withdrawn = true;
      this.lifecycleEpoch++;
      try {
        const result = await this.client.request('remove_queued_message', { queue, message: retraction.entry.text });
        if (generation !== this.generation || !isReady(this.state.status)) return null;
        if (!isRecord(result) || typeof result.removed !== 'boolean' ||
            (result.imagesDropped !== undefined && typeof result.imagesDropped !== 'boolean')) {
          throw new RpcError('protocol', 'OMP returned an invalid queue removal result.');
        }
        let images: ImageContent[] = [];
        if (result.images !== undefined) {
          if (!Array.isArray(result.images) || result.images.length > 20 || !result.images.every(isImageContent) ||
              result.images.reduce((total, image) => total + imageByteCount(image), 0) > IMAGE_TOTAL_BYTE_LIMIT) {
            throw new RpcError('protocol', 'OMP returned invalid images for the removed message.');
          }
          images = result.images;
        }
        if (result.removed) {
          // queue_update can release the tracked preview before this response.
          if (!images.length && result.imagesDropped === true) images = retraction.images.map(image => ({ ...image }));
          restored = { text: retraction.entry.text, images, imagesDropped: result.imagesDropped === true && !images.length };
          if (delivery) delivery.projection = null;
          this.applyQueueSnapshot(this.queueAttachments.finishRetraction(retraction));
        }
      } catch (error) {
        if (generation === this.generation && isReady(this.state.status)) throw error;
      } finally {
        this.queueAttachments.cancelRetraction(retraction);
        if (delivery && !restored) delivery.withdrawn = false;
        if (generation === this.generation && isReady(this.state.status)) {
          this.lifecycleEpoch++;
          try { await this.refreshState(); }
          catch (error) {
            if (generation === this.generation) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not refresh its queues.');
          }
          if (generation === this.generation) this.changed();
        }
      }
      return generation === this.generation && isReady(this.state.status) ? restored : null;
    });
    this.queuePromotion = operation.then(() => {}, () => {});
    return operation;
  }
  async selectModel(id: string): Promise<void> {
    const model = this.state.models.find(choice => choice.id === id);
    if (!isReady(this.state.status) || !model) return;
    const generation = this.generation;
    this.modelRefresh?.abort(); const epoch = ++this.configEpoch; this.contextUsageEpoch++;
    this.configurationChanges++;
    try {
      await this.client.request('set_model', { provider: model.provider, modelId: model.modelID }, { timeout: 60000 });
      if (generation !== this.generation) return;
      // set_model may emit model_changed; refresh against its newer configuration epoch.
      await this.refreshModelConfiguration();
      if (generation !== this.generation) return;
      this.state.error = null; this.onActivity?.();
    } catch (error) { if (generation === this.generation && epoch <= this.configEpoch) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not select the model.'); }
    finally { this.configurationChanges--; }
    if (generation === this.generation) this.changed();
  }
  async selectThinking(level: string): Promise<void> {
    // RPC accepts inherit as a reset even though capability discovery omits it.
    if (!isReady(this.state.status) || (level !== 'inherit' && !this.state.thinkingLevels.includes(level))) return;
    const generation = this.generation;
    this.configurationChanges++;
    try { await this.client.request('set_thinking_level', { level }); if (generation !== this.generation) return; await this.refreshState(); this.state.error = null; }
    catch (error) { if (generation === this.generation) this.state.error = sanitizeDiagnostic(error instanceof Error ? error.message : 'OMP could not select thinking effort.'); }
    finally { this.configurationChanges--; }
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
    } finally {
      if (this.naming === naming) { this.naming = null; this.onActivity?.(); }
    }
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
    const task = (async () => {
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
    }).finally(() => {
      if (this.nativeTitleTask === task) { this.nativeTitleTask = null; this.onActivity?.(); }
    });
    this.nativeTitleTask = task;
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
    return this.applyQueues(read.state.queuedMessages, read.lifecycle);
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
    if (isRecord(state.queuedMessages)) this.applyQueues(state.queuedMessages, this.lifecycleEpoch);
  }
  private static modelChoice(value: Json | undefined): ModelChoice | null {
    if (!isRecord(value) || typeof value.provider !== 'string' || !value.provider || typeof value.id !== 'string' || !value.id) return null;
    return { id: `${value.provider}/${value.id}`, provider: value.provider, modelID: value.id, name: typeof value.name === 'string' ? value.name : value.id, supportsImages: Array.isArray(value.input) && value.input.includes('image') };
  }

  private updateToolStreamMode(frame: JsonRecord): void {
    const wasStreaming = this.streamingToolBlocks.size > 0;
    if (frame.type === 'agent_end') this.streamingToolBlocks.clear();
    else if (typeof frame.messageId === 'string') {
      if (frame.type === 'message_end') this.streamingToolBlocks.delete(frame.messageId);
      else if (frame.type === 'message_update' && isRecord(frame.assistantMessageEvent)) {
        const event = frame.assistantMessageEvent, index = event.contentIndex;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return;
        if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
          const blocks = this.streamingToolBlocks.get(frame.messageId) ?? new Set<number>();
          blocks.add(index); this.streamingToolBlocks.set(frame.messageId, blocks);
        } else if (event.type === 'toolcall_end') {
          const blocks = this.streamingToolBlocks.get(frame.messageId);
          blocks?.delete(index);
          if (!blocks?.size) this.streamingToolBlocks.delete(frame.messageId);
        }
      }
    }
    const streaming = this.streamingToolBlocks.size > 0;
    if (wasStreaming !== streaming) {
      // Delta tool events omit identity and parsed arguments. Request snapshots only
      // while arguments stream, then restore delta transport for prose and reasoning.
      void this.client.request('set_event_filter', { events: null, messageUpdates: streaming ? 'full' : 'delta' }).catch(() => null);
    }
  }

  consume(frame: JsonRecord): void {
    this.updateToolStreamMode(frame);
    switch (frame.type) {
      case 'message_start':
      case 'message_end': {
        const confirmed = this.confirmQueuedDelivery(frame) || this.confirmOptimisticPrompt(frame);
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
        const queued = this.queuedDeliveries.find(delivery => delivery.submissionID === frame.id);
        if (queued && (frame.status === 'error' || frame.status === 'aborted')) {
          if (queued.state !== 'delivered') { queued.state = 'dropped'; this.messagesChanged(); }
          this.refreshContextUsage();
        }
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
        if (frame.command === 'promote_queued_message' && typeof frame.id === 'string') {
          const delivery = this.queuedDeliveries.find(item => item.promotionID === frame.id);
          if (!delivery) return;
          this.promotionResolutions.get(frame.id)?.resolve(); this.promotionResolutions.delete(frame.id);
          delivery.promotionID = null;
          if (frame.success === false || (isRecord(frame.data) && frame.data.promoted === false)) delivery.projection = null;
          else if (delivery.projection) delivery.projection.delivery.status = 'accepted';
          this.messagesChanged();
          return;
        }
        if (typeof frame.id !== 'string' || (frame.command !== 'prompt' && frame.command !== 'abort_and_prompt')) return;
        if (frame.success === false || (isRecord(frame.data) && frame.data.agentInvoked === false)) {
          this.queueAttachments.rejected(frame.id);
          this.discardQueuedSubmission(frame.id);
          this.applyQueueSnapshot(this.queueAttachments.snapshot());
          this.pendingPrompts.delete(frame.id); this.discardOptimisticPrompt(frame.id);
          this.lifecycleEpoch++; void this.refreshState().then(() => this.changed()).catch(() => this.changed());
        } else if (frame.success === true) {
          this.queueAttachments.admitted(frame.id, ++this.lifecycleEpoch);
          this.applyQueueSnapshot(this.queueAttachments.snapshot());
          if (isRecord(frame.data) && frame.data.agentInvoked === true && this.queuedDeliveries.some(delivery => delivery.submissionID === frame.id)) this.pendingPrompts.add(frame.id);
          this.acceptQueuedSubmission(frame.id);
          this.refreshContextUsage();
        } else return;
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
  private projectSteer(delivery: QueuedDelivery, status: 'sending' | 'accepted'): boolean {
    const projection = delivery.projection;
    const imageRef = delivery.entry?.imageRef ?? (delivery.images.length ? delivery.submissionID : null);
    if (projection) {
      const changed = projection.delivery.status !== status || projection.delivery.queue !== delivery.queue || projection.delivery.imageRef !== imageRef;
      projection.delivery = { kind: 'steer', status, queue: delivery.queue, imageRef };
      return changed;
    }
    delivery.projection = {
      id: `pending-steer-${randomUUID()}`, role: 'user', text: delivery.text, images: delivery.images.map(image => ({ ...image })),
      thinking: '', error: null, isStreaming: false, toolIDs: [],
      delivery: { kind: 'steer', status, queue: delivery.queue, imageRef },
    };
    return true;
  }
  private acceptQueuedSubmission(id: string): void {
    const delivery = this.queuedDeliveries.find(item => item.submissionID === id);
    if (delivery?.projection && delivery.state !== 'delivered') {
      delivery.projection.delivery.status = 'accepted';
      this.messagesChanged();
    }
  }
  private discardQueuedSubmission(id: string): void {
    const delivery = this.queuedDeliveries.find(item => item.submissionID === id);
    if (!delivery || delivery.state === 'delivered') return;
    delivery.projection = null;
    delivery.state = 'dropped';
    this.messagesChanged();
  }
  private confirmQueuedDelivery(frame: JsonRecord): boolean {
    if (!isRecord(frame.message) || typeof frame.messageId !== 'string' ||
        !frame.messageId || this.store.messages.has(frame.messageId) || frame.message.content === undefined) return false;
    const skillChip = frame.message.role === 'custom' && frame.message.customType === 'skill-prompt' &&
      frame.message.attribution === 'user' && frame.message.display !== false && isRecord(frame.message.details) &&
      typeof frame.message.details.__queueChipText === 'string' ? frame.message.details.__queueChipText : null;
    if (frame.message.role !== 'user' && skillChip === null) return false;
    const content = frame.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n\n') : '';
    const images = Array.isArray(content) ? content.filter(isImageContent) : [];
    const candidates = this.queuedDeliveries.filter(delivery => delivery.state !== 'delivered' && delivery.state !== 'dropped').sort((left, right) => Number(left.queue === 'followUp') - Number(right.queue === 'followUp'));
    // Queue removal can precede native delivery, including an intervening state
    // read. Only settlement or a terminal result ends FIFO attribution.
    const removed = candidates.filter(delivery => delivery.state === 'removed');
    const sameContent = (delivery: QueuedDelivery): boolean => delivery.text === text && delivery.images.length === images.length &&
      delivery.images.every((image, index) => image.mimeType === images[index]?.mimeType && image.data === images[index]?.data);
    const matchesSkill = (delivery: QueuedDelivery): boolean => (delivery.entry?.chip ?? delivery.text) === skillChip;
    const delivery = skillChip !== null ? removed.find(matchesSkill) ?? candidates.find(matchesSkill) :
      removed.find(sameContent) ?? candidates.find(sameContent) ?? removed[0] ??
        (!this.optimisticPrompt || frame.message.steering === true ? candidates.find(item => item.queue === 'steering') ?? candidates.find(item => item.state === 'queued') : undefined);
    if (!delivery) return false;
    delivery.state = 'delivered';
    if (delivery.projection) for (const period of this.workPeriods) if (period.messageID === delivery.projection.id) period.messageID = frame.messageId;
    delivery.projection = null;
    delivery.images = [];
    return true;
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
  private messagesChanged(): void { if (!this.historyEditing) { this.state.revision++; this.emit({ kind: 'snapshot', runtime: this.snapshot() }); } }

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
    let retired = false;
    for (const delivery of this.queuedDeliveries) if (delivery.state === 'removed' || (delivery.state === 'pending' && delivery.projection?.delivery.status === 'accepted')) {
      delivery.state = 'dropped';
      retired ||= delivery.projection !== null;
    }
    if (retired) this.messagesChanged();
    if (this.optimisticPrompt) this.discardOptimisticPrompt(this.optimisticPrompt.id);
    this.finishWork();
    this.activity = 'idle'; if (isReady(this.state.status)) this.state.status = { kind: 'ready', activity: 'idle' };
    this.store.settle();
    if (this.state.notice === 'Stopping. Waiting for OMP to settle its work.' || this.state.notice === 'Turn finished. Background work is still running.') this.state.notice = null;
    this.onActivity?.();
  }
  private applyQueues(frame: JsonRecord, observedAt?: number): boolean {
    const steering = Array.isArray(frame.steering) ? frame.steering.filter((value): value is string => typeof value === 'string') : [];
    const followUp = Array.isArray(frame.followUp) ? frame.followUp.filter((value): value is string => typeof value === 'string') : [];
    return this.applyQueueSnapshot(this.queueAttachments.reconcile(steering, followUp, observedAt));
  }
  private applyQueueSnapshot({ steering, followUp }: QueueSnapshot): boolean {
    const changed = steering.length !== this.state.queuedSteers.length || followUp.length !== this.state.queuedFollowUps.length ||
      steering.some((entry, index) => entry.text !== this.state.queuedSteers[index]?.text || entry.imageCount !== this.state.queuedSteers[index]?.imageCount || entry.imageRef !== this.state.queuedSteers[index]?.imageRef) ||
      followUp.some((entry, index) => entry.text !== this.state.queuedFollowUps[index]?.text || entry.imageCount !== this.state.queuedFollowUps[index]?.imageCount || entry.imageRef !== this.state.queuedFollowUps[index]?.imageRef);
    this.state.queuedSteers = steering; this.state.queuedFollowUps = followUp;
    const visible = new Set<QueuedDelivery>();
    let messagesChanged = false;
    for (const queue of ['steering', 'followUp'] as const) for (const entry of this.queueAttachments.entries(queue)) {
      let delivery = this.queuedDeliveries.find(item => item.entry === entry || (entry.submission !== null && item.submissionID === entry.submission));
      if (!delivery) {
        if (entry.submission === null && this.queueAttachments.hasUnbound(queue)) continue;
        delivery = { submissionID: entry.submission, entry, queue, text: entry.text, images: entry.imageRef ? this.queueAttachments.getImages(entry.imageRef) : [], state: 'queued', projection: null, promotionID: null, withdrawn: false };
        this.queuedDeliveries.push(delivery);
      }
      delivery.entry = entry; delivery.queue = queue;
      if (delivery.text !== entry.text) {
        delivery.text = entry.text;
        if (delivery.projection) { delivery.projection.text = entry.text; messagesChanged = true; }
      }
      visible.add(delivery);
      if (delivery.state === 'delivered' || delivery.state === 'dropped') continue;
      if (delivery.state !== 'queued') { delivery.state = 'queued'; messagesChanged ||= delivery.projection !== null; }
      if (queue === 'steering') {
        if (delivery.promotionID) {
          this.promotionResolutions.get(delivery.promotionID)?.resolve();
          this.promotionResolutions.delete(delivery.promotionID);
        }
        messagesChanged = this.projectSteer(delivery, 'accepted') || messagesChanged;
      } else if (delivery.projection) {
        delivery.projection.delivery.queue = queue;
        delivery.projection.delivery.imageRef = entry.imageRef;
      }
    }
    for (const delivery of this.queuedDeliveries) if (delivery.state === 'queued' && !visible.has(delivery)) {
      delivery.state = 'removed';
      if (delivery.promotionID) {
        this.promotionResolutions.get(delivery.promotionID)?.resolve();
        this.promotionResolutions.delete(delivery.promotionID);
      }
      messagesChanged ||= delivery.projection !== null;
    }
    for (let index = this.queuedDeliveries.length - 1; index >= 0; index--) {
      const delivery = this.queuedDeliveries[index];
      if (delivery && !visible.has(delivery) && (delivery.state === 'delivered' || (delivery.state === 'dropped' && !delivery.projection))) this.queuedDeliveries.splice(index, 1);
    }
    if (messagesChanged) this.messagesChanged();
    return changed;
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
      case 'set_editor_text': if (!this.historyEditing && typeof frame.text === 'string') this.onEditorText?.(frame.text); return;
      case 'open_url': this.state.notice = 'Connect provider accounts in Settings → Connections.'; return;
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
    for (const resolution of this.promotionResolutions.values()) resolution.resolve();
    this.promotionResolutions.clear();
    this.queuePromotion = Promise.resolve();
    for (const delivery of this.queuedDeliveries) if (delivery.state !== 'delivered') {
      delivery.state = 'dropped';
      if (delivery.projection) delivery.projection.delivery.status = 'accepted';
    }
    if (this.queuedDeliveries.some(delivery => delivery.projection)) this.messagesChanged();
    if (this.optimisticPrompt) this.discardOptimisticPrompt(this.optimisticPrompt.id);
    this.finishWork();
    this.modelRefresh?.abort(); this.modelRefresh = null; this.historyBuffer = null; this.pendingPrompts.clear();
    this.titleRevision++; this.naming = null; this.titleCommandOutput = null; this.nativeTitleRequest = null; this.nativeTitleTask = null;
    this.contextUsageEpoch++; this.state.contextUsage = null; this.stateRead = null; this.contextRefresh = null;
    this.streamingToolBlocks.clear();
    this.store.interrupt(); this.activity = 'idle';
    for (const id of this.dialogs.keys()) this.removeDialog(id);
    this.state.queuedFollowUps = []; this.state.queuedSteers = [];
    this.queueAttachments.reset();
    for (const agent of this.state.subagents) if (agent.status === 'active' || agent.status === 'running' || agent.status === 'started') agent.status = 'interrupted';
  }
  private changed(): void { this.state.revision++; this.emit({ kind: 'summary', runtime: this.summary() }); }
}
