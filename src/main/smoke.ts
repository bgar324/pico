import { app, type BrowserWindow, type NativeImage } from 'electron';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AppController } from './AppController';
import { GitService } from '../services/GitService';
import { isBusy } from '../shared/types';
import { record } from '../shared/validation';
import { SIDEBAR_MAX_WIDTH } from '../shared/sidebar-layout';
import { runComponentsQA } from './componentsQA';
import { checkConversationPresentation, runRealStreamingCanary } from './conversationQA';
import { runShellQA } from './shellQA';
import { runVisualFixesQA } from './visualFixesQA';
import type { NativeContextMenu } from './NativeContextMenu';
const executeFile = promisify(execFile);

async function until(label: string, predicate: () => boolean | Promise<boolean>, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
async function screenshot(window: BrowserWindow, evidence: string, name: string) {
  const frame = Promise.withResolvers<Buffer>();
  const timeout = new AbortController();
  const receive = (_event: Electron.Event, _dirty: Electron.Rectangle, image: NativeImage): void => {
    if (image.isEmpty()) return;
    const png = image.toPNG();
    if (png.length > 0) frame.resolve(png);
  };
  window.webContents.on('paint', receive);
  window.webContents.invalidate();
  try {
    const png = await Promise.race([
      frame.promise,
      delay(2000, undefined, { signal: timeout.signal }).then(async () => {
        const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        if (image.isEmpty()) throw new Error('Electron produced an empty screenshot.');
        return image.toPNG();
      }),
    ]);
    if (png.length === 0) throw new Error('Electron produced an empty PNG.');
    await writeFile(join(evidence, `${name}.png`), png);
  } finally { timeout.abort(); window.webContents.removeListener('paint', receive); }
}
export async function runElectronSmoke(window: BrowserWindow, controller: AppController, visualOnly: boolean, resumeOnly = false, contextMenu: NativeContextMenu | null = null) {
  const evidence = process.env.PI_DESKTOP_EVIDENCE;
  if (!evidence || !process.env.PI_DESKTOP_SUPPORT) throw new Error('Smoke requires isolated app storage and evidence paths.');
  if (!contextMenu) throw new Error('Smoke requires headless native menu interception.');
  await mkdir(evidence, { recursive: true });
  const outcomes: string[] = [];
  function check(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
    outcomes.push(`PASS ${message}`); process.stdout.write(`PASS ${message}\n`);
  }
  try {
    await until('renderer loaded', async () => (await window.webContents.executeJavaScript('Boolean(window.pi && document.readyState === "complete")')) === true);
    const replacedMenu = contextMenu.open(['Replaced action']);
    const selectedMenu = contextMenu.open(['First action', 'Second action']);
    check(await replacedMenu === null, 'Replacing an intercepted native menu cancels its previous reply');
    check(contextMenu.interceptedItems.join('|') === 'First action|Second action', 'Native Menu templates preserve action order without showing a popup');
    contextMenu.selectIntercepted(1);
    check(await selectedMenu === 1, 'Native MenuItem click resolves the selected captured action index');
    const cancelledMenu = contextMenu.open(['Cancel action']);
    contextMenu.close();
    contextMenu.close();
    check(await cancelledMenu === null && contextMenu.interceptedItems.length === 0, 'Closing native menus resolves cancellation once and clears ownership; OS visuals are not exercised');
    if (resumeOnly) {
      const expected: unknown = JSON.parse(await readFile(join(evidence, 'resume-expectations.json'), 'utf8'));
      if (!record(expected) || typeof expected.threadID !== 'string' || !Array.isArray(expected.userMessages) || !Array.isArray(expected.projectPaths)) throw new Error('Invalid relaunch expectations.');
      const runtime = await controller.runtimeFor(expected.threadID);
      await until('relaunched transcript ready', () => runtime.summary().status.kind === 'ready');
      check(JSON.stringify(controller.manifest.projects.map(project => project.path)) === JSON.stringify(expected.projectPaths), 'Full application relaunch preserves projects');
      check(JSON.stringify(runtime.snapshot().messages.filter(message => message.role === 'user').map(message => message.text)) === JSON.stringify(expected.userMessages), 'Full application relaunch restores exact user turns without replay');
      check(!isBusy(runtime.summary().status), 'Relaunched conversation is idle');
      await until('relaunched UI transcript', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".agent-message"))')) === true);
      await screenshot(window, evidence, 'electron-relaunch');
      await writeFile(join(evidence, 'electron-relaunch-results.txt'), `${outcomes.join('\n')}\n`);
      await controller.shutdown(); process.stdout.write('ELECTRON RELAUNCH PASSED\n'); app.exit(0); return;
    }
    if (visualOnly) {
      const id = controller.manifest.selectedThreadID;
      if (!id) throw new Error('Visual audit requires an existing saved conversation.');
      await until('saved transcript ready', () => controller.runtimes.get(id)?.summary().status.kind === 'ready');
      await until('focused controls ready', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".composer-settings-trigger")) && !document.querySelector(".composer-selectors").hidden')) === true);
      if (process.env.PI_DESKTOP_VISUAL_FIX_QA_ONLY === '1') {
        await runVisualFixesQA(window, controller, id, { check, until, capture: name => screenshot(window, evidence, name) });
        await writeFile(join(evidence, 'visual-fixes-results.txt'), `${outcomes.join('\n')}\n`);
        await controller.shutdown(); app.exit(0); return;
      }
      if (process.env.PI_DESKTOP_SHELL_QA_ONLY === '1') {
        await runShellQA(window, controller, id, { check, until, capture: name => screenshot(window, evidence, name) }, contextMenu);
        await writeFile(join(evidence, 'shell-results.txt'), `${outcomes.join('\n')}\n`);
        await controller.shutdown(); app.exit(0); return;
      }
      for (const selector of ['[data-testid=composer]', '.composer-settings-trigger']) {
        check((await window.webContents.executeJavaScript(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); control.focus(); return document.activeElement === control && getComputedStyle(control).outlineStyle === 'none'; })()`)) === true, `Focus remains functional without an outline on ${selector}`);
      }
      await window.webContents.executeJavaScript(`document.querySelector('[data-testid=composer]').focus()`);
      await screenshot(window, evidence, 'electron-focused-composer');
      await window.webContents.executeJavaScript(`document.querySelector('.composer-settings-trigger').focus()`);
      await screenshot(window, evidence, 'electron-focused-thinking');
      const metrics = await runComponentsQA(window, controller, { check, until, capture: name => screenshot(window, evidence, name) }, contextMenu);
      await writeFile(join(evidence, 'unified-control-metrics.json'), JSON.stringify(metrics, null, 2));
      await screenshot(window, evidence, 'electron-conversation');
      window.setSize(900, 620);
      await until('narrow layout', async () => (await window.webContents.executeJavaScript('window.innerWidth')) === 900);
      await checkConversationPresentation(window, controller, id, { check, until, capture: name => screenshot(window, evidence, name) });
      await runShellQA(window, controller, id, { check, until, capture: name => screenshot(window, evidence, name) }, contextMenu);
      await writeFile(join(evidence, 'electron-focus-results.txt'), `${outcomes.join('\n')}\n`);
      await screenshot(window, evidence, 'electron-narrow');
      await controller.shutdown(); app.exit(0); return;
    }
    check(controller.executablePath !== null, 'Real OMP executable and ready handshake');
    await screenshot(window, evidence, 'electron-empty');
    const projects = await mkdtemp(join(tmpdir(), 'pi-electron-projects-'));
    const alpha = join(projects, 'Alpha'); const beta = join(projects, 'Beta');
    for (const path of [alpha, beta]) {
      await mkdir(path, { recursive: true }); await writeFile(join(path, 'greeting.txt'), 'hello\n');
      await executeFile('/usr/bin/git', ['init', '-q'], { cwd: path });
      await executeFile('/usr/bin/git', ['add', 'greeting.txt'], { cwd: path });
      await executeFile('/usr/bin/git', ['-c', 'user.name=Pico QA', '-c', 'user.email=qa@localhost', 'commit', '-qm', 'Initial fixture'], { cwd: path });
    }
    const extensionDirectory = join(alpha, '.omp', 'extensions'); await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(extensionDirectory, 'desktop-check.js'), `export default function(pi) { pi.registerCommand('desktop-confirm', { description: 'Check native host confirmation', handler: async (_args, ctx) => { const ok = await ctx.ui.confirm('Confirm test action', 'Deny this integration check. No files are changed.'); ctx.ui.notify(ok ? 'Confirmation accepted' : 'Confirmation denied', 'info'); } }); }`);
    await controller.addProject(alpha);
    const firstID = controller.manifest.selectedThreadID;
    if (!firstID) throw new Error('No first thread');
    const first = await controller.runtimeFor(firstID);
    await until('first thread ready', () => first.summary().status.kind === 'ready');
    check(first.summary().models.length > 0 && first.summary().thinkingLevels.length > 0, 'Live model and reasoning discovery');
    await first.selectModel(first.summary().selectedModelID);
    if (first.summary().thinkingLevels.includes('low')) await first.selectThinking('low');
    const liveState = await first.client.request('get_state');
    check(record(liveState) && record(liveState.model) && `${String(liveState.model.provider)}/${String(liveState.model.id)}` === first.summary().selectedModelID, 'Actual model selection state');
    const prompt = 'Read greeting.txt using a tool. Edit only greeting.txt from hello to hello from Pico. Run a shell command verifying that exact text. Finish with a brief explanation and a fenced code block showing the test command.';
    await until('selected UI thread ready', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=composer]")) && !document.querySelector(".composer-selectors").hidden')) === true);
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('[data-testid=composer]'); if (!(input instanceof HTMLTextAreaElement)) throw new Error('Missing composer'); input.value = ${JSON.stringify(prompt)}; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await until('renderer send enabled', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=send]:not(:disabled)"))')) === true);
    await window.webContents.executeJavaScript(`document.querySelector('[data-testid=composer]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));`);
    await until('real UI prompt streamed', () => first.snapshot().messages.some(message => message.role === 'assistant' && (message.text.length > 0 || message.thinking.length > 0)), 120_000);
    await screenshot(window, evidence, 'electron-stream');
    await until('first turn settled', () => first.summary().status.kind === 'ready' && !isBusy(first.summary().status), 180_000);
    check(first.summary().error === null, 'Renderer composer submitted real prompt');
    check((await readFile(join(alpha, 'greeting.txt'), 'utf8')).includes('hello from Pico'), 'Real tool file edit');
    check(first.snapshot().tools.some(tool => tool.state === 'succeeded'), 'Real tool lifecycle output');
    await window.webContents.executeJavaScript(`document.querySelectorAll('.activity-group,details[data-tool-id]').forEach(node => { node.open = true; })`);
    await screenshot(window, evidence, 'electron-tools');
    const git = new GitService(); const changes = await git.snapshot(alpha);
    const changed = changes.files.find(file => file.path === 'greeting.txt');
    check(changed !== undefined, 'Read-only Git working tree status');
    if (changed) check((await git.diff(alpha, changed)).unstaged.includes('+hello from Pico'), 'Real unified Git diff');
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',metaKey:true,altKey:true,bubbles:true}))`);
    await until('changes UI', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(\".diff-line.added\"))')) === true);
    await screenshot(window, evidence, 'electron-changes');
    await until('initial diff refresh complete', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".pane-header [aria-label=Refresh]:not(:disabled)"))')) === true);
    await writeFile(join(alpha, 'greeting.txt'), 'hello\n');
    await window.webContents.executeJavaScript(`document.querySelector('.pane-header [aria-label=Refresh]')?.click()`);
    await until('tracked patch cleared', async () => (await window.webContents.executeJavaScript('!Array.from(document.querySelectorAll(".change-file")).some(node => node.textContent.includes("greeting.txt"))')) === true);
    await until('cleared diff refresh complete', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".pane-header [aria-label=Refresh]:not(:disabled)"))')) === true);
    await writeFile(join(alpha, 'greeting.txt'), 'hello from Pico\n');
    await window.webContents.executeJavaScript(`document.querySelector('.pane-header [aria-label=Refresh]')?.click()`);
    await until('tracked change recreated', async () => (await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".change-file")).some(node => node.textContent.includes("greeting.txt"))')) === true);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.change-file')).find(node => node.textContent.includes('greeting.txt'))?.click()`);
    await until('same patch rendered again', async () => (await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".diff-line.added")).some(node => node.textContent.includes("hello from Pico"))')) === true);
    check(true, 'Identical patch renders after clearing and recreating changes');
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',metaKey:true,altKey:true,bubbles:true}))`);
    await runRealStreamingCanary(window, controller, firstID, { check, until, capture: name => screenshot(window, evidence, name) });
    const approval = first.sendPrompt('/desktop-confirm');
    await until('real confirmation', () => first.summary().dialogs.some(dialog => dialog.method === 'confirm'));
    await screenshot(window, evidence, 'electron-dialog');
    const confirmation = first.summary().dialogs.find(dialog => dialog.method === 'confirm');
    if (!confirmation) throw new Error('Missing confirmation');
    await first.respond(confirmation.id, { confirmed: false }); await approval;
    await until('denial delivered', () => first.summary().notice?.includes('denied') === true);
    check(first.summary().dialogs.length === 0, 'Exact-ID native extension denial');
    await controller.addProject(beta);
    const secondID = controller.manifest.selectedThreadID;
    if (!secondID || secondID === firstID) throw new Error('No second independent thread');
    const second = await controller.runtimeFor(secondID);
    const [admittedFirst, admittedSecond] = await Promise.all([
      first.sendPrompt('No tools. Explain ALPHA_ONLY_729 in about 150 words and include the marker.'),
      second.sendPrompt('No tools. Explain BETA_ONLY_483 in about 150 words and include the marker.'),
    ]);
    check(admittedFirst && admittedSecond, 'Two independent prompt admissions');
    const followUp = 'Reply exactly FOLLOW_UP_OK. No tools.';
    check(await second.sendPrompt(followUp), 'Queued follow-up admission');
    await until('parallel settled', () => !isBusy(first.summary().status) && !isBusy(second.summary().status), 180_000);
    const alphaText = first.snapshot().messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
    const betaText = second.snapshot().messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
    check(alphaText.includes('ALPHA_ONLY_729') && !alphaText.includes('BETA_ONLY_483') && betaText.includes('BETA_ONLY_483') && !betaText.includes('ALPHA_ONLY_729'), 'No crossed independent stream output');
    check(betaText.includes('FOLLOW_UP_OK'), 'Queued follow-up delivery');
    await second.sendPrompt('Run sleep 20 using a shell tool, then answer STOP_FINISHED. Do not edit files.');
    await until('active tool to stop', () => second.snapshot().tools.some(tool => tool.state === 'running'), 90_000);
    await until('single stop action visible', async () => (await window.webContents.executeJavaScript('document.querySelector("[data-testid=send]").dataset.mode === "stop" && document.querySelectorAll(".composer-actions button").length === 1')) === true);
    await screenshot(window, evidence, 'composer-single-stop');
    const steerMessage = 'After the tool ends, reply exactly STEER_OK instead. No more tools.';
    await window.webContents.executeJavaScript(`(() => {const input=document.querySelector('[data-testid=composer]');input.value=${JSON.stringify(steerMessage)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,shiftKey:true,bubbles:true}));})()`);
    await until('steering delivered', () => !isBusy(second.summary().status) && second.snapshot().messages.some(message => message.role === 'assistant' && message.text.includes('STEER_OK')), 90_000);
    check(true, 'Steering changes the actual response after an active tool');
    await second.sendPrompt('Run sleep 20 using a shell tool, then answer STOP_FINISHED. Do not edit files.');
    await until('second active tool to stop', () => second.snapshot().tools.some(tool => tool.state === 'running'), 90_000);
    await until('stop action ready', async () => (await window.webContents.executeJavaScript('document.querySelector("[data-testid=send]").dataset.mode === "stop" && !document.querySelector("[data-testid=send]").disabled')) === true);
    await window.webContents.executeJavaScript('document.querySelector("[data-testid=send]").click()');
    await until('abort settled', () => !isBusy(second.summary().status));
    check((await window.webContents.executeJavaScript('document.querySelectorAll(".composer-actions button").length === 1')) === true, 'One circular composer action handles actual Stop');
    check(!isBusy(second.summary().status), 'Stop reaches actual quiescence');
    await second.sendPrompt('Reply exactly AFTER_STOP_OK. No tools.');
    await until('post-stop response', () => !isBusy(second.summary().status) && second.snapshot().messages.some(message => message.role === 'assistant' && message.text.includes('AFTER_STOP_OK')), 90_000);
    check(true, 'Prompt after Stop works');
    await controller.selectThread(firstID);
    const userCount = first.snapshot().messages.filter(message => message.role === 'user').length;
    await controller.selectThread(firstID, true);
    const restored = await controller.runtimeFor(firstID);
    check(restored.snapshot().messages.filter(message => message.role === 'user').length === userCount, 'Durable OMP transcript without duplicate turns');
    await until('reopened renderer ready', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".agent-message")) && !document.querySelector("[data-testid=composer]")?.disabled')) === true);
    check(!isBusy(restored.summary().status), 'Restore does not replay work');
    await screenshot(window, evidence, 'electron-restored');
    await controller.updatePreferences({ ...controller.preferences, appearance: 'light' });
    await until('light appearance rendered', async () => (await window.webContents.executeJavaScript('document.documentElement.dataset.theme')) === 'light');
    await screenshot(window, evidence, 'electron-light');
    await controller.updatePreferences({ ...controller.preferences, appearance: 'dark' });
    await until('dark appearance rendered', async () => (await window.webContents.executeJavaScript('document.documentElement.dataset.theme')) === 'dark');
    window.setSize(900, 620);
    await until('narrow window', async () => (await window.webContents.executeJavaScript('window.innerWidth')) === 900);
    await screenshot(window, evidence, 'electron-narrow');
    await controller.updatePreferences({ ...controller.preferences, sidebarWidth: SIDEBAR_MAX_WIDTH - 10 });
    await until('sidebar width applied', async () => (await window.webContents.executeJavaScript('document.getElementById("app").style.getPropertyValue("--sidebar-width")')) === `${SIDEBAR_MAX_WIDTH - 10}px`);
    await window.webContents.executeJavaScript(`const resize = document.querySelector('.sidebar-resize'); resize.focus(); resize.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));`);
    await until('sidebar reaches maximum', () => controller.preferences.sidebarWidth === SIDEBAR_MAX_WIDTH);
    await window.webContents.executeJavaScript(`document.querySelector('.sidebar-resize').dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));`);
    await until('sidebar maximum remains rendered', async () => (await window.webContents.executeJavaScript('document.getElementById("app").style.getPropertyValue("--sidebar-width")')) === `${SIDEBAR_MAX_WIDTH}px`);
    check(controller.preferences.sidebarWidth === SIDEBAR_MAX_WIDTH, 'Keyboard sidebar maximum persists within IPC bounds');
    await window.webContents.executeJavaScript(`document.querySelector('[data-testid=composer]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key:'d', metaKey:true, altKey:true, bubbles:true }));`);
    await until('narrow changes focus entered', async () => (await window.webContents.executeJavaScript('document.querySelector(".changes-pane").contains(document.activeElement)')) === true);
    check((await window.webContents.executeJavaScript('document.querySelector("main").inert && document.querySelector(".sidebar").inert')) === true, 'Narrow changes sheet focuses inside and makes background inert');
    await screenshot(window, evidence, 'electron-narrow-changes');
    await window.webContents.executeJavaScript(`const controls = document.querySelector('.changes-pane').querySelectorAll('button:not(:disabled)'); controls[controls.length - 1].focus(); controls[controls.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', bubbles:true }));`);
    check((await window.webContents.executeJavaScript('document.activeElement === document.querySelector(".changes-pane button:not(:disabled)")')) === true, 'Narrow changes sheet wraps Tab focus');
    await window.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));`);
    await until('changes focus returned', async () => (await window.webContents.executeJavaScript('document.activeElement === document.querySelector("[data-testid=composer]")')) === true);
    check(true, 'Closing narrow changes returns composer focus');
    await window.webContents.executeJavaScript(`document.querySelector('[data-testid=settings]')?.click()`);
    await until('settings dialog', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(\"dialog[open]\"))')) === true);
    await screenshot(window, evidence, 'electron-settings');
    await window.webContents.executeJavaScript(`document.querySelector('.settings-close')?.click()`);
    const revisionBeforeEviction = restored.summary().revision;
    await controller.newThread(alpha); await controller.newThread(beta);
    check(!controller.runtimes.has(firstID), 'Fourth conversation recycles only an idle runtime');
    await controller.selectThread(firstID);
    const replacement = await controller.runtimeFor(firstID);
    check(replacement.summary().revision > revisionBeforeEviction, 'Replacement runtime preserves the thread revision sequence');
    await until('replacement renderer restores controls and history', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".agent-message")) && !document.querySelector("[data-testid=composer]")?.disabled')) === true);
    check(replacement.snapshot().messages.filter(message => message.role === 'user').length === userCount, 'Evicted thread restores history without duplicate turns');
    const replacementApproval = replacement.sendPrompt('/desktop-confirm');
    await until('replacement dialog rendered', async () => (await window.webContents.executeJavaScript('Boolean(document.querySelector(".agent-dialog[open]"))')) === true);
    const replacementDialog = replacement.summary().dialogs.find(dialog => dialog.method === 'confirm');
    if (!replacementDialog) throw new Error('Missing replacement confirmation.');
    await replacement.respond(replacementDialog.id, { confirmed: false }); await replacementApproval;
    check(replacement.summary().dialogs.length === 0, 'Replacement runtime approval reaches the renderer and exact response');
    await writeFile(join(evidence, 'resume-expectations.json'), JSON.stringify({ threadID: firstID, userMessages: replacement.snapshot().messages.filter(message => message.role === 'user').map(message => message.text), projectPaths: controller.manifest.projects.map(project => project.path) }));
    await writeFile(join(evidence, 'electron-results.txt'), `${outcomes.join('\n')}\n`);
    await controller.shutdown(); process.stdout.write(`ELECTRON SMOKE PASSED: ${outcomes.length} checks; ${evidence}\n`); app.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(join(evidence, 'electron-results.txt'), `${outcomes.join('\n')}\nFAIL ${message}\n`);
    await screenshot(window, evidence, 'electron-failure').catch(() => undefined);
    await controller.shutdown(); process.stderr.write(`ELECTRON SMOKE FAILED: ${message}\n`); app.exit(1);
  }
}
