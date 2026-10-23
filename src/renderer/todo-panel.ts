import type { RuntimeSnapshot, TodoItem, TodoPhase, TodoStatus } from '../shared/types';
import { activeTodo } from '../shared/todos';
import { element, iconButton } from './dom';
import { renderMarkdown } from './markdown';
import { TextShimmer } from './shimmer';
import { SurfacePresence } from './surface-presence';

const statusLabels: Record<TodoStatus, string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', abandoned: 'Abandoned', blocked: 'Blocked' };
const agentStatuses: Record<string, TodoStatus | undefined> = {
  active: 'in_progress', running: 'in_progress', started: 'in_progress', in_progress: 'in_progress',
  completed: 'completed', succeeded: 'completed', done: 'completed',
  failed: 'blocked', error: 'blocked', blocked: 'blocked',
  abandoned: 'abandoned', aborted: 'abandoned', interrupted: 'abandoned', cancelled: 'abandoned',
};
interface TaskView { node: HTMLLIElement; content: HTMLElement; blocker: HTMLElement; detail: HTMLElement; notes: HTMLElement }
interface PhaseView { node: HTMLElement; heading: HTMLElement; list: HTMLElement; tasks: Map<string, TaskView> }

function place(parent: HTMLElement, node: HTMLElement, index: number): void {
  const current = parent.children[index];
  if (current !== node) parent.insertBefore(node, current ?? null);
}
function setText(node: HTMLElement, value: string): void { if (node.textContent !== value) node.textContent = value; }

export class TodoPanel {
  readonly node = element('aside', 'todo-panel');
  readonly rail = element('div', 'activity-rail');
  private readonly agents = element('aside', 'agents-panel');
  private readonly agentList = element('div', 'agents-list');
  private readonly agentViews = new Map<string, { node: HTMLDetailsElement; summary: HTMLElement; title: HTMLElement; detail: HTMLElement }>();
  readonly toggle = iconButton('tasks', 'Tasks', () => this.setCollapsed(this.taskPresence.visible), 'todo-toggle');
  readonly controls = element('div', 'activity-controls');
  private readonly agentCollapsed = new Map<string, boolean>();
  private readonly agentOpen = new Map<string, Set<string>>();
  private readonly agentToggle = iconButton('agents', 'Agents', () => {
    if (!this.threadID) return;
    const collapsed = this.agentPresence.visible;
    this.agentCollapsed.set(this.threadID, collapsed);
    this.present();
    if (collapsed) this.agentToggle.focus();
  }, 'agent-toggle');
  private readonly heading = element('h2', '', 'Tasks');
  private readonly list = element('div', 'todo-phases');
  private readonly collapsed = new Map<string, boolean>();
  private readonly phaseViews = new Map<string, PhaseView>();
  private readonly taskPresence = new SurfacePresence(this.node);
  private readonly agentPresence = new SurfacePresence(this.agents);
  private readonly taskTogglePresence = new SurfacePresence(this.toggle);
  private readonly agentTogglePresence = new SurfacePresence(this.agentToggle);
  private readonly observer: ResizeObserver;
  private threadID: string | null = null;
  private compact = false;
  private phaseSignature = '';
  private hasTasks = false;
  private disposed = false;
  private readonly shimmer = new TextShimmer();

  constructor(private readonly main: HTMLElement, private readonly composer: HTMLElement) {
    this.node.id = 'todo-panel'; this.heading.id = 'todo-panel-title';
    this.node.setAttribute('aria-labelledby', this.heading.id);
    this.toggle.setAttribute('aria-controls', this.node.id);
    const header = element('div', 'todo-header');
    header.append(this.heading);
    this.node.append(header, this.list);
    this.agents.setAttribute('aria-label', 'Agents');
    this.agents.id = 'agents-panel';
    this.agentToggle.setAttribute('aria-controls', this.agents.id);
    this.controls.append(this.toggle, this.agentToggle);
    this.agents.append(element('h2', '', 'Agents'), this.agentList);
    this.rail.append(this.node, this.agents);
    this.compact = main.clientWidth < 880;
    this.present(true);
    this.observer = new ResizeObserver(() => {
      if (this.disposed) return;
      this.compact = main.clientWidth < 880;
      this.present();
      this.position();
    });
    this.observer.observe(main); this.observer.observe(composer);
  }

  update(runtime: RuntimeSnapshot | undefined, threadID: string | null): void {
    if (this.disposed) return;
    const ownedFocus = this.rail.contains(document.activeElement) || this.controls.contains(document.activeElement);
    const sameThread = this.threadID === threadID;
    if (!sameThread && this.threadID) {
      this.agentOpen.set(this.threadID, new Set([...this.agentViews].filter(([, view]) => view.node.open).map(([id]) => id)));
    }
    this.threadID = threadID;
    if (!sameThread) {
      this.taskPresence.setVisible(false, true); this.agentPresence.setVisible(false, true);
      this.shimmer.clear(); this.phaseViews.clear(); this.list.replaceChildren();
      this.agentViews.clear(); this.agentList.replaceChildren();
    }
    const agents = threadID ? runtime?.subagents ?? [] : [];
    const ids = new Set(agents.map(agent => agent.id));
    for (const [id, view] of this.agentViews) if (!ids.has(id)) { this.shimmer.set(view.title, false); view.node.remove(); this.agentViews.delete(id); }
    for (const [index, agent] of agents.entries()) {
      let view = this.agentViews.get(agent.id);
      if (!view) {
        const node = element('details', 'subagent'); node.dataset.subagentId = agent.id;
        node.open = !!threadID && (this.agentOpen.get(threadID)?.has(agent.id) ?? false);
        const summary = element('summary', 'subagent-summary todo-item');
        const title = element('span', 'subagent-title todo-content');
        const text = element('div', 'todo-item-text'); text.append(title);
        const detail = element('div', 'subagent-detail markdown');
        summary.append(text); node.append(summary, detail);
        view = { node, summary, title, detail }; this.agentViews.set(agent.id, view);
      }
      place(this.agentList, view.node, index);
      setText(view.title, agent.title);
      const status = agentStatuses[agent.status] ?? 'pending';
      const running = status === 'in_progress';
      view.summary.dataset.status = status; view.summary.classList.toggle('is-active', running);
      this.shimmer.set(view.title, running);
      if (agent.messageID) view.node.dataset.messageId = agent.messageID; else delete view.node.dataset.messageId;
      view.summary.setAttribute('aria-description', agent.status);
      view.summary.title = agent.status;
      if (view.detail.dataset.value !== agent.detail) {
        view.detail.dataset.value = agent.detail; renderMarkdown(view.detail, agent.detail);
      }
      view.detail.hidden = !agent.detail;
    }
    this.agentToggle.title = `Agents · ${agents.length}`; this.agentToggle.setAttribute('aria-label', this.agentToggle.title);
    this.compact = this.main.clientWidth < 880;
    const phases = threadID ? runtime?.todoPhases ?? [] : [];
    this.hasTasks = phases.some(phase => phase.tasks.length > 0);
    const signature = JSON.stringify(phases);
    if (!sameThread || signature !== this.phaseSignature) {
      this.phaseSignature = signature;
      this.renderPhases(phases);
    }
    this.present(!sameThread);
    if (ownedFocus && (document.activeElement === document.body || document.activeElement?.closest('[inert]'))) {
      const target = this.hasTasks ? this.toggle : this.agentViews.size ? this.agentToggle : this.composer.querySelector<HTMLElement>('textarea:not(:disabled),input:not(:disabled),button:not(:disabled)');
      if (!target?.closest('[inert]')) target?.focus({ preventScroll: true });
    }
    this.position();
  }

  private setCollapsed(collapsed: boolean): void {
    if (!this.threadID) return;
    this.collapsed.set(this.threadID, collapsed);
    this.present();
    if (collapsed) this.toggle.focus();
  }

  private present(instant = false): void {
    const tasksExpanded = this.hasTasks && !(this.threadID ? this.collapsed.get(this.threadID) ?? this.compact : true);
    const hasAgents = this.agentViews.size > 0;
    const agentsExpanded = hasAgents && !(this.threadID ? this.agentCollapsed.get(this.threadID) ?? this.compact : true);
    if (!tasksExpanded && this.node.contains(document.activeElement) && this.hasTasks) this.toggle.focus();
    if (!agentsExpanded && this.agents.contains(document.activeElement) && hasAgents) this.agentToggle.focus();
    this.taskPresence.setVisible(tasksExpanded, instant);
    this.agentPresence.setVisible(agentsExpanded, instant);
    this.taskTogglePresence.setVisible(this.hasTasks, instant);
    this.agentTogglePresence.setVisible(hasAgents, instant);
    this.toggle.setAttribute('aria-expanded', String(tasksExpanded));
    this.agentToggle.setAttribute('aria-expanded', String(agentsExpanded));
    this.main.classList.toggle('has-open-activity', tasksExpanded || agentsExpanded);
    this.main.classList.toggle('todo-compact', this.compact);
  }
  private position(): void {
    if (!this.hasTasks && this.agentViews.size === 0) return;
    const bottom = `${Math.max(12, this.main.getBoundingClientRect().bottom - this.composer.getBoundingClientRect().top + 12)}px`;
    if (this.main.style.getPropertyValue('--todo-bottom') !== bottom) this.main.style.setProperty('--todo-bottom', bottom);
  }

  private renderPhases(phases: TodoPhase[]): void {
    const active = activeTodo(phases);
    const visiblePhases = phases.filter(phase => phase.tasks.length > 0);
    const phaseKeys = new Set<string>();
    const phaseOccurrences = new Map<string, number>();
    for (const [phaseIndex, phase] of visiblePhases.entries()) {
      const occurrence = phaseOccurrences.get(phase.name) ?? 0;
      phaseOccurrences.set(phase.name, occurrence + 1);
      const key = `${phase.name}\0${occurrence}`;
      phaseKeys.add(key);
      let view = this.phaseViews.get(key);
      if (!view) {
        const node = element('section', 'todo-phase'), heading = element('h3'), list = element('ul', 'todo-items');
        node.append(heading, list); view = { node, heading, list, tasks: new Map() }; this.phaseViews.set(key, view);
      }
      place(this.list, view.node, phaseIndex);
      setText(view.heading, phase.name);
      view.heading.hidden = visiblePhases.length === 1 && phase.name.trim().toLocaleLowerCase() === 'tasks';
      const taskKeys = new Set<string>();
      const taskOccurrences = new Map<string, number>();
      for (const [taskIndex, task] of phase.tasks.entries()) {
        const taskOccurrence = taskOccurrences.get(task.content) ?? 0;
        taskOccurrences.set(task.content, taskOccurrence + 1);
        const taskKey = `${task.content}\0${taskOccurrence}`;
        taskKeys.add(taskKey);
        let row = view.tasks.get(taskKey);
        if (!row) { row = this.createTask(); view.tasks.set(taskKey, row); }
        place(view.list, row.node, taskIndex);
        this.updateTask(row, task, task === active);
      }
      for (const [taskKey, row] of view.tasks) if (!taskKeys.has(taskKey)) {
        this.shimmer.set(row.content, false); row.node.remove(); view.tasks.delete(taskKey);
      }
    }
    for (const [key, view] of this.phaseViews) if (!phaseKeys.has(key)) {
      for (const row of view.tasks.values()) this.shimmer.set(row.content, false);
      view.node.remove(); this.phaseViews.delete(key);
    }
  }

  private createTask(): TaskView {
    const node = element('li', 'todo-item'), text = element('div', 'todo-item-text');
    const content = element('span', 'todo-content'), blocker = element('span', 'todo-blocker muted');
    const detail = element('span', 'todo-detail muted'), notes = element('span', 'todo-notes muted');
    text.append(content, blocker, detail, notes); node.append(text);
    return { node, content, blocker, detail, notes };
  }
  private updateTask(view: TaskView, task: TodoItem, active: boolean): void {
    view.node.dataset.status = task.status; view.node.classList.toggle('is-active', active);
    if (task.status === 'in_progress') view.node.setAttribute('aria-current', 'step'); else view.node.removeAttribute('aria-current');
    setText(view.content, task.content);
    this.shimmer.set(view.content, task.status === 'in_progress');
    setText(view.blocker, task.blocker ?? ''); view.blocker.hidden = task.status !== 'blocked' || !task.blocker;
    setText(view.detail, task.details ?? ''); view.detail.hidden = !task.details;
    setText(view.notes, task.notes?.join('\n') ?? ''); view.notes.hidden = !task.notes?.length;
    view.node.setAttribute('aria-description', statusLabels[task.status]); view.node.title = statusLabels[task.status];
  }

  dispose(): void {
    this.disposed = true; this.observer.disconnect(); this.shimmer.clear();
    this.taskPresence.dispose(); this.agentPresence.dispose(); this.taskTogglePresence.dispose();
    this.agentTogglePresence.dispose();
    this.phaseViews.clear(); this.agentViews.clear(); this.collapsed.clear(); this.agentCollapsed.clear(); this.agentOpen.clear();
    this.main.classList.remove('has-open-activity', 'todo-compact');
    this.main.style.removeProperty('--todo-bottom');
  }
}
