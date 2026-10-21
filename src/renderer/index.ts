import type { AppInfo, AppRequest, RuntimeSnapshot, UiCommand, UiEvent } from '../shared/types';
import { isBusy } from '../shared/types';
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../shared/sidebar-layout';
import { displaySessionTitle } from '../shared/titles';
import { button, copy, element, errorText, iconButton, request } from './dom';
import { isAppSnapshot, reduceRuntime } from './helpers';
import { Conversation } from './conversation';
import { Composer } from './composer';
import { Sidebar } from './sidebar';
import { Changes } from './changes';
import { Settings } from './settings';
import { AgentDialogs } from './dialogs';
import { icon } from './icons';
import { TodoPanel } from './todo-panel';
import { SurfacePresence } from './surface-presence';

const root = document.getElementById('app');
if (!root) throw new Error('Renderer root is missing.');
const appRoot = root;
let app: AppInfo | null = null;
const runtimes = new Map<string, RuntimeSnapshot>();
let changesVisible = false;
let rendering = false;
let initialLoaded = false;
const initialEvents: UiEvent[] = [];
let error = '';
let dismissedAppError: string | undefined;
let loadError = '';
const settings = new Settings();
const dialogs = new AgentDialogs();
const emptyConversation = new Conversation();
let conversation = emptyConversation;
const conversationViews = new Map<string, Conversation>();
let visibleConversationID: string | null = null;
const errorBanner = element('div', 'error-banner'); errorBanner.setAttribute('role', 'alert');
const errorLabel = element('span');
errorBanner.append(errorLabel, iconButton('close', 'Dismiss error', () => {
  error = ''; dismissedAppError = app?.error ?? undefined; schedule();
  const editor = composer.node.querySelector('textarea');
  if (editor?.checkVisibility() && !editor.disabled) editor.focus({ preventScroll: true });
}));
function showError(text: string): void { error = text; schedule(); }
async function perform(value: AppRequest): Promise<void> { try { await request(value); } catch (failure) { showError(errorText(failure)); } }
const composer = new Composer(showError, async () => {
  await request({ kind: 'new-thread' });
  const snapshot = await request({ kind: 'snapshot' });
  if (!isAppSnapshot(snapshot)) throw new Error('Could not read the new conversation.');
  const thread = snapshot.manifest.threads.find(thread => thread.id === snapshot.manifest.selectedThreadID);
  if (!thread) return null;
  const runtime = snapshot.runtimes.find(runtime => runtime.id === thread.id);
  if (!runtime || runtime.status.kind !== 'ready') throw new Error(runtime?.error || 'OMP is not connected. Check Settings.');
  return { thread, runtime };
}, id => { if (id === visibleConversationID) conversation.followLatest(); });
const sidebar = new Sidebar(showError, () => { if (app) settings.show(app); }, (id, expanded) => { void perform({ kind: 'project-expanded', id, expanded }); }, () => command('toggle-changes'));
const changes = new Changes(() => { changesVisible = false; schedule(); });
const titlebar = element('header', 'titlebar');
const toolbar = element('div', 'toolbar');
const sidebarToggle = button('', () => command('toggle-sidebar'), 'toolbar-button icon-button sidebar-toggle');
sidebarToggle.append(icon('sidebar')); sidebarToggle.title = 'Hide sidebar · ⌥⌘S'; sidebarToggle.setAttribute('aria-label', 'Hide sidebar');
sidebarToggle.dataset.testid = 'sidebar-toggle'; sidebarToggle.setAttribute('aria-controls', sidebar.node.id);
const titlebarDivider = element('div', 'titlebar-chat-divider'); titlebarDivider.hidden = true;
const titlebarChat = element('div', 'titlebar-chat'); titlebarChat.hidden = true;
titlebarChat.setAttribute('role', 'group'); titlebarChat.setAttribute('aria-label', 'Current chat');
const titlebarChatIcon = element('span', 'titlebar-chat-icon'); titlebarChatIcon.append(icon('project-folder'));
const titlebarChatName = element('span', 'titlebar-chat-name');
let renderedChatTitle: string | null = null;
titlebarChat.append(titlebarChatIcon, titlebarChatName);
toolbar.append(sidebarToggle); titlebar.append(toolbar, titlebarDivider, titlebarChat);
const workspace = element('div', 'workspace');
const main = element('main', 'main');
const todos = new TodoPanel(main, composer.node);
const recovery = element('div', 'runtime-recovery');
const recoveryText = element('span'); const recoveryActions = element('div', 'recovery-actions'); recovery.append(recoveryText, recoveryActions);
const notices = element('div', 'main-notices'); notices.append(errorBanner, recovery);
const errorPresence = new SurfacePresence(errorBanner), recoveryPresence = new SurfacePresence(recovery);
const empty = element('section', 'empty-state');
main.append(notices, empty, conversation.node, composer.node, todos.rail, todos.controls); workspace.append(sidebar.node, main, changes.backdrop, changes.node); appRoot.append(titlebar, workspace);
const frameGeometry = new ResizeObserver(() => {
  const left = `${main.getBoundingClientRect().left}px`;
  const controlsEnd = `${toolbar.getBoundingClientRect().right + 8}px`;
  const gutter = `${Math.max(0, (conversation.scroll.offsetWidth - conversation.scroll.clientWidth) / 2)}px`;
  if (titlebar.style.getPropertyValue('--chat-header-left') !== left) titlebar.style.setProperty('--chat-header-left', left);
  if (titlebar.style.getPropertyValue('--titlebar-controls-end') !== controlsEnd) titlebar.style.setProperty('--titlebar-controls-end', controlsEnd);
  if (main.style.getPropertyValue('--chat-scrollbar-gutter') !== gutter) main.style.setProperty('--chat-scrollbar-gutter', gutter);
});
frameGeometry.observe(main); frameGeometry.observe(toolbar); frameGeometry.observe(conversation.scroll);

function selectConversationView(id: string | null): void {
  if (id !== visibleConversationID) {
    const previous = conversation;
    if (id === null) conversation = emptyConversation;
    else {
      const cached = conversationViews.get(id) ?? new Conversation();
      conversationViews.delete(id); conversationViews.set(id, cached);
      conversation = cached;
    }
    frameGeometry.unobserve(previous.scroll);
    previous.node.replaceWith(conversation.node);
    conversation.activate(); visibleConversationID = id;
    frameGeometry.observe(conversation.scroll);
  }
  for (const [key, view] of conversationViews) {
    if (key !== id && !app?.manifest.threads.some(thread => thread.id === key)) { view.dispose(); conversationViews.delete(key); }
  }
  while (conversationViews.size > 3) {
    const oldest = conversationViews.entries().next().value;
    if (!oldest) break;
    oldest[1].dispose(); conversationViews.delete(oldest[0]);
    if (runtimes.get(oldest[0])?.status.kind === 'closed') runtimes.delete(oldest[0]);
  }
}
function schedule(): void { if (rendering) return; rendering = true; requestAnimationFrame(render); }
function render(): void {
  rendering = false;
  if (loadError) {
    empty.hidden = false; conversation.node.hidden = true; composer.node.hidden = true;
    errorPresence.setVisible(false, true); recoveryPresence.setVisible(false, true);
    todos.update(undefined, null);
    empty.replaceChildren(element('h1', '', 'Could not load Pico'), element('p', 'error-text', loadError), button('Retry', () => { window.location.reload(); }));
    return;
  }
  if (!app) { empty.hidden = false; empty.replaceChildren(element('h1', '', 'Loading Pico…')); conversation.node.hidden = true; composer.node.hidden = true; errorPresence.setVisible(false, true); recoveryPresence.setVisible(false, true); todos.update(undefined, null); return; }
  const currentApp = app;
  document.documentElement.dataset.theme = currentApp.theme;
  const sidebarVisible = sidebarSizing?.open ?? currentApp.manifest.sidebarVisible;
  if (!sidebarVisible && sidebar.node.contains(document.activeElement)) sidebarToggle.focus({ preventScroll: true });
  appRoot.classList.toggle('sidebar-hidden', !sidebarVisible);
  if (!sidebarSizing) appRoot.style.setProperty('--sidebar-width', `${clampSidebarWidth(currentApp.preferences.sidebarWidth)}px`);
  sidebar.setVisible(sidebarVisible, sidebarSizing?.kind !== 'dragging');
  if (sidebarToggle.getAttribute('aria-expanded') !== String(sidebarVisible)) {
    sidebarToggle.setAttribute('aria-expanded', String(sidebarVisible)); sidebarToggle.setAttribute('aria-pressed', String(sidebarVisible));
    sidebarToggle.setAttribute('aria-label', sidebarVisible ? 'Hide sidebar' : 'Show sidebar');
    sidebarToggle.title = `${sidebarVisible ? 'Hide' : 'Show'} sidebar · ⌥⌘S`;
    sidebarToggle.replaceChildren(icon(sidebarVisible ? 'sidebar' : 'sidebar-hidden'));
  }
  sidebar.resize.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
  sidebar.resize.setAttribute('aria-valuemax', String(clampSidebarWidth(SIDEBAR_MAX_WIDTH, window.innerWidth)));
  sidebar.resize.setAttribute('aria-valuenow', String(clampSidebarWidth(sidebarSizing?.width ?? currentApp.preferences.sidebarWidth, window.innerWidth)));
  sidebar.update(currentApp, runtimes); settings.update(currentApp);
  const thread = currentApp.manifest.threads.find(record => record.id === currentApp.manifest.selectedThreadID);
  titlebarChat.hidden = !thread; titlebarDivider.hidden = !thread;
  main.classList.toggle('has-chat-header', !!thread);
  const rawChatTitle = thread?.displayTitle ?? null;
  if (renderedChatTitle !== rawChatTitle) {
    const name = thread ? displaySessionTitle(thread.displayTitle) || 'Untitled thread' : '';
    titlebarChatName.textContent = name; titlebarChat.title = name;
    renderedChatTitle = rawChatTitle;
  }
  const changedThread = visibleConversationID !== (thread?.id ?? null);
  selectConversationView(thread?.id ?? null);
  const runtime = thread ? runtimes.get(thread.id) : undefined;
  const path = thread?.projectPath ?? (currentApp.preferences.defaultProjectPath || currentApp.manifest.projects[0]?.path || '');
  const modalChanges = changesVisible && !!path && window.innerWidth < 1180;
  if (modalChanges) composer.closeMenus();
  const focusOrigin = document.activeElement;
  main.inert = modalChanges; sidebar.node.inert = modalChanges; toolbar.inert = modalChanges;
  changes.update(path, changesVisible && !!path, focusOrigin);
  conversation.node.hidden = !thread; empty.hidden = !!thread;
  main.classList.toggle('empty-workspace', !thread);
  if (thread) {
    const recoveryValue = runtime?.error || runtime?.notice || (runtime?.status.kind === 'closed' ? runtime.status.reason || 'OMP is disconnected. Reopen this thread to resume.' : '');
    recoveryPresence.setVisible(!!recoveryValue, changedThread); recoveryText.textContent = recoveryValue;
    const recoverySignature = `${thread.id}\0${runtime?.status.kind}\0${recoveryValue}`;
    if (recovery.dataset.value !== recoverySignature) {
      recovery.dataset.value = recoverySignature; recoveryActions.replaceChildren();
      if (runtime?.status.kind !== 'connecting') {
        const reopen = iconButton('refresh', 'Reopen thread', () => perform({ kind: 'select-thread', id: thread.id, reopen: true })); reopen.disabled = !!runtime && isBusy(runtime.status);
        recoveryActions.append(reopen, iconButton('terminal', 'Open Terminal', () => perform({ kind: 'terminal', id: thread.id })), iconButton('code', 'Diagnostics', () => perform({ kind: 'diagnostics' })));
      }
    }
  } else {
    recoveryPresence.setVisible(false, true);
    const signature = JSON.stringify([currentApp.executablePath, currentApp.connectionStatus, currentApp.manifest.projects.length]);
    if (empty.dataset.value !== signature) {
      empty.dataset.value = signature; empty.replaceChildren();
      const actions = element('div', 'empty-actions');
      if (!currentApp.executablePath) {
        empty.append(element('h1', '', 'OMP connection unavailable'), element('p', 'muted', currentApp.connectionStatus));
        actions.append(button('Choose OMP executable…', () => perform({ kind: 'choose-executable' }), 'primary'), button('Settings…', () => settings.show(currentApp)));
        const install = element('div', 'install-actions'); const control = iconButton('copy', 'Copy install command', () => copy('bun install -g @oh-my-pi/pi-coding-agent', control));
        install.append(iconButton('external-link', 'Installation instructions', () => perform({ kind: 'open-url', url: 'https://github.com/can1357/oh-my-pi#install' })), control); empty.append(actions, install);
      } else {
        empty.append(element('h1', '', 'What should we build?'));
      }
    }
  }
  if (!currentApp.error) dismissedAppError = undefined;
  errorLabel.textContent = error || (currentApp.error !== dismissedAppError ? currentApp.error : '') || '';
  errorPresence.setVisible(!!errorLabel.textContent);
  conversation.update(runtime, thread?.id ?? null); composer.update(thread, runtime); dialogs.update(runtime);
  todos.update(runtime, thread?.id ?? null);
}
function command(value: UiCommand): void {
  if (document.querySelector('dialog[open]') && !['stop'].includes(value)) return;
  if (main.inert && value !== 'stop' && value !== 'toggle-changes') return;
  switch (value) {
    case 'open-project': void perform({ kind: 'open-project' }); break;
    case 'new-thread': void perform({ kind: 'new-thread' }); break;
    case 'toggle-sidebar': {
      if (!app) break;
      const visible = sidebarSizing?.open ?? app.manifest.sidebarVisible;
      if (sidebarSizing?.kind === 'dragging') { sidebarSizing.open = !visible; finishSidebarResize(); }
      else { sidebarSizing = null; void perform({ kind: 'sidebar', visible: !visible }); }
      break;
    }
    case 'toggle-changes': changesVisible = !changesVisible; schedule(); break;
    case 'quick-switcher': sidebar.quickSwitcher(); break;
    case 'find': if (visibleConversationID) conversation.showFind(); break;
    case 'send': void composer.submit(false); break;
    case 'stop': if (!dialogs.active) void composer.abort(); break;
    case 'settings': if (app) settings.show(app); break;
    default: { const exhaustive: never = value; throw new Error(`Unknown command ${exhaustive}`); }
  }
}
function consume(event: UiEvent): void {
  if (event.kind === 'command') { command(event.command); return; }
  if (event.kind === 'app') {
    if (!app || event.snapshot.revision > app.revision) { app = event.snapshot; settings.update(event.snapshot); schedule(); }
    return;
  }
  if (!initialLoaded) { initialEvents.push(event); return; }
  if (reduceRuntime(runtimes, event.event)) {
    if (event.event.kind === 'tool' && ['succeeded', 'failed', 'interrupted'].includes(event.event.tool.state)) {
      const threadID = event.event.threadID;
      const thread = app?.manifest.threads.find(record => record.id === threadID);
      if (thread) changes.toolEnded(thread.projectPath);
    }
    schedule();
  }
}
const unsubscribe = window.pi.subscribe(consume);
window.addEventListener('beforeunload', unsubscribe);
window.addEventListener('resize', schedule);
document.addEventListener('keydown', event => {
  if (event.isComposing || document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  if (main.inert && !(event.metaKey && (key === '.' || event.altKey && key === 'd'))) return;
  if (event.metaKey && event.shiftKey && key === 'enter') { event.preventDefault(); void composer.submit(true); return; }
  if (event.metaKey) {
    let value: UiCommand | null = null;
    if (key === 'k') value = 'quick-switcher'; else if (key === 'f') value = 'find'; else if (key === ',' ) value = 'settings'; else if (key === '.') value = 'stop'; else if (event.altKey && key === 's') value = 'toggle-sidebar'; else if (event.altKey && key === 'd') value = 'toggle-changes'; else if (key === 'n') value = 'new-thread'; else if (key === 'o') value = 'open-project'; else if (key === 'enter') value = 'send';
    if (value) { event.preventDefault(); command(value); }
  } else if (event.key === 'Escape' && !event.defaultPrevented) {
    if (changesVisible && window.innerWidth < 1180) { changesVisible = false; schedule(); }
    else void composer.abort();
  }
});
type SidebarSizing = { kind: 'dragging'; pointer: number; start: number; initialWidth: number; width: number; open: boolean; lifetime: AbortController } | { kind: 'saving'; width: number; open: boolean };
let sidebarSizing: SidebarSizing | null = null;
async function saveSidebarSize(width: number, open: boolean): Promise<void> {
  if (!app) return;
  const saving: SidebarSizing = { kind: 'saving', width, open }; sidebarSizing = saving;
  appRoot.style.setProperty('--sidebar-width', `${width}px`); schedule();
  try {
    if (open) await request({ kind: 'preferences', preferences: { ...app.preferences, sidebarWidth: width } });
    if (sidebarSizing === saving && app.manifest.sidebarVisible !== open) await request({ kind: 'sidebar', visible: open });
  } catch (error) { showError(errorText(error)); }
  finally { if (sidebarSizing === saving) { sidebarSizing = null; schedule(); } }
}
function moveSidebarResize(event: PointerEvent): void {
  if (sidebarSizing?.kind !== 'dragging' || sidebarSizing.pointer !== event.pointerId) return;
  const requested = sidebarSizing.initialWidth + event.clientX - sidebarSizing.start;
  sidebarSizing.open = requested >= SIDEBAR_MIN_WIDTH / 2;
  if (sidebarSizing.open) sidebarSizing.width = clampSidebarWidth(requested, window.innerWidth);
  appRoot.style.setProperty('--sidebar-width', `${sidebarSizing.width}px`);
  sidebar.setVisible(sidebarSizing.open, false); schedule();
}
function finishSidebarResize(): void {
  if (sidebarSizing?.kind !== 'dragging') return;
  const drag = sidebarSizing;
  drag.lifetime.abort(); sidebarSizing = null; appRoot.removeAttribute('data-sidebar-resizing');
  void saveSidebarSize(drag.open ? drag.width : app?.preferences.sidebarWidth ?? drag.width, drag.open);
  if (sidebar.resize.hasPointerCapture(drag.pointer)) sidebar.resize.releasePointerCapture(drag.pointer);
}
sidebar.resize.addEventListener('pointerdown', event => {
  if (!app || event.button !== 0 || sidebarSizing?.kind === 'dragging' || sidebar.node.hasAttribute('data-animating')) return;
  const width = sidebar.node.getBoundingClientRect().width, lifetime = new AbortController();
  sidebarSizing = { kind: 'dragging', pointer: event.pointerId, start: event.clientX, initialWidth: width, width, open: true, lifetime };
  window.addEventListener('pointermove', moveSidebarResize, { signal: lifetime.signal });
  window.addEventListener('pointerup', event => {
    if (sidebarSizing?.kind !== 'dragging' || sidebarSizing.pointer !== event.pointerId) return;
    moveSidebarResize(event); finishSidebarResize();
  }, { signal: lifetime.signal });
  window.addEventListener('pointercancel', event => { if (sidebarSizing?.kind === 'dragging' && sidebarSizing.pointer === event.pointerId) finishSidebarResize(); }, { signal: lifetime.signal });
  sidebar.resize.addEventListener('lostpointercapture', event => { if (sidebarSizing?.kind === 'dragging' && sidebarSizing.pointer === event.pointerId) finishSidebarResize(); }, { signal: lifetime.signal });
  appRoot.setAttribute('data-sidebar-resizing', ''); sidebar.resize.focus(); sidebar.resize.setPointerCapture(event.pointerId); event.preventDefault();
});
sidebar.resize.addEventListener('dblclick', () => { void saveSidebarSize(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, window.innerWidth), true); });
sidebar.resize.addEventListener('keydown', event => {
  if (!app || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const width = clampSidebarWidth(sidebar.node.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -10 : 10), window.innerWidth);
  appRoot.style.setProperty('--sidebar-width', `${width}px`); void saveSidebarSize(width, true);
});
window.addEventListener('beforeunload', () => {
  frameGeometry.disconnect(); errorPresence.dispose(); recoveryPresence.dispose();
  sidebar.dispose(); todos.dispose(); changes.dispose(); emptyConversation.dispose();
  for (const view of conversationViews.values()) view.dispose();
}, { once: true });
main.addEventListener('dragover', event => { if (!app?.manifest.selectedThreadID && event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
main.addEventListener('drop', event => { if (app?.manifest.selectedThreadID) return; event.preventDefault(); for (const path of window.pi.pathsFromDrop(Array.from(event.dataTransfer?.files ?? []))) void perform({ kind: 'add-project', path }); });
schedule();
void request({ kind: 'snapshot' }).then(value => {
  if (!isAppSnapshot(value)) throw new Error('Pico returned an invalid initial snapshot.');
  if (!app || value.revision > app.revision) app = value;
  for (const runtime of value.runtimes) reduceRuntime(runtimes, { kind: 'snapshot', runtime });
  initialLoaded = true;
  for (const event of initialEvents.splice(0)) consume(event);
  schedule();
}).catch(failure => {
  loadError = errorText(failure); schedule();
});
