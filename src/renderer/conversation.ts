import type { ChatMessage, RuntimeSnapshot, ToolActivity } from '../shared/types';
import { isBusy } from '../shared/types';
import { copy, element, iconButton, request } from './dom';
import { renderMarkdown } from './markdown';
import { StreamingText } from './streaming-text';
import { disclosureCaret, icon, toolIcon } from './icons';
import { isRuleNotice, renderBackgroundMessage } from './background-results';
import { QueuedMessages, type QueuedEditRequest } from './queued-messages';
import { MessageImages } from './message-images';
import { SentMessageEditor } from './sent-message-editor';
import { jsonRecord } from './helpers';
import { WorkProgress } from './work-progress';
import { TextShimmer } from './shimmer';
import { SurfacePresence } from './surface-presence';
import ompLogo from './omp-logo.svg';

interface MessageView { node: HTMLElement; body: HTMLElement; images: MessageImages; reasoning: HTMLElement; error: HTMLElement; value: ChatMessage; advisors: readonly ChatMessage[] | undefined }
interface ToolView { node: HTMLDetailsElement; summary: HTMLElement; detail: HTMLElement; input: HTMLElement; output: HTMLElement; value: ToolActivity }
interface ActivityView { node: HTMLDetailsElement; label: HTMLElement; current: HTMLElement; state: HTMLElement | null; list: HTMLElement }
const FILE_TOOLS: Record<string, true | undefined> = { read: true, write: true, edit: true, glob: true, grep: true };

function createActivityView(): ActivityView {
  const node = element('details', 'activity-group'), summary = element('summary', 'activity-summary');
  const label = element('span', 'activity-label'), current = element('span', 'activity-current');
  const list = element('div', 'activity-list');
  current.hidden = true;
  summary.append(label, current, disclosureCaret()); node.append(summary, list);
  return { node, label, current, state: null, list };
}

function toolLabel(name: string): string {
  if (name === 'eval') return 'Run code';
  const text = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLocaleLowerCase();
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function toolAction(tool: ToolActivity): string {
  if (tool.name === 'eval') return tool.target.trim() || toolLabel(tool.name);
  return `${toolLabel(tool.name)}${tool.target ? ` ${tool.target}` : ''}`;
}

function toolOnlyMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && !message.text.trim() && !message.images?.length && !message.thinking.trim() && !message.error && message.toolIDs.length > 0;
}

function transcriptMessage(message: ChatMessage): boolean {
  if (message.role === 'developer' || message.role === 'system') return isRuleNotice(message);
  if (message.role !== 'custom') return true;
  if (message.display === false || message.customType === 'irc:incoming') return false;
  const jobs = message.customType === 'async-result' ? message.details?.jobs : undefined;
  return !Array.isArray(jobs) || !jobs.length || !jobs.every(job => {
    const type = jsonRecord(job)?.type;
    return type === 'task' || type === 'bash';
  });
}

function advisorMessage(message: ChatMessage): boolean {
  return message.role === 'custom' && message.customType === 'advisor' && !message.isStreaming;
}

const INITIAL_MESSAGES = 60;
const HISTORY_BATCH = 30;
const ORPHAN_ACTIVITY = Symbol('unattached activity');
export class Conversation {
  readonly node = element('section', 'conversation');
  readonly scroll = element('div', 'conversation-scroll');
  readonly content = element('div', 'conversation-content');
  private readonly backdrop = element('div', 'conversation-backdrop');
  private readonly work = new WorkProgress(this.content);
  private readonly shimmer = new TextShimmer();
  private readonly imageLoaded = (): void => { if (this.follow) this.scroll.scrollTop = this.scroll.scrollHeight; };
  private readonly queued = new QueuedMessages(this.imageLoaded);
  private readonly sentEditor = new SentMessageEditor(() => this.node.isConnected && !this.node.hidden, () => this.followLatest());
  readonly pending = this.queued.node;
  set onEditQueued(callback: ((value: QueuedEditRequest) => Promise<void>) | null) { this.queued.onEdit = callback; }
  readonly jump = iconButton('arrow-down', 'Jump to latest', () => this.followLatest(), 'jump-latest');
  private threadID: string | null = null;
  private messages = new Map<string, MessageView>();
  private readonly textStreams = new Map<HTMLElement, StreamingText>();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private tools = new Map<string, ToolView>();
  private activities = new Map<string | symbol, ActivityView>();
  private readonly responseActions = new Map<string, HTMLElement>();
  private hydrated = false;
  private follow = true;
  private restoringBottom = false;
  private renderedRuntime: RuntimeSnapshot | undefined;
  private initialHistoryPending = true;
  private historyStart = 0;
  private historyTask: number | null = null;
  private prepending = false;
  private bottomFrame: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly historyLoading = element('div', 'history-loading muted', 'Loading earlier messages…');
  private query = '';
  private hits: HTMLElement[] = [];
  private hitIndex = -1;
  readonly find = element('div', 'find-bar');
  readonly findInput = element('input');
  private findCount = element('span', 'muted');
  private readonly findPresence = new SurfacePresence(this.find);
  private readonly jumpPresence = new SurfacePresence(this.jump);
  private findFocusOrigin: HTMLElement | null = null;
  constructor() {
    this.scroll.dataset.testid = 'transcript';
    this.scroll.tabIndex = 0; this.scroll.setAttribute('role', 'region'); this.scroll.setAttribute('aria-label', 'Conversation');
    this.backdrop.innerHTML = ompLogo; this.backdrop.hidden = true;
    this.backdrop.setAttribute('role', 'status');
    this.historyLoading.hidden = true; this.historyLoading.setAttribute('role', 'status');
    const transcript = element('div', 'conversation-transcript');
    this.scroll.append(this.historyLoading, this.content);
    transcript.append(this.scroll, this.jump);
    this.node.append(this.backdrop, this.find, transcript, this.pending);
    this.findPresence.setVisible(false, true); this.jumpPresence.setVisible(false, true);
    this.findInput.type = 'search'; this.findInput.placeholder = 'Find in conversation'; this.findInput.setAttribute('aria-label', 'Find in conversation');
    this.findCount.setAttribute('aria-live', 'polite');
    this.find.append(this.findInput, this.findCount, iconButton('arrow-up', 'Previous match', () => this.moveHit(-1)), iconButton('arrow-down', 'Next match', () => this.moveHit(1)), iconButton('close', 'Close find', () => this.closeFind()));
    this.findInput.addEventListener('input', () => { this.query = this.findInput.value; this.refreshFind(); });
    this.find.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target === this.findInput) { event.preventDefault(); this.moveHit(event.shiftKey ? -1 : 1); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeFind(); }
    });
    this.scroll.addEventListener('scroll', () => {
      const away = this.scroll.scrollHeight - this.scroll.clientHeight - this.scroll.scrollTop > 2;
      if (away) this.pauseFollowing(); else this.setJumpVisible(false);
    }, { passive: true });
    this.scroll.addEventListener('wheel', event => { if (event.deltaY < 0) this.pauseFollowing(); }, { passive: true });
    this.scroll.addEventListener('touchmove', () => this.pauseFollowing(), { passive: true });
    this.scroll.addEventListener('keydown', event => { if (['Home', 'PageUp', 'ArrowUp'].includes(event.key) || event.key === ' ' && event.shiftKey) this.pauseFollowing(); });
    this.content.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('summary')) this.pauseFollowing();
    });
    this.resizeObserver = new ResizeObserver(() => {
      // Keep viewport resizing at the bottom before paint, not in the next frame.
      if (this.follow || this.restoringBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
      else this.setJumpVisible(this.scroll.scrollHeight - this.scroll.clientHeight - this.scroll.scrollTop > 2);
    });
    this.resizeObserver.observe(this.scroll);
    this.resizeObserver.observe(this.content);
  }
  showFind(): void {
    if (!this.findPresence.visible) this.findFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.findPresence.setVisible(true); this.findInput.focus({ preventScroll: true }); this.findInput.select();
  }
  private closeFind(): void {
    const restore = this.find.contains(document.activeElement);
    this.findPresence.setVisible(false); this.query = ''; this.findInput.value = ''; this.refreshFind();
    if (restore) {
      const target = this.findFocusOrigin;
      if (target?.isConnected && target.checkVisibility() && !target.closest('[inert]')) target.focus({ preventScroll: true });
      else this.scroll.focus({ preventScroll: true });
    }
    this.findFocusOrigin = null;
  }
  private setJumpVisible(visible: boolean, instant = false): void {
    if (!visible && this.jump.contains(document.activeElement)) this.scroll.focus({ preventScroll: true });
    this.jumpPresence.setVisible(visible, instant);
  }
  private pauseFollowing(): void {
    this.follow = false; this.restoringBottom = false;
    if (this.bottomFrame !== null) { cancelAnimationFrame(this.bottomFrame); this.bottomFrame = null; }
    this.setJumpVisible(this.scroll.scrollHeight - this.scroll.clientHeight - this.scroll.scrollTop > 2);
  }
  followLatest(): void {
    this.follow = true; this.restoringBottom = true;
    this.positionBottom(this.threadID);
  }
  activate(): void {
    this.sentEditor.activate();
    this.follow = true; this.restoringBottom = true;
    this.clearTextStreams(true);
    this.hydrated = false;
    const words = this.content.querySelectorAll('span.stream-word');
    for (const word of words) word.replaceWith(...word.childNodes);
    if (words.length) this.content.normalize();
    for (const hit of this.content.querySelectorAll('.find-match')) hit.classList.remove('find-match');
    this.query = ''; this.findInput.value = ''; this.findPresence.setVisible(false, true); this.findFocusOrigin = null;
    this.node.classList.remove('is-finding'); this.hits = []; this.hitIndex = -1; this.findCount.textContent = '';
    this.setJumpVisible(false, true);
    this.work.activate();
  }
  dispose(): void {
    this.cancelHistory();
    this.clearTextStreams(false);
    this.work.clear();
    this.shimmer.clear();
    this.queued.dispose();
    this.sentEditor.dispose();
    for (const view of this.messages.values()) view.images.dispose();
    this.findPresence.dispose(); this.jumpPresence.dispose();
    if (this.bottomFrame !== null) cancelAnimationFrame(this.bottomFrame);
    this.resizeObserver.disconnect(); this.node.remove(); this.renderedRuntime = undefined;
  }
  // Cached inactive conversations still own queued image resources.
  updateQueue(runtime: RuntimeSnapshot | undefined): void {
    this.queued.update(runtime, this.threadID);
    this.sentEditor.update(runtime, this.threadID);
  }
  update(runtime: RuntimeSnapshot | undefined, threadID: string | null): void {
    const changedThread = this.threadID !== threadID;
    if (!changedThread && runtime?.status.kind === 'connecting' && this.renderedRuntime && this.messages.size) {
      // Keep already-read content visible until the replacement engine publishes
      // authoritative history, but use current connection/queue metadata.
      runtime = { ...runtime, messages: this.renderedRuntime.messages, tools: this.renderedRuntime.tools, subagents: this.renderedRuntime.subagents, ...(this.renderedRuntime.workPeriods ? { workPeriods: this.renderedRuntime.workPeriods } : {}) };
    }
    this.sentEditor.update(runtime, threadID);
    this.backdrop.hidden = !threadID;
    const connection = runtime?.status.kind ?? 'connecting';
    if (this.backdrop.dataset.state !== connection) {
      this.backdrop.dataset.state = connection;
      this.backdrop.setAttribute('aria-label', connection === 'connecting' ? 'Connecting to OMP' : connection === 'ready' ? 'OMP ready' : 'OMP disconnected');
    }
    if (!changedThread && this.renderedRuntime === runtime) {
      if (this.restoringBottom) this.positionBottom(threadID);
      this.work.activate();
      this.scheduleHistory();
      this.hydrated = true;
      return;
    }
    this.renderedRuntime = runtime;
    if (changedThread) {
      this.cancelHistory(); this.initialHistoryPending = true; this.historyStart = 0;
      this.clearTextStreams(false);
      if (threadID) this.node.dataset.threadId = threadID; else delete this.node.dataset.threadId;
      for (const view of this.messages.values()) view.images.dispose();
      this.threadID = threadID; this.messages.clear(); this.tools.clear(); this.activities.clear(); this.responseActions.clear(); this.content.replaceChildren(); this.follow = true; this.hitIndex = -1; this.hydrated = false;
      this.work.clear();
      this.shimmer.clear();
      this.restoringBottom = threadID !== null;
      this.query = ''; this.findInput.value = ''; this.findPresence.setVisible(false, true); this.findFocusOrigin = null;
      this.node.classList.remove('is-finding'); this.hits = []; this.findCount.textContent = ''; this.setJumpVisible(false, true);
    }
    if (!runtime) { this.queued.update(undefined, threadID); this.work.clear(); this.shimmer.clear(); return; }
    if ((this.initialHistoryPending || !this.messages.size) && runtime.messages.length) {
      this.historyStart = this.historyBoundary(runtime, Math.max(0, runtime.messages.length - INITIAL_MESSAGES));
      this.initialHistoryPending = false;
    }
    this.historyStart = Math.min(this.historyStart, Math.max(0, runtime.messages.length - 1));
    const visible: ChatMessage[] = [];
    const advisorBatches = new Map<string, ChatMessage[]>();
    let batch: ChatMessage[] | undefined;
    for (let index = this.historyStart; index < runtime.messages.length; index++) {
      const message = runtime.messages[index];
      if (!message || !transcriptMessage(message)) continue;
      if (advisorMessage(message)) {
        if (batch) { batch.push(message); continue; }
        batch = [message]; advisorBatches.set(message.id, batch);
      } else batch = undefined;
      visible.push(message);
    }
    const loading = this.historyStart > 0;
    if (this.historyLoading.hidden === loading) this.historyLoading.hidden = !loading;
    if (this.content.getAttribute('aria-busy') !== String(loading)) this.content.setAttribute('aria-busy', String(loading));
    const follow = this.follow || this.restoringBottom;
    const liveIDs = new Set(visible.map(message => message.id));
    const scrollPosition = this.scroll.scrollTop;
    for (const [id, view] of this.messages) if (!liveIDs.has(id)) {
      this.sentEditor.remove(id);
      this.stopTextStream(view.body); this.stopTextStream(view.reasoning);
      view.images.dispose(); view.node.remove(); this.messages.delete(id);
    }
    const tools = new Map(runtime.tools.filter(tool => tool.name !== 'todo' && tool.name !== 'set_todos').map(tool => [tool.id, tool]));
    const attached = new Set<string>();
    const activityTools = new Map<ActivityView, ToolActivity[]>();
    const liveActivities = new Set<string | symbol>();
    const staged = document.createDocumentFragment();
    const historicalTools = new Set<string>();
    if (runtime.tools.length) for (let index = 0; index < this.historyStart; index++) for (const id of runtime.messages[index]?.toolIDs ?? []) historicalTools.add(id);
    let activity: ActivityView | null = null;
    for (const message of visible) {
      let view = this.messages.get(message.id);
      const advisors = advisorBatches.get(message.id);
      const advisorsChanged = advisors?.length !== view?.advisors?.length || !!advisors?.some((entry, index) => entry !== view?.advisors?.[index]);
      const changed = view?.value !== message || advisorsChanged;
      const streaming = message.role === 'assistant' && message.isStreaming && this.hydrated;
      if (!view) {
        const node = element('article', message.role === 'user' ? 'message user-message' : 'message agent-message');
        node.dataset.messageId = message.id; node.setAttribute('aria-label', message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'Engine');
        node.dataset.role = message.role;
        const body = element('div', 'markdown'); const reasoning = element('div', 'reasoning markdown');
        reasoning.setAttribute('aria-label', 'Reasoning');
        const error = element('p', 'error-text');
        const images = new MessageImages(this.imageLoaded);
        node.append(reasoning, body, images.node, error); staged.append(node);
        if (message.role === 'user') {
          const messageID = message.id;
          const control = iconButton('copy', 'Copy message', () => {
            if (!threadID) return;
            return copy(() => request({ kind: 'copy-message', id: threadID, messageID }), control);
          }, 'user-message-action user-message-copy');
          const edit = iconButton('edit', 'Edit message', () => {
            const current = this.messages.get(messageID);
            if (!threadID || !current) return;
            this.pauseFollowing();
            this.sentEditor.open({ threadID, message: current.value, node, body, control: edit });
          }, 'user-message-action user-message-edit');
          node.append(edit, control);
        }
        view = { node, body, images, reasoning, error, value: message, advisors }; this.messages.set(message.id, view);
        if (message.text || message.customType) {
          if (!renderBackgroundMessage(body, message, advisors)) this.renderText(body, message.text, streaming && this.hydrated);
        }
        if (message.thinking) this.renderText(reasoning, message.thinking, streaming && this.hydrated);
      } else if (changed) {
        if (advisorsChanged || view.value.text !== message.text || view.value.isStreaming !== message.isStreaming || view.value.role !== message.role || view.value.customType !== message.customType || view.value.details !== message.details) {
          if (!renderBackgroundMessage(view.body, message, advisors)) this.renderText(view.body, message.text, streaming, view.value.isStreaming ? view.value.text : message.text);
          else this.stopTextStream(view.body);
        }
        if (view.value.thinking !== message.thinking || view.value.isStreaming !== message.isStreaming) this.renderText(view.reasoning, message.thinking, streaming, view.value.isStreaming ? view.value.thinking : message.thinking);
        view.value = message;
        view.advisors = advisors;
      }
      if (changed) {
        if (view.reasoning.hidden !== !message.thinking) view.reasoning.hidden = !message.thinking;
        view.images.update(message.images ?? []);
        const bodyHidden = !message.text && !message.customType;
        if (view.body.hidden !== bodyHidden) view.body.hidden = bodyHidden;
        if (view.error.textContent !== (message.error ?? '')) view.error.textContent = message.error;
        if (view.error.hidden !== !message.error) view.error.hidden = !message.error;
        view.node.classList.toggle('streaming', message.isStreaming);
      }
      const toolOnly = toolOnlyMessage(message);
      if (view.node.hidden !== toolOnly) view.node.hidden = toolOnly;
      if (!toolOnly) activity = null;
      if (message.toolIDs.some(id => tools.has(id))) {
        const group: ActivityView = activity ?? this.activities.get(message.id) ?? createActivityView();
        if (!activity) {
          this.activities.set(message.id, group); liveActivities.add(message.id); activityTools.set(group, []);
          if (group.node.previousSibling !== view.node) view.node.after(group.node);
        }
        for (const id of message.toolIDs) {
          const tool = tools.get(id);
          if (!tool) continue;
          this.updateTool(tool, group.list);
          const toolView = this.tools.get(id); if (toolView) toolView.node.dataset.messageId = message.id;
          activityTools.get(group)?.push(tool); attached.add(id);
        }
        activity = group;
      }
    }
    if (this.prepending) this.content.prepend(staged); else this.content.append(staged);
    this.hydrated = true;
    const unattached = [...tools.values()].filter(tool => !attached.has(tool.id) && !historicalTools.has(tool.id));
    if (unattached.length) {
      const group = this.activities.get(ORPHAN_ACTIVITY) ?? createActivityView();
      this.activities.set(ORPHAN_ACTIVITY, group); liveActivities.add(ORPHAN_ACTIVITY); activityTools.set(group, unattached);
      if (group.node.parentElement !== this.content) this.content.append(group.node);
      for (const tool of unattached) this.updateTool(tool, group.list);
    }
    for (const [group, actions] of activityTools) {
      const label = `Activity · ${actions.length} ${actions.length === 1 ? 'action' : 'actions'}`;
      if (group.label.dataset.label !== label) {
        group.label.dataset.label = label; group.label.title = label; group.label.setAttribute('role', 'img'); group.label.setAttribute('aria-label', label);
        group.label.replaceChildren(icon('terminal'));
      }
      const failed = actions.some(tool => tool.state === 'failed');
      const running = actions.findLast(tool => tool.state === 'running') ?? actions.findLast(tool => tool.state === 'pending');
      let latest = actions[0];
      for (const tool of actions) if (!latest || (tool.endedAt ?? tool.startedAt) >= (latest.endedAt ?? latest.startedAt)) latest = tool;
      const shown = running ?? latest;
      const interrupted = actions.some(tool => tool.state === 'interrupted');
      if (!running && !failed && interrupted) {
        if (!group.state) {
          group.state = element('span', 'activity-state interrupted'); group.state.append(icon('circle-x'));
          group.state.setAttribute('role', 'img'); group.state.setAttribute('aria-label', 'Interrupted'); group.state.title = 'Interrupted';
        }
        if (!group.state.parentElement) group.label.parentElement?.append(group.state);
      } else group.state?.remove();
      const status = running ? `Running · ${toolAction(running)}` : failed ? 'Activity ended' : interrupted ? 'Interrupted' : 'Completed';
      group.label.parentElement?.setAttribute('aria-description', status);
      group.current.hidden = !shown;
      const currentAction = shown ? toolAction(shown) : '';
      if (group.current.textContent !== currentAction) group.current.textContent = currentAction;
      this.shimmer.set(group.current, !!running);
      group.current.title = currentAction;
    }
    for (const [id, group] of this.activities) if (!liveActivities.has(id)) { this.shimmer.set(group.current, false); group.node.remove(); this.activities.delete(id); }
    for (const [id, tool] of this.tools) if (!tools.has(id)) { tool.node.remove(); this.tools.delete(id); }
    this.queued.update(runtime, threadID);
    this.work.update(runtime, this.messages);
    this.updateResponseActions(runtime);
    if (!follow) this.scroll.scrollTop = scrollPosition;
    if (this.query) this.refreshFind(false);
    if (follow) this.positionBottom(threadID);
    this.scheduleHistory();
  }
  private stopTextStream(target: HTMLElement): void {
    this.textStreams.get(target)?.destroy();
    this.textStreams.delete(target);
  }
  private clearTextStreams(flush: boolean): void {
    for (const stream of this.textStreams.values()) { if (flush) stream.flush(); else stream.destroy(); }
    this.textStreams.clear();
  }
  private renderText(target: HTMLElement, text: string, streaming: boolean, previousText = text): void {
    const animate = streaming && !this.reducedMotion.matches && !document.hidden;
    if (!animate) {
      this.stopTextStream(target);
      renderMarkdown(target, text);
      return;
    }
    let stream = this.textStreams.get(target);
    if (!stream) {
      if (previousText === text) renderMarkdown(target, text, true);
      stream = new StreamingText(previousText, value => {
        const top = this.scroll.scrollTop;
        renderMarkdown(target, value, this.node.isConnected && !this.reducedMotion.matches && !document.hidden);
        if (this.query) this.refreshFind(false);
        if (this.follow || this.restoringBottom) this.positionBottom(this.threadID);
        else this.scroll.scrollTop = top;
      }, () => this.node.isConnected && !this.reducedMotion.matches && !document.hidden);
      this.textStreams.set(target, stream);
      stream.update(text);
    } else stream.update(text);
  }
  private updateResponseActions(runtime: RuntimeSnapshot): void {
    const live = new Set<string>();
    const activeTools = new Set(runtime.tools.filter(tool => tool.name !== 'todo' && tool.name !== 'set_todos' && (tool.state === 'pending' || tool.state === 'running')).map(tool => tool.id));
    const activeAnchor = runtime.workPeriods?.find(period => period.endedAt === null)?.messageID;
    let activeWork = false, unfinished = false;
    let response: ChatMessage | undefined;
    const finish = (nextUserID: string | null): void => {
      if (!response || unfinished || activeWork) return;
      const responseView = this.messages.get(response.id);
      if (!responseView) return;
      if (nextUserID === null && (isBusy(runtime.status) || runtime.status.kind === 'connecting' || activeTools.size)) return;
      live.add(response.id);
      let actions = this.responseActions.get(response.id);
      if (!actions) {
        const messageID = response.id;
        actions = element('div', 'message-actions response-actions'); actions.dataset.responseId = messageID;
        const control = iconButton('copy', 'Copy response', () => {
          const id = this.threadID; if (!id) return;
          return copy(() => request({ kind: 'copy-message', id, messageID }), control);
        }, 'copy-message');
        actions.append(control); this.responseActions.set(messageID, actions);
      }
      if (actions.parentElement !== responseView.node) responseView.node.append(actions);
    };
    for (const message of runtime.messages) {
      if (!transcriptMessage(message)) continue;
      if (message.role === 'user') { finish(message.id); response = undefined; unfinished = false; }
      if (message.id === activeAnchor) activeWork = true;
      if (message.isStreaming || message.toolIDs.some(id => activeTools.has(id))) unfinished = true;
      if (message.role === 'assistant' && (message.text.trim() || message.images?.length)) response = message;
    }
    finish(null);
    for (const [id, actions] of this.responseActions) if (!live.has(id)) { actions.remove(); this.responseActions.delete(id); }
  }

  private positionBottom(threadID: string | null): void {
    if (!this.node.isConnected || !this.follow && !this.restoringBottom || !this.content.childElementCount && !this.pending.childElementCount) return;
    if (this.restoringBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
    this.setJumpVisible(false);
    if (this.bottomFrame !== null) return;
    this.bottomFrame = requestAnimationFrame(() => {
      this.bottomFrame = null;
      if (!this.node.isConnected || this.threadID !== threadID || !this.follow && !this.restoringBottom) return;
      this.scroll.scrollTop = this.scroll.scrollHeight; this.restoringBottom = false; this.setJumpVisible(false);
    });
  }
  private historyBoundary(runtime: RuntimeSnapshot, start: number): number {
    while (start > 0) {
      const current = runtime.messages[start], previous = runtime.messages[start - 1];
      if (!current || !previous || !toolOnlyMessage(current) || !toolOnlyMessage(previous)) break;
      start--;
    }
    // Do not initially render the tail of an Advisor batch as a separate card.
    let first = start, message = runtime.messages[first];
    while (message && !transcriptMessage(message)) message = runtime.messages[++first];
    if (message && advisorMessage(message)) {
      for (let previous = first - 1; previous >= 0; previous--) {
        const message = runtime.messages[previous];
        if (!message || !transcriptMessage(message)) continue;
        if (!advisorMessage(message)) break;
        start = previous;
      }
    }
    return start;
  }
  private cancelHistory(): void {
    if (this.historyTask !== null) { cancelIdleCallback(this.historyTask); this.historyTask = null; }
  }
  private scheduleHistory(): void {
    if (!this.historyStart || this.historyTask !== null || !this.node.isConnected) return;
    this.historyTask = requestIdleCallback(() => {
      this.historyTask = null;
      const runtime = this.renderedRuntime;
      if (!runtime || !this.node.isConnected) return;
      this.renderHistory(this.historyBoundary(runtime, Math.max(0, this.historyStart - HISTORY_BATCH)));
    }, { timeout: 120 });
  }
  private renderHistory(start: number): void {
    const runtime = this.renderedRuntime;
    if (!runtime) return;
    const following = this.follow;
    const top = following ? 0 : this.scroll.scrollTop, height = following ? 0 : this.scroll.scrollHeight;
    if (following) this.restoringBottom = true;
    this.historyStart = start; this.renderedRuntime = undefined; this.prepending = true;
    try { this.update(runtime, this.threadID); } finally { this.prepending = false; }
    if (!following) this.scroll.scrollTop = top + this.scroll.scrollHeight - height;
  }
  private updateTool(tool: ToolActivity, host: HTMLElement): void {
    let view = this.tools.get(tool.id);
    if (!view) {
      const node = element('details', 'tool'); node.dataset.toolId = tool.id;
      const summary = element('summary'); const detail = element('pre', 'tool-detail'); const input = element('pre', 'tool-input'); const output = element('pre', 'tool-output');
      const detailBlock = element('div', 'tool-block'), outputBlock = element('div', 'tool-block');
      detailBlock.append(detail, input); outputBlock.append(output);
      node.append(summary, detailBlock, outputBlock); host.append(node);
      view = { node, summary, detail, input, output, value: tool }; this.tools.set(tool.id, view);
    } else if (view.node.parentElement !== host) {
      if (view.node.closest<HTMLDetailsElement>('.activity-group')?.open) {
        const nextGroup = host.closest<HTMLDetailsElement>('.activity-group'); if (nextGroup) nextGroup.open = true;
      }
      host.append(view.node);
    }
    if (view.value !== tool || !view.summary.textContent) {
      view.node.classList.toggle('tool-files', FILE_TOOLS[tool.name] === true);
      const duration = tool.endedAt === null ? null : Math.max(0, (tool.endedAt - tool.startedAt) / 1000);
      view.summary.title = duration !== null && duration >= 1 ? `Duration: ${duration.toFixed(1)}s` : '';
      view.summary.setAttribute('aria-description', tool.state);
      view.summary.replaceChildren(toolIcon(tool.name), element('span', tool.name === 'eval' ? 'tool-name tool-purpose' : 'tool-name', tool.name === 'eval' ? toolAction(tool) : toolLabel(tool.name)), element('span', 'tool-target', tool.name === 'eval' ? '' : tool.target), disclosureCaret());
      if (view.detail.textContent !== tool.detail) {
        const existing = view.detail.firstChild;
        if (existing instanceof Text && tool.detail.startsWith(existing.data)) existing.appendData(tool.detail.slice(existing.length));
        else view.detail.textContent = tool.detail;
      }
      const input = tool.input ?? '';
      if (view.input.textContent !== input) {
        const existing = view.input.firstChild;
        if (existing instanceof Text && input.startsWith(existing.data)) existing.appendData(input.slice(existing.length));
        else view.input.textContent = input;
      }
      view.detail.hidden = !tool.detail;
      view.input.hidden = !input;
      if (view.output.textContent !== tool.output) {
        const existing = view.output.firstChild;
        if (existing instanceof Text && tool.output.startsWith(existing.data)) existing.appendData(tool.output.slice(existing.length));
        else view.output.textContent = tool.output;
      }
      if (view.detail.parentElement) view.detail.parentElement.hidden = !tool.detail && !input;
      if (view.output.parentElement) view.output.parentElement.hidden = !tool.output;
      view.value = tool;
    }
  }
  private refreshFind(reset = true): void {
    this.node.classList.toggle('is-finding', !!this.query);
    if (this.query && this.historyStart) {
      this.cancelHistory();
      const query = this.query; this.query = '';
      try { this.renderHistory(0); } finally { this.query = query; }
    }
    const needle = this.query.toLocaleLowerCase(); this.hits = [];
    for (const marked of this.content.querySelectorAll('.find-match')) marked.classList.remove('find-match');
    for (const node of this.content.querySelectorAll<HTMLElement>('.message:not([hidden]), .tool')) {
      const notes = node.querySelectorAll<HTMLElement>('.advisor-notice');
      for (const candidate of notes.length ? notes : [node]) {
        if (!needle || !(candidate.textContent ?? '').toLocaleLowerCase().includes(needle)) continue;
        candidate.classList.add('find-match'); this.hits.push(candidate);
      }
    }
    this.findCount.textContent = needle ? `${this.hits.length} matches` : '';
    if (reset) { this.hitIndex = -1; if (this.hits.length) this.moveHit(1); }
  }
  private moveHit(delta: number): void {
    if (!this.hits.length) return;
    this.hitIndex = (this.hitIndex + delta + this.hits.length) % this.hits.length;
    const hit = this.hits[this.hitIndex];
    if (!hit) return;
    if (hit instanceof HTMLDetailsElement) hit.open = true;
    const needle = this.query.toLocaleLowerCase();
    const candidates = Array.from(hit.querySelectorAll<HTMLElement>('.tool-detail,.tool-input,.tool-output,.result-raw,.result-metadata,.markdown :is(p,li,pre,h1,h2,h3,h4,h5,h6,dt,dd,td,th),.result-fields dt,.result-fields dd,.result-title'));
    const visibleMatch = hit.checkVisibility() && hit.innerText.toLocaleLowerCase().includes(needle);
    const target = candidates.find(node => node.checkVisibility() && node.innerText.toLocaleLowerCase().includes(needle))
      ?? (visibleMatch ? hit : candidates.find(node => (node.textContent ?? '').toLocaleLowerCase().includes(needle)) ?? hit);
    for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    this.follow = false; this.restoringBottom = false;
    target.scrollIntoView({ block: 'center', behavior: 'instant' }); this.setJumpVisible(true);
    this.findCount.textContent = `${this.hitIndex + 1} of ${this.hits.length}`;
  }
}
