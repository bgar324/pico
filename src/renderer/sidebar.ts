import type { AppInfo, AppRequest, Project, RuntimeSnapshot, ThreadRecord } from '../shared/types';
import { isBusy } from '../shared/types';
import { displaySessionTitle } from '../shared/titles';
import { button, element, errorText, iconButton, Modal, request } from './dom';
import { fuzzyScore, sortedThreads } from './helpers';
import { SidebarMotion } from './sidebar-motion';
import { SidebarTitles } from './sidebar-titles';
import { icon, statusIcon } from './icons';

interface ProjectView {
  node: HTMLElement; toggle: HTMLButtonElement; folder: HTMLElement; label: HTMLElement; labelViewport: HTMLElement;
  menu: HTMLButtonElement; compose: HTMLButtonElement; status: HTMLElement; threads: HTMLElement; content: HTMLElement; list: HTMLElement;
  empty: HTMLElement; more: HTMLButtonElement; all: boolean; order: string[]; value: Project;
}
interface ThreadView {
  node: HTMLElement; title: HTMLButtonElement; label: HTMLElement; labelViewport: HTMLElement;
  status: HTMLElement; menu: HTMLButtonElement; value: ThreadRecord;
}
interface SidebarMenu { anchor: HTMLElement; row: HTMLElement | null; previousFocus: Element | null }

export class Sidebar {
  readonly node = element('aside', 'sidebar');
  private readonly clip = element('div', 'sidebar-clip');
  private readonly content = element('div', 'sidebar-content');
  private readonly list = element('nav', 'sidebar-list');
  private readonly projectList = element('div', 'sidebar-projects');
  readonly resize = element('div', 'sidebar-resize');
  private readonly motion = new SidebarMotion(this.node);
  private readonly titles = new SidebarTitles();
  private readonly scrollObserver = new ResizeObserver(() => this.updateScrollFade());
  private app: AppInfo | null = null;
  private runtimes = new Map<string, RuntimeSnapshot>();
  private menu: SidebarMenu | null = null;
  private expanded = new Map<string, boolean>();
  private signature = '';
  private readonly projects = new Map<string, ProjectView>();
  private readonly threads = new Map<string, ThreadView>();
  private readonly empty = element('p', 'sidebar-empty muted', 'No projects');
  constructor(private readonly onError: (text: string) => void, private readonly settings: () => void, private readonly toggleProject: (id: string, expanded: boolean) => void, private readonly changes: () => void) {
    this.node.id = 'app-sidebar'; this.node.setAttribute('aria-label', 'Projects');
    const top = element('div', 'sidebar-top');
    const open = button('', () => this.perform({ kind: 'open-project' }), 'icon-button open-project');
    open.append(icon('plus')); open.setAttribute('aria-label', 'Open folder'); open.title = 'Open folder'; open.dataset.testid = 'open-project';
    top.append(element('span', 'projects-label', 'Projects'), open);
    const bottom = element('div', 'sidebar-bottom');
    const settingsButton = button('', settings, 'icon-button');
    settingsButton.append(icon('settings')); settingsButton.setAttribute('aria-label', 'Settings'); settingsButton.title = 'Settings'; settingsButton.dataset.testid = 'settings';
    bottom.append(settingsButton);
    this.list.append(this.projectList); this.content.append(top, this.list, bottom); this.clip.append(this.content); this.node.append(this.clip, this.resize);
    this.scrollObserver.observe(this.list); this.scrollObserver.observe(this.projectList);
    this.list.addEventListener('scroll', () => this.updateScrollFade(), { passive: true });
    this.resize.setAttribute('role', 'separator'); this.resize.setAttribute('aria-orientation', 'vertical'); this.resize.tabIndex = 0; this.resize.setAttribute('aria-label', 'Sidebar width');
    this.node.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); this.node.classList.add('drop-target'); } });
    this.node.addEventListener('dragleave', () => this.node.classList.remove('drop-target'));
    this.node.addEventListener('drop', event => { event.preventDefault(); this.node.classList.remove('drop-target'); const files = Array.from(event.dataTransfer?.files ?? []); for (const path of window.pi.pathsFromDrop(files)) void this.perform({ kind: 'add-project', path }); });
    this.node.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      if (!(event.target instanceof Element)) return;
      const menu = event.target.closest('.project-row, .thread-row')?.querySelector<HTMLButtonElement>('.row-menu');
      if (menu) { event.preventDefault(); event.stopPropagation(); menu.click(); }
    });
  }
  update(app: AppInfo, runtimes: Map<string, RuntimeSnapshot>): void {
    this.app = app; this.runtimes = runtimes;
    // Drafts, timestamps and streaming status must never replace pointer targets.
    const signature = JSON.stringify([app.manifest.projects, app.manifest.selectedThreadID, app.manifest.threads.map(thread => [thread.id, thread.projectPath, thread.displayTitle])]);
    if (signature !== this.signature) { this.signature = signature; this.render(); }
    this.updateThreadState();
  }
  setVisible(visible: boolean, animated = true): void {
    this.motion.setVisible(visible, animated);
    this.node.toggleAttribute('data-collapsed', !visible);
    this.content.inert = !visible; this.content.setAttribute('aria-hidden', String(!visible));
    this.resize.tabIndex = visible ? 0 : -1;
    if (!visible) this.closeMenu();
  }
  dispose(): void {
    this.closeMenu(); this.motion.clear(); this.titles.clear(); this.scrollObserver.disconnect();
  }
  private updateScrollFade(): void {
    this.list.style.setProperty('--sidebar-top-fade', this.list.scrollTop > 1 ? '16px' : '0px');
    this.list.style.setProperty('--sidebar-bottom-fade', this.list.scrollHeight - this.list.clientHeight - this.list.scrollTop > 1 ? '16px' : '0px');
  }
  private render(): void {
    if (!this.app) return;
    const manifest = this.app.manifest, scroll = this.list.scrollTop;
    const projectIDs = new Set(manifest.projects.map(project => project.id));
    const projectPaths = new Set(manifest.projects.map(project => project.path));
    const threadIDs = new Set(manifest.threads.filter(thread => projectPaths.has(thread.projectPath)).map(thread => thread.id));
    for (const [id, view] of this.projects) if (!projectIDs.has(id)) {
      if (view.node.contains(document.activeElement)) (view.node.nextElementSibling?.querySelector<HTMLElement>('.project-name') ?? view.node.previousElementSibling?.querySelector<HTMLElement>('.project-name') ?? this.node.querySelector<HTMLElement>('.open-project'))?.focus();
      this.motion.removeFolder(view.threads); this.titles.untrack(view.labelViewport); view.node.remove(); this.projects.delete(id); this.expanded.delete(id);
    }
    for (const [id, view] of this.threads) if (!threadIDs.has(id)) {
      if (view.node.contains(document.activeElement)) (view.node.nextElementSibling?.querySelector<HTMLElement>('button') ?? view.node.previousElementSibling?.querySelector<HTMLElement>('button') ?? view.node.closest('.project-group')?.querySelector<HTMLElement>('.project-name'))?.focus();
      this.titles.untrack(view.labelViewport); view.node.remove(); this.threads.delete(id);
    }
    const groups: HTMLElement[] = [];
    for (const project of manifest.projects) {
      let view = this.projects.get(project.id);
      if (!view) { view = this.createProject(project); this.projects.set(project.id, view); }
      view.value = project;
      const name = project.path.split('/').filter(Boolean).at(-1) ?? project.path;
      if (view.label.textContent !== name) view.label.textContent = name;
      view.toggle.title = project.path;
      view.menu.title = `${name} actions`; view.menu.setAttribute('aria-label', view.menu.title);
      view.compose.title = `New thread in ${name}`; view.compose.setAttribute('aria-label', view.compose.title);
      const open = this.expanded.get(project.id) ?? project.expanded;
      if (view.toggle.getAttribute('aria-expanded') !== String(open)) {
        view.folder.replaceChildren(icon(open ? 'project-folder-open' : 'project-folder'));
        view.toggle.setAttribute('aria-expanded', String(open));
      }
      if (!open && view.threads.contains(document.activeElement)) view.toggle.focus({ preventScroll: true });
      const records = sortedThreads(manifest.threads.filter(thread => thread.projectPath === project.path));
      const known = new Set(view.order), live = new Set(records.map(thread => thread.id));
      // New chats enter at the top; background activity never shuffles existing chats.
      view.order = [...records.filter(thread => !known.has(thread.id)).map(thread => thread.id), ...view.order.filter(id => live.has(id))];
      for (const thread of records) {
        let row = this.threads.get(thread.id);
        if (!row) { row = this.createThread(thread); this.threads.set(thread.id, row); }
        row.value = thread;
        const label = displaySessionTitle(thread.displayTitle) || 'Untitled thread';
        if (row.label.textContent !== label) row.label.textContent = label;
        row.title.title = `${label}\n${thread.projectPath}`;
        row.menu.title = `${label} actions`; row.menu.setAttribute('aria-label', row.menu.title);
      }
      const visibleIDs = view.all ? view.order : view.order.slice(0, 5);
      if (!view.all && manifest.selectedThreadID && view.order.includes(manifest.selectedThreadID) && !visibleIDs.includes(manifest.selectedThreadID)) visibleIDs.push(manifest.selectedThreadID);
      const visibleRows = visibleIDs.flatMap(id => { const row = this.threads.get(id); return row ? [row] : []; });
      this.syncChildren(view.list, visibleRows.map(row => row.node));
      for (const row of visibleRows) this.titles.track(row.labelViewport, row.label);
      view.empty.hidden = records.length !== 0; view.more.hidden = records.length <= 5;
      view.more.textContent = view.all ? 'Show less' : 'Show more';
      this.motion.setFolder(view.threads, view.content, open);
      groups.push(view.node);
    }
    this.syncChildren(this.projectList, groups.length ? groups : [this.empty]);
    for (const view of this.projects.values()) this.titles.track(view.labelViewport, view.label);
    this.list.scrollTop = scroll;
    if (this.menu && (!this.menu.anchor.isConnected || this.menu.anchor.closest('[inert], [hidden]'))) this.closeMenu();
  }
  private syncChildren(parent: HTMLElement, nodes: HTMLElement[]): void {
    for (const [index, node] of nodes.entries()) if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
    while (parent.children.length > nodes.length) parent.lastElementChild?.remove();
  }
  private updateThreadState(): void {
    for (const [id, view] of this.threads) {
      const selected = this.app?.manifest.selectedThreadID === id;
      view.node.classList.toggle('selected', selected);
      if (selected) view.title.setAttribute('aria-current', 'page'); else view.title.removeAttribute('aria-current');
      const runtime = this.runtimes.get(id);
      const state = runtime?.dialogs.length ? 'needs-input' : runtime && isBusy(runtime.status) ? runtime.status.kind === 'ready' && runtime.status.activity === 'background' ? 'background' : 'running' : 'idle';
      if (view.status.dataset.state === state) continue;
      const label = state === 'needs-input' ? 'Needs input' : state === 'background' ? 'Background' : state === 'running' ? 'Running' : 'Idle';
      view.status.dataset.state = state; view.status.title = label;
      view.status.setAttribute('aria-label', label); view.status.setAttribute('aria-hidden', String(state === 'idle'));
      view.status.replaceChildren(...(state === 'running' || state === 'background' ? [statusIcon('running')] : []));
    }
    for (const view of this.projects.values()) {
      view.status.hidden = !view.order.some(id => {
        const state = this.threads.get(id)?.status.dataset.state;
        return state === 'running' || state === 'background';
      });
    }
  }
  private createProject(project: Project): ProjectView {
    const node = element('section', 'project-group'), row = element('div', 'project-row');
    const threads = element('div', 'project-threads'), content = element('div', 'project-threads-content'), list = element('div', 'project-thread-list');
    const toggle = button('', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      this.expanded.set(view.value.id, open); this.toggleProject(view.value.id, open); this.render();
    }, 'project-name');
    threads.id = `project-threads-${project.id}`; toggle.setAttribute('aria-controls', threads.id);
    const folder = element('span', 'project-icon'); folder.append(icon('project-folder'));
    const labelViewport = element('span', 'sidebar-title'), label = element('span', 'sidebar-title-content'); labelViewport.append(label);
    toggle.append(folder, labelViewport); toggle.dataset.sidebarFocus = `project-${project.id}`;
    const actions: Array<[string, () => void | Promise<void>]> = [
      ['Working tree changes', this.changes],
      ['Reveal in Finder', () => this.perform({ kind: 'reveal-project', path: view.value.path })],
      ['Locate folder…', () => this.perform({ kind: 'locate-project', path: view.value.path })],
      ['Remove from sidebar', () => this.perform({ kind: 'remove-project', id: view.value.id })],
    ];
    const menu = button('', () => this.showMenu(menu, actions), 'icon-button row-menu');
    menu.append(icon('sidebar-more')); menu.setAttribute('aria-haspopup', 'menu'); menu.dataset.sidebarFocus = `project-menu-${project.id}`;
    const compose = button('', () => this.perform({ kind: 'new-thread', projectPath: view.value.path }), 'icon-button');
    compose.append(icon('sidebar-compose')); compose.dataset.testid = 'new-thread'; compose.dataset.sidebarFocus = `project-compose-${project.id}`;
    const status = element('span', 'project-status'); status.hidden = true;
    status.setAttribute('role', 'img'); status.setAttribute('aria-label', 'Running threads'); status.title = 'Running threads';
    status.append(statusIcon('running'));
    const controls = element('div', 'project-actions'); controls.append(menu, compose);
    row.tabIndex = -1; row.append(toggle, status, controls); row.addEventListener('contextmenu', event => { event.preventDefault(); void this.showMenu(row, actions); });
    const empty = element('div', 'project-empty', 'No chats');
    const more = button('Show more', () => { view.all = !view.all; this.render(); }, 'project-show-more');
    content.append(list, empty, more); threads.append(content); node.append(row, threads);
    const view: ProjectView = { node, toggle, folder, label, labelViewport, menu, compose, status, threads, content, list, empty, more, all: false, order: [], value: project };
    return view;
  }
  private createThread(thread: ThreadRecord): ThreadView {
    const row = element('div', 'thread-row');
    const title = button('', () => this.perform({ kind: 'select-thread', id: thread.id }), 'thread-title');
    const labelViewport = element('span', 'sidebar-title'), label = element('span', 'sidebar-title-content'); labelViewport.append(label); title.append(labelViewport);
    title.dataset.threadId = thread.id; title.dataset.sidebarFocus = `thread-${thread.id}`;
    const status = element('span', 'thread-status'); status.setAttribute('role', 'img');
    const actions: Array<[string, () => void | Promise<void>]> = [['Rename…', () => this.rename(view.value)], ['Reopen thread', () => this.perform({ kind: 'select-thread', id: thread.id, reopen: true })], ['Open in Terminal', () => this.perform({ kind: 'terminal', id: thread.id })], ['Reveal session', () => this.perform({ kind: 'reveal-session', id: thread.id })], ['Delete thread…', () => this.perform({ kind: 'delete-thread', id: thread.id })]];
    actions.splice(4, 0, ['Session statistics', () => {
      const modal = new Modal('Session statistics', () => modal.close());
      const output = element('pre', 'session-statistics', 'Loading…');
      const refresh = iconButton('refresh', 'Refresh', async () => {
        refresh.disabled = true;
        try { const value = await request({ kind: 'session-stats', id: thread.id }); output.textContent = value === null ? 'OMP returned no session statistics.' : JSON.stringify(value, null, 2); }
        catch (error) { output.textContent = errorText(error); }
        finally { refresh.disabled = false; }
      });
      modal.body.append(output); modal.footer.append(iconButton('close', 'Close', () => modal.close()), refresh); refresh.click();
    }]);
    const menu = button('', () => this.showMenu(menu, actions), 'icon-button row-menu thread-menu'); menu.append(icon('sidebar-more')); menu.setAttribute('aria-label', `${displaySessionTitle(thread.displayTitle)} actions`); menu.setAttribute('aria-haspopup', 'menu'); menu.dataset.sidebarFocus = `thread-menu-${thread.id}`;
    const rail = element('div', 'thread-actions'); rail.append(menu); row.append(title, status, rail);
    row.tabIndex = -1; row.addEventListener('contextmenu', event => { event.preventDefault(); void this.showMenu(row, actions); });
    const view: ThreadView = { node: row, title, label, labelViewport, status, menu, value: thread };
    return view;
  }
  private async showMenu(anchor: HTMLElement, actions: Array<[string, () => void | Promise<void>]>): Promise<void> {
    if (this.menu?.anchor === anchor) { this.closeMenu(); return; }
    this.closeMenu();
    const menu: SidebarMenu = { anchor, row: anchor.closest('.project-row, .thread-row'), previousFocus: document.activeElement };
    this.menu = menu; anchor.setAttribute('aria-expanded', 'true'); menu.row?.classList.add('menu-open');
    try {
      const selected = await request({ kind: 'context-menu', items: actions.map(([label]) => label) });
      if (this.menu !== menu) return;
      this.menu = null; anchor.setAttribute('aria-expanded', 'false'); menu.row?.classList.remove('menu-open');
      if (menu.previousFocus instanceof HTMLElement && menu.previousFocus.isConnected && !menu.previousFocus.closest('[inert]')) menu.previousFocus.focus({ preventScroll: true });
      if (selected !== null) {
        if (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 0 || selected >= actions.length) throw new Error('Invalid sidebar action.');
        await actions[selected]?.[1]();
      }
    } catch (error) { this.onError(errorText(error)); }
    finally {
      if (this.menu === menu) { this.menu = null; anchor.setAttribute('aria-expanded', 'false'); menu.row?.classList.remove('menu-open'); }
    }
  }
  private closeMenu(): void {
    if (!this.menu) return;
    this.menu.anchor.setAttribute('aria-expanded', 'false'); this.menu.row?.classList.remove('menu-open'); this.menu = null;
    void request({ kind: 'close-context-menu' }).catch(error => this.onError(errorText(error)));
  }
  rename(thread: ThreadRecord): void {
    const modal = new Modal('Rename thread', () => modal.close()); const input = element('input'); input.value = displaySessionTitle(thread.displayTitle); input.setAttribute('aria-label', 'Thread title'); const error = element('p', 'error-text'); modal.body.append(input, error);
    const save = iconButton('save', 'Save', async () => { if (!input.value.trim()) { error.textContent = 'Enter a thread title.'; return; } save.disabled = true; try { await request({ kind: 'rename-thread', id: thread.id, title: input.value.trim() }); modal.close(); } catch (failure) { error.textContent = errorText(failure); save.disabled = false; } }, 'primary');
    modal.footer.append(iconButton('close', 'Cancel', () => modal.close()), save); input.addEventListener('keydown', event => { if (event.key === 'Enter') save.click(); }); queueMicrotask(() => input.select());
  }
  private async perform(value: AppRequest): Promise<void> { try { await request(value); } catch (error) { this.onError(errorText(error)); } }
  quickSwitcher(): void {
    if (!this.app) return;
    const app = this.app; const modal = new Modal('Switch thread or project', () => modal.close()); modal.node.classList.add('quick-switcher');
    const input = element('input'); input.placeholder = 'Search threads and projects'; input.setAttribute('aria-label', 'Search threads and projects');
    const results = element('div', 'switcher-results'); results.setAttribute('role', 'listbox'); const entries = [
      ...app.manifest.threads.map(thread => ({ id: thread.id, title: displaySessionTitle(thread.displayTitle) || 'Untitled thread', path: thread.projectPath, request: { kind: 'select-thread', id: thread.id } satisfies AppRequest })),
      ...app.manifest.projects.map(project => ({ id: project.id, title: project.path.split('/').at(-1) ?? project.path, path: project.path, request: { kind: 'new-thread', projectPath: project.path } satisfies AppRequest })),
    ];
    let selected = 0; let matching = entries; const controls: HTMLButtonElement[] = [];
    const render = (): void => {
      results.replaceChildren(); controls.length = 0;
      matching = entries.map(entry => ({ entry, score: fuzzyScore(input.value, `${entry.title} ${entry.path}`) })).filter(item => item.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.entry.id.localeCompare(b.entry.id)).map(item => item.entry);
      selected = Math.min(selected, Math.max(0, matching.length - 1));
      for (const [index, entry] of matching.entries()) { const row = button('', async () => { try { await request(entry.request); modal.close(); } catch (error) { this.onError(errorText(error)); } }, 'switcher-row'); row.append(element('span', '', entry.title), element('small', 'muted', entry.path)); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected)); row.id = `switch-${index}`; controls.push(row); results.append(row); }
      if (!matching.length) results.append(element('p', 'muted', 'No matches.')); input.setAttribute('aria-activedescendant', `switch-${selected}`);
    };
    modal.body.append(input, results); modal.footer.append(iconButton('close', 'Close', () => modal.close()), iconButton('folder', 'Open folder…', async () => { await this.perform({ kind: 'open-project' }); modal.close(); })); render();
    input.addEventListener('input', () => { selected = 0; render(); }); input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); controls[selected]?.click(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(0, Math.min(matching.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))); render(); controls[selected]?.scrollIntoView({ block: 'nearest' }); }
    });
  }
}
