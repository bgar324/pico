import type { RuntimeSnapshot, WorkPeriod } from '../shared/types';
import { isBusy } from '../shared/types';
import { element } from './dom';
import { TextShimmer } from './shimmer';

interface WorkView { node: HTMLElement; duration: HTMLElement; period: WorkPeriod }

/** Renders observed runtime clocks. It never infers durations from old history. */
export class WorkProgress {
  private readonly views = new Map<string, WorkView>();
  private readonly thinking = element('div', 'work-thinking');
  private readonly thinkingText = element('span', '', 'Thinking');
  private readonly shimmer = new TextShimmer();
  private active: WorkView | undefined;
  private timer: number | undefined;

  constructor(private readonly content: HTMLElement) {
    this.thinking.setAttribute('role', 'status');
    this.thinking.setAttribute('aria-live', 'polite');
    this.thinking.append(this.thinkingText);
  }

  update(runtime: RuntimeSnapshot | undefined, messages: ReadonlyMap<string, { node: HTMLElement }>): void {
    if (!runtime) { this.clear(); return; }
    const periods = runtime.workPeriods ?? [];
    const ids = new Set(periods.map(period => period.id));
    for (const [id, view] of this.views) if (!ids.has(id)) { view.node.remove(); this.views.delete(id); }
    if (this.thinking.parentElement === this.content && this.thinking.nextSibling) this.content.append(this.thinking);
    this.active = undefined;
    const now = Date.now();
    for (const period of periods) {
      let view = this.views.get(period.id);
      if (!view) {
        const node = element('div', 'work-period'); node.dataset.workId = period.id;
        const duration = element('div', 'work-duration'); duration.setAttribute('role', 'timer'); duration.setAttribute('aria-live', 'off');
        node.append(duration, element('hr', 'work-divider'));
        view = { node, duration, period }; this.views.set(period.id, view);
      }
      view.period = period;
      this.updateDuration(view, now);
      const anchor = period.messageID ? messages.get(period.messageID)?.node : undefined;
      if (anchor) {
        if (view.node.previousSibling !== anchor) anchor.after(view.node);
      } else if (period.messageID === null && period.endedAt === null) {
        const end = this.thinking.parentElement === this.content ? this.thinking : null;
        if (view.node.parentElement !== this.content || view.node.nextSibling !== end) this.content.insertBefore(view.node, end);
      } else view.node.remove();
      if (period.endedAt === null) this.active = view;
    }
    const busy = isBusy(runtime.status);
    const activeTool = runtime.tools.some(tool => tool.name !== 'todo' && tool.name !== 'set_todos' && (tool.state === 'running' || tool.state === 'pending'));
    const streamingContent = runtime.messages.some(message => message.role === 'assistant' && message.isStreaming && !!(message.text.trim() || message.thinking.trim()));
    if (busy && !activeTool && !streamingContent) {
      const activity = runtime.status.kind === 'ready' ? runtime.status.activity : 'idle';
      const label = runtime.dialogs.length ? 'Waiting for your response' : activity === 'background' ? 'Waiting for background work' : activity === 'stopping' ? 'Stopping' : 'Thinking';
      if (this.thinkingText.textContent !== label) this.thinkingText.textContent = label;
      if (this.thinking.parentElement !== this.content || this.thinking.nextSibling) this.content.append(this.thinking);
      this.shimmer.set(this.thinkingText, true);
    } else { this.shimmer.clear(); this.thinking.remove(); }
    this.syncTimer();
  }

  activate(): void {
    if (this.active) this.updateDuration(this.active, Date.now());
    this.syncTimer();
  }

  clear(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined; this.active = undefined;
    for (const view of this.views.values()) view.node.remove();
    this.views.clear(); this.thinking.remove();
    this.shimmer.clear();
  }

  private updateDuration(view: WorkView, now: number): void {
    const seconds = Math.max(0, Math.floor(((view.period.endedAt ?? now) - view.period.startedAt) / 1000));
    const label = `${view.period.endedAt === null ? 'Working' : 'Worked'} for ${seconds}s`;
    if (view.duration.textContent !== label) view.duration.textContent = label;
  }

  private syncTimer(): void {
    const active = this.active?.period.endedAt === null && this.content.isConnected;
    if (active && this.timer === undefined) {
      this.timer = window.setInterval(() => {
        if (!this.content.isConnected || !this.active) {
          window.clearInterval(this.timer); this.timer = undefined; return;
        }
        this.updateDuration(this.active, Date.now());
      }, 1000);
    } else if (!active && this.timer !== undefined) {
      window.clearInterval(this.timer); this.timer = undefined;
    }
  }
}
