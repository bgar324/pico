import { Sidebar } from '../src/renderer/sidebar';
import type { AppInfo, RuntimeSnapshot } from '../src/shared/types';

function verify(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
async function frame(): Promise<void> { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
async function settled(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!predicate()) { verify(performance.now() < deadline, 'Sidebar animation did not settle.'); await frame(); }
}

export async function checkSidebarTransitions(): Promise<string> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:46px 0 0;display:flex;z-index:200;background:var(--canvas);--sidebar-width:340px';
  const app: AppInfo = {
    revision: 1, manifest: {
      projects: [{ id: 'one', path: '/sidebar/Project', expanded: true }, { id: 'two', path: '/sidebar/Other', expanded: false }],
      threads: Array.from({ length: 8 }, (_, index) => ({ id: `sidebar-${index}`, projectPath: '/sidebar/Project', displayTitle: `Conversation ${index}`, ompSessionDirectory: `/sidebar/session/${index}`, createdAt: '', updatedAt: '', draft: '', wasRunning: false })),
      selectedThreadID: 'sidebar-7', sidebarVisible: true,
    },
    preferences: { executableOverride: '', appearance: 'dark', defaultProjectPath: '', sidebarWidth: 340 }, executablePath: '/fixture/omp', connectionStatus: '', error: null, theme: 'dark',
  };
  const sidebar = new Sidebar(text => { throw new Error(text); }, () => { throw new Error('Unexpected settings action.'); }, () => { app.revision++; }, () => { throw new Error('Unexpected changes action.'); });
  host.append(sidebar.node); document.body.append(host);
  try {
    const runtime: RuntimeSnapshot = {
      id: 'sidebar-6', revision: 1, status: { kind: 'ready', activity: 'running' }, models: [], selectedModelID: '', thinkingLevels: [], thinkingLevel: '', contextUsage: null,
      messages: [], tools: [], dialogs: [], subagents: [], todoPhases: [], queuedFollowUps: [], queuedSteers: [], error: null, notice: null,
    };
    sidebar.update(app, new Map()); sidebar.setVisible(true); await frame(); await frame();
    const toggle = sidebar.node.querySelector<HTMLButtonElement>('.project-name');
    const folder = sidebar.node.querySelector<HTMLElement>('.project-threads');
    const selected = sidebar.node.querySelector<HTMLButtonElement>('.thread-title[data-thread-id="sidebar-7"]');
    if (!toggle || !folder || !selected) throw new Error('Sidebar did not preserve a selected thread beyond the initial visible page.');
    const initialHeight = folder.getBoundingClientRect().height;
    verify(initialHeight > 0 && !folder.inert, 'Restored expanded folder did not open immediately.');
    const status = sidebar.node.querySelector<HTMLElement>('.project-status');
    const otherStatus = sidebar.node.querySelector<HTMLElement>('.project-group:nth-child(2) .project-status');
    if (!status || !otherStatus) throw new Error('Missing project status indicators.');
    sidebar.update(app, new Map([[runtime.id, runtime]]));
    verify(!status.checkVisibility(), 'Expanded folders duplicated thread activity on the folder row.');
    selected.focus(); toggle.click();
    verify(folder.inert && folder.getAttribute('aria-hidden') === 'true' && document.activeElement === toggle, 'Collapsing a focused folder left hidden controls interactive or lost focus.');
    const heights: number[] = [];
    for (let index = 0; index < 5; index++) { await frame(); heights.push(folder.getBoundingClientRect().height); }
    verify(heights.some(height => height > 0.5 && height < initialHeight - 0.5), 'Folder collapse snapped rather than animating its visible height.');
    await settled(() => folder.getBoundingClientRect().height < 0.5);
    toggle.blur();
    verify(status.checkVisibility() && !otherStatus.checkVisibility(), 'Collapsed folder did not show activity from its unselected, paginated thread, or leaked activity into another folder.');
    const spinner = status.querySelector('svg');
    verify(spinner && getComputedStyle(spinner).animationName !== 'none', 'Collapsed folder activity did not animate the shared spinner.');
    const second: RuntimeSnapshot = { ...runtime, id: 'sidebar-0', status: { kind: 'ready', activity: 'background' } };
    sidebar.update(app, new Map([[runtime.id, runtime], [second.id, second]]));
    verify(status.checkVisibility(), 'Multiple running threads did not retain the folder spinner.');
    sidebar.update(app, new Map([[second.id, second]]));
    verify(status.checkVisibility(), 'Folder spinner disappeared while another thread continued background work.');
    sidebar.update(app, new Map([[runtime.id, { ...runtime, status: { kind: 'ready', activity: 'idle' } }]]));
    verify(!status.checkVisibility(), 'Folder spinner remained after the final runtime stopped or was removed.');
    sidebar.update(app, new Map([[runtime.id, runtime]]));
    toggle.click(); await frame(); toggle.click(); await frame(); toggle.click();
    await settled(() => Math.abs(folder.getBoundingClientRect().height - initialHeight) < 0.5);
    verify(!folder.inert && toggle.getAttribute('aria-expanded') === 'true' && selected.isConnected, 'Rapid folder reversal lost the final open state or recreated the selected row.');
    verify(!status.checkVisibility(), 'Opening a running folder left a duplicate folder spinner.');
    const more = sidebar.node.querySelector<HTMLButtonElement>('.project-show-more');
    more?.click();
    await settled(() => folder.getBoundingClientRect().height > initialHeight + 50);
    verify(sidebar.node.querySelectorAll('.thread-row').length === 8, 'Show more dropped or duplicated saved conversations.');
    const width = sidebar.node.getBoundingClientRect().width;
    sidebar.setVisible(false);
    verify(sidebar.node.querySelector<HTMLElement>('.sidebar-content')?.inert, 'Closing the sidebar did not immediately disable hidden content.');
    const widths: number[] = [];
    for (let index = 0; index < 4; index++) { await frame(); widths.push(sidebar.node.getBoundingClientRect().width); }
    verify(widths.some(value => value > 0.5 && value < width - 0.5), 'Sidebar shell snapped rather than animating its layout width.');
    verify(Math.abs((sidebar.node.querySelector('.sidebar-content')?.getBoundingClientRect().width ?? 0) - width) < 0.5, 'Closing the shell reflowed rows instead of cropping fixed-width content.');
    sidebar.setVisible(true);
    await settled(() => !sidebar.node.hasAttribute('data-animating'));
    verify(Math.abs(sidebar.node.getBoundingClientRect().width - width) < 0.5 && !sidebar.node.querySelector<HTMLElement>('.sidebar-content')?.inert, 'Rapid shell reversal failed to restore its full geometry or interactive state.');
    return 'Sidebar and folder motion retain keyed rows, reveal selected paginated chats, and disable collapsed controls; collapsed folders aggregate live running/background threads and clear when work stops.';
  } finally { sidebar.dispose(); host.remove(); }
}
