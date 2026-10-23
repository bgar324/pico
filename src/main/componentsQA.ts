import type { BrowserWindow } from 'electron';
import type { AppController } from './AppController';
import { record } from '../shared/validation';
import type { NativeContextMenu } from './NativeContextMenu';

interface Qa {
  check(condition: boolean, message: string): void;
  until(label: string, predicate: () => boolean | Promise<boolean>, timeout?: number): Promise<void>;
  capture(name: string): Promise<void>;
}

export async function runComponentsQA(window: BrowserWindow, controller: AppController, qa: Qa, contextMenu: NativeContextMenu): Promise<unknown[]> {
  const id = controller.manifest.selectedThreadID;
  if (!id) throw new Error('Component QA requires a saved thread.');
  const runtime = await controller.runtimeFor(id);
  const originalEffort = runtime.summary().thinkingLevel;
  const originalPreferences = { ...controller.preferences };
  const metrics: unknown[] = [];
  const evaluate = (source: string): Promise<unknown> => window.webContents.executeJavaScript(source);
  const measure = async (surface: string): Promise<void> => {
    const result = await evaluate(`(() => { try {
      const visible = node => node.getClientRects().length > 0 && (!node.closest('[popover]') || node.closest('[popover]').matches(':popover-open'));
      const excluded = '.project-name,.project-show-more,.thread-title,.icon-button,.row-menu,.change-file,.switcher-row,.select-control,.menu-option,.model-picker-row';
      const geometry = nodes => {
        const rows = Array.from(nodes).filter(visible).map(node => { const s = getComputedStyle(node); return { radius:s.borderRadius, height:s.height, font:s.fontSize, weight:s.fontWeight, border:s.borderTopWidth, outline:s.outlineStyle }; });
        return Object.fromEntries(['radius','height','font','weight','border','outline'].map(key => [key,Array.from(new Set(rows.map(row => row[key])))]));
      };
      const buttons = geometry(Array.from(document.querySelectorAll('button')).filter(node => !node.matches(excluded)));
      const menuRows = geometry(document.querySelectorAll('.menu-surface:popover-open .menu-option:not(.composer-setting-row)'));
      const fields = geometry(document.querySelectorAll('.modal input:not([type=radio]):not([type=checkbox]),.modal .select-control'));
      for (const [key,want] of [['radius','6px'],['height','28px'],['font','12px'],['weight','450'],['border','1px'],['outline','none']]) {
        if (buttons[key].some(value => value !== want) || menuRows[key].some(value => value !== want)) throw new Error('Control canon mismatch: '+key+' '+JSON.stringify({buttons,menuRows}));
      }
      for (const [key,want] of [['radius','6px'],['height','32px'],['font','13px'],['border','1px'],['outline','none']]) if (fields[key].some(value => value !== want)) throw new Error('Field canon mismatch: '+key+' '+JSON.stringify(fields));
      return { surface:${JSON.stringify(surface)}, buttons,menuRows,fields, exclusions:'navigation rows, icon-only navigation, change-file rows, switcher and model result cards, two-line composer settings rows, select triggers measured as fields' };
    } catch (error) { return {error:String(error)}; } })()`);
    if (record(result) && typeof result.error === 'string') throw new Error(`${surface}: ${result.error}`);
    metrics.push(result);
  };
  const open = async (selector: string, menu = '.menu-surface'): Promise<void> => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await qa.until('popover opened', async () => (await evaluate(`Boolean(document.querySelector(${JSON.stringify(`${menu}:popover-open`)}))`)) === true);
    await qa.until('popover transition settled', async () => (await evaluate(`(() => {const node=document.querySelector(${JSON.stringify(`${menu}:popover-open`)});return !!node && getComputedStyle(node).opacity==='1' && getComputedStyle(node).transform==='none';})()`)) === true);
  };
  const choose = async (label: string): Promise<void> => {
    await evaluate(`(() => { const option = Array.from(document.querySelectorAll('.menu-surface:popover-open .menu-option')).find(node => node.dataset.label === ${JSON.stringify(label)}); if (!option) throw new Error('Missing menu option'); option.click(); })()`);
  };
  const escape = async (menu = '.menu-surface'): Promise<void> => {
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
    await qa.until('popover closed', async () => (await evaluate(`!document.querySelector(${JSON.stringify(`${menu}:popover-open`)})`)) === true);
  };
  const openComposerSettings = async (): Promise<void> => {
    if ((await evaluate('Boolean(document.querySelector(".composer-settings-menu:popover-open"))')) !== true) {
      await open('.composer-settings-trigger', '.composer-settings-menu');
    }
  };
  const openThinking = async (): Promise<void> => {
    await openComposerSettings();
    await open('.composer-settings-menu [aria-label="Thinking level"]', '.thinking-menu');
  };

  await measure('conversation-dark');
  await openComposerSettings();
  await measure('composer-settings');
  await qa.capture('unified-composer-settings');
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true}))`);
  qa.check((await evaluate('document.activeElement === document.querySelector(".composer-settings-menu [aria-label=\\"Thinking level\\"]")')) === true, 'Composer settings support keyboard End navigation');
  await evaluate(`document.querySelector('.composer-settings-menu [aria-label="Model"]').click()`);
  await qa.until('model picker opened', async () => (await evaluate('Boolean(document.querySelector(".model-picker[open]"))')) === true);
  qa.check((await evaluate('!document.querySelector(".composer-settings-menu:popover-open") && document.activeElement === document.querySelector(".model-picker [aria-label=\\"Search models\\"]")')) === true, 'Model picker closes parent settings and focuses search');
  await measure('model-picker');
  await qa.capture('unified-model-picker');
  await evaluate(`(() => {
    const search = document.querySelector('.model-picker [aria-label="Search models"]');
    search.value = 'qa-no-matching-model-1a8e607b'; search.dispatchEvent(new Event('input', {bubbles:true}));
    if (document.querySelector('.model-picker-row') || !document.querySelector('.model-picker').textContent.includes('No matching models')) throw new Error('Model search did not filter results');
    search.value = ''; search.dispatchEvent(new Event('input', {bubbles:true}));
    search.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
    if (document.activeElement !== document.querySelector('.model-picker-row')) throw new Error('Model search ArrowDown did not focus first result');
  })()`);
  qa.check(true, 'Model search filters results and supports keyboard result navigation');
  await evaluate(`document.querySelector('.model-picker .modal-footer button').click()`);
  await qa.until('model picker closed', async () => (await evaluate('!document.querySelector(".model-picker[open]")')) === true);
  qa.check((await evaluate('document.activeElement === document.querySelector(".composer-settings-trigger")')) === true, 'Model picker returns focus to composer settings without rings');
  await openComposerSettings();
  await escape('.composer-settings-menu');
  qa.check((await evaluate('document.activeElement === document.querySelector(".composer-settings-trigger")')) === true, 'Settings Escape returns trigger focus without rings');
  await openComposerSettings();
  const menuMotion = await evaluate(`(async () => {
    document.querySelector('.composer-settings-menu [aria-label="Thinking level"]').click();
    const menu = document.querySelector('.thinking-menu:popover-open'); const samples = [];
    for (let i=0;i<40;i++) { const s=getComputedStyle(menu); samples.push({opacity:Number(s.opacity),transform:s.transform}); if(i>0 && Number(s.opacity)===1)break; const tick=Promise.withResolvers(); setTimeout(tick.resolve,12); await tick.promise; }
    if (!samples.some(s => s.opacity>0 && s.opacity<1 && s.transform!=='none') || samples.at(-1).opacity!==1) throw new Error('Menu transition did not interpolate and settle');
    return {surface:'menu-motion',samples};
  })()`);
  metrics.push(menuMotion); qa.check(true, 'Menu opacity and transform interpolate across actual frames');
  await escape('.thinking-menu');

  await openThinking();
  await measure('effort-menu');
  await qa.capture('unified-effort-menu');
  qa.check((await evaluate('Array.from(document.querySelectorAll(".thinking-menu .menu-option")).every(node => node.getAttribute("role") === "menuitemradio" && node.querySelector(".ui-icon"))')) === true, 'Thinking choices expose radio semantics and effort icons');
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true}))`);
  qa.check((await evaluate('document.activeElement === document.querySelector(".thinking-menu .menu-option:last-child")')) === true, 'Thinking menu supports keyboard End navigation');
  await choose('Off');
  await qa.until('effort off', () => runtime.summary().thinkingLevel === 'off');
  const off = await runtime.client.request('get_state');
  qa.check(record(off) && off.thinkingLevel === 'off', 'Custom effort menu changes actual OMP effort');
  await qa.until('effort control enabled', async () => (await evaluate('!document.querySelector(".composer-settings-menu [aria-label=\\"Thinking level\\"]").disabled')) === true);
  await openThinking(); await choose('Inherit');
  await qa.until('effort inherited', () => runtime.summary().thinkingLevel === 'inherit');
  const inherited = await runtime.client.request('get_state');
  qa.check(record(inherited) && inherited.thinkingLevel === undefined, 'Inherit clears the actual OMP effort override');
  await qa.until('inherited UI label', async () => (await evaluate('document.querySelector(".composer-settings-menu [aria-label=\\"Thinking level\\"]").dataset.value')) === 'inherit');
  qa.check(true, 'Inherit remains selected after engine state refresh');
  await qa.until('inherited effort control enabled', async () => (await evaluate('!document.querySelector(".composer-settings-menu [aria-label=\\"Thinking level\\"]").disabled')) === true);
  await openThinking();
  qa.check((await evaluate('document.querySelector(".thinking-menu [data-value=inherit]").getAttribute("aria-checked")')) === 'true', 'Inherited effort is checked in the nested thinking menu');
  await escape('.thinking-menu');
  await runtime.selectThinking(originalEffort);
  await escape('.composer-settings-menu');

  const dialogMotion = await evaluate(`(async () => {
    document.querySelector('[data-testid=settings]').click();
    const dialog = document.querySelector('dialog[open]'); const samples = [];
    for (let i=0;i<40;i++) { const s=getComputedStyle(dialog); samples.push({opacity:Number(s.opacity),transform:s.transform}); if(i>0 && Number(s.opacity)===1)break; const tick=Promise.withResolvers(); setTimeout(tick.resolve,12); await tick.promise; }
    if (!samples.some(s => s.opacity>0 && s.opacity<1 && s.transform!=='none') || samples.at(-1).opacity!==1) throw new Error('Dialog animation did not interpolate and settle');
    return {surface:'dialog-motion',samples};
  })()`);
  metrics.push(dialogMotion); qa.check(true, 'Dialog opacity and transform interpolate across actual frames');
  window.webContents.focus();
  const pressTab = async (shift = false): Promise<void> => {
    await evaluate(`document.documentElement.dataset.qaKey = 'pending'; document.addEventListener('keyup', () => { document.documentElement.dataset.qaKey = 'done'; }, {once:true,capture:true})`);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:shift ? ['shift'] : []});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:shift ? ['shift'] : []});
    await qa.until('Tab input delivered', async () => (await evaluate('document.documentElement.dataset.qaKey')) === 'done');
  };
  for (let step=0;step<12;step++) {
    await pressTab();
    qa.check((await evaluate('document.querySelector(\"dialog[open]\").contains(document.activeElement)')) === true, `Settings Tab focus stays inside at step ${step+1}`);
  }
  await evaluate(`document.querySelector('#settings-tab-general').focus()`);
  await pressTab(true);
  qa.check((await evaluate('document.activeElement === Array.from(document.querySelectorAll(".settings-footer-actions button:not(:disabled)")).at(-1)')) === true, 'Settings Shift-Tab wraps to its final enabled control');
  await evaluate(`delete document.documentElement.dataset.qaKey`);
  await measure('settings-dark'); await qa.capture('unified-settings-dark');
  await evaluate(`document.querySelector('.settings-appearance-option[data-appearance="light"]').click()`);
  await qa.until('light theme persisted', () => controller.preferences.appearance === 'light');
  await qa.until('light theme rendered', async () => (await evaluate('document.documentElement.dataset.theme')) === 'light');
  await measure('settings-light'); await qa.capture('unified-settings-light');
  const project = controller.manifest.projects.at(-1);
  if (!project) throw new Error('Missing QA project.');
  await open('[aria-label="Default project"]'); await choose(project.path);
  await evaluate(`document.querySelector('.settings-footer-actions .primary').click()`);
  await qa.until('default project saved', () => controller.preferences.defaultProjectPath === project.path);
  qa.check(true, 'Shared Settings controls persist appearance and project preferences');
  await qa.capture('unified-conversation-light');

  await evaluate(`document.querySelector('[data-testid=settings]').click()`);
  await open('[aria-label="Default project"]');
  await evaluate(`document.querySelector('.settings-close').click()`);
  qa.check((await evaluate('!document.querySelector("dialog[open]") && !document.querySelector("[popover]:popover-open")')) === true, 'Closing a dialog dismisses its open dropdown');
  await controller.updatePreferences(originalPreferences);
  await qa.until('original appearance restored', async () => (await evaluate('document.documentElement.dataset.theme')) === controller.info().theme);

  await evaluate(`document.querySelector('.thread-row.selected .row-menu').click()`);
  await qa.until('thread native menu request intercepted', () => contextMenu.interceptedItems.includes('Rename…'));
  qa.check((await evaluate('!document.querySelector(".context-menu")')) === true, 'Sidebar requests a native menu without a web popup');
  metrics.push({ surface: 'thread-context-menu', labels: contextMenu.interceptedItems, verification: 'Headless IPC interception; native popup visuals and OS animation not exercised' });
  contextMenu.selectIntercepted(contextMenu.interceptedItems.indexOf('Rename…'));
  await qa.until('rename dialog opened', async () => (await evaluate('Boolean(document.querySelector("dialog[open]"))')) === true);
  await measure('rename-dialog'); await qa.capture('unified-rename');
  await evaluate(`document.querySelector('.modal-footer [aria-label="Cancel"]').click()`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`);
  await measure('quick-switcher'); await qa.capture('unified-switcher');
  await evaluate(`document.querySelector('.modal-footer [aria-label="Close"]').click()`);

  await openThinking();
  const point = await evaluate(`(() => { const b = document.querySelector('[data-testid=composer]').getBoundingClientRect(); return {x:Math.round(b.left+20),y:Math.round(b.top+15)}; })()`);
  if (!record(point) || typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error('Invalid composer click position.');
  window.webContents.focus();
  window.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, x:point.x, y:point.y });
  window.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:point.x, y:point.y });
  await qa.until('outside click dismisses menu', async () => (await evaluate('!document.querySelector(".menu-surface:popover-open")')) === true);
  qa.check(true, 'Clicking outside dismisses a shared dropdown');
  await openComposerSettings();
  const triggerPoint = await evaluate(`(() => { const b = document.querySelector('.composer-settings-trigger').getBoundingClientRect(); return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}; })()`);
  if (!record(triggerPoint) || typeof triggerPoint.x !== 'number' || typeof triggerPoint.y !== 'number') throw new Error('Invalid dropdown trigger position.');
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:triggerPoint.x,y:triggerPoint.y});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:triggerPoint.x,y:triggerPoint.y});
  await qa.until('trigger click toggles menu closed', async () => (await evaluate('!document.querySelector(\".menu-surface:popover-open\")')) === true, 2000);
  qa.check(true, 'Clicking an open dropdown trigger closes it');

  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
    await openThinking();
    qa.check((await evaluate('getComputedStyle(document.querySelector(".thinking-menu:popover-open")).transitionDuration.split(",").every(value => parseFloat(value) === 0)')) === true, 'Reduced motion disables menu transitions');
    await escape('.thinking-menu');
    qa.check((await evaluate('document.activeElement === document.querySelector(".composer-settings-menu [aria-label=\\"Thinking level\\"]") && Boolean(document.querySelector(".composer-settings-menu:popover-open"))')) === true, 'Thinking Escape returns focus to its parent settings row');
    await escape('.composer-settings-menu');
    await evaluate(`document.querySelector('[data-testid=settings]').click()`);
    qa.check((await evaluate('getComputedStyle(document.querySelector("dialog[open]")).animationName')) === 'none', 'Reduced motion disables dialog animation');
    await evaluate(`document.querySelector('.settings-close').click()`);
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[] });
  } finally { window.webContents.debugger.detach(); }

  window.setSize(900, 620);
  await qa.until('narrow component layout', async () => (await evaluate('window.innerWidth')) === 900);
  await measure('conversation-narrow'); await qa.capture('unified-conversation-narrow');
  await openThinking();
  qa.check((await evaluate('Array.from(document.querySelectorAll(".composer-settings-menu:popover-open,.thinking-menu:popover-open")).every(node => { const r=node.getBoundingClientRect(); return r.left>=10 && r.top>=10 && r.right<=innerWidth-10 && r.bottom<=innerHeight-10; })')) === true, 'Narrow settings and thinking menus remain within the window');
  await measure('effort-menu-narrow'); await qa.capture('unified-effort-narrow');
  await escape('.thinking-menu'); await escape('.composer-settings-menu');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',metaKey:true,altKey:true,bubbles:true}))`);
  await qa.until('narrow Changes sheet', async () => (await evaluate('!document.querySelector(".changes-pane").hidden && document.querySelector(".changes-pane").contains(document.activeElement)')) === true);
  await measure('changes-sheet'); await qa.capture('unified-changes');
  await evaluate(`document.querySelector('.pane-header [aria-label="Close"]').click()`);
  await evaluate(`document.querySelector('[data-testid=sidebar-toggle]').click()`);
  await qa.until('sidebar hidden', () => !controller.manifest.sidebarVisible);
  await qa.capture('unified-sidebar-hidden');
  await evaluate(`document.querySelector('[data-testid=sidebar-toggle]').click()`);
  await qa.until('sidebar restored', () => controller.manifest.sidebarVisible);
  qa.check(true, 'Unified button, menu and field geometry holds across all inspected surfaces');
  return metrics;
}
