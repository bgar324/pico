import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell, clipboard, ClipboardItem, nativeImage } from 'electron';
import { mkdir, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { AppController, type DesktopHost } from './AppController';
import { DesktopActions } from './actions';
import { NativeContextMenu } from './NativeContextMenu';
import { Persistence } from '../services/Persistence';
import { isImageContent, parseRequest } from '../shared/validation';
import { sanitizeDiagnostic } from '../omp/diagnostics';
import type { BridgeResult, ImageContent, JsonRecord, ThreadRecord, UiCommand, UiEvent } from '../shared/types';
import { displaySessionTitle } from '../shared/titles';
import { runElectronSmoke } from './smoke';

const qa = process.argv.includes('--integration-smoke') || process.argv.includes('--ui-qa') || process.argv.includes('--resume-smoke');
if (qa) {
  if (!process.env.PI_DESKTOP_SUPPORT || !process.env.PI_DESKTOP_EVIDENCE) throw new Error('QA requires isolated PI_DESKTOP_SUPPORT and PI_DESKTOP_EVIDENCE.');
  app.commandLine.appendSwitch('headless', 'new');
  app.commandLine.appendSwitch('disable-gpu');
  app.disableHardwareAcceleration();
}
app.setName('Pico');
const support = process.env.PI_DESKTOP_SUPPORT ?? join(homedir(), 'Library', 'Application Support', 'PiDesktop');
const chromiumData = join(support, qa ? 'Electron-QA' : 'Electron');
mkdirSync(chromiumData, { recursive: true });
app.setPath('userData', chromiumData);
app.setPath('sessionData', chromiumData);
const rendererFile = resolve(__dirname, 'renderer/index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
let window: BrowserWindow | null = null;
let controller: AppController | null = null;
let contextMenu: NativeContextMenu | null = null;
let quitting = false;

async function decodeRasterImage(image: ImageContent): Promise<Electron.NativeImage> {
  const bytes = Buffer.from(image.data, 'base64');
  const validSignature = image.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    image.mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) :
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!validSignature) throw new Error('The attachment does not contain a supported raster image.');
  let decoded = nativeImage.createFromBuffer(bytes);
  // Chromium decodes GIF/WebP, including OMP's persisted WebP images, while
  // nativeImage's platform decoder does not support them on every macOS version.
  if (decoded.isEmpty() && (image.mimeType === 'image/webp' || image.mimeType === 'image/gif')) {
    if (!window || window.isDestroyed()) throw new Error('Open the conversation before decoding its images.');
    const png: unknown = await window.webContents.executeJavaScript(`(async () => {
      const bytes=Uint8Array.from(atob(${JSON.stringify(image.data)}),c=>c.charCodeAt(0));
      const bitmap=await createImageBitmap(new Blob([bytes],{type:${JSON.stringify(image.mimeType)}}));
      try {
        if(bitmap.width*bitmap.height>50000000)throw new Error('Choose images with at most 50 million pixels.');
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        const context=canvas.getContext('2d');if(!context)throw new Error('Could not decode the attached image.');
        context.drawImage(bitmap,0,0);return canvas.toDataURL('image/png');
      } finally {bitmap.close();}
    })()`);
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) throw new Error('Could not decode the attached image.');
    decoded = nativeImage.createFromDataURL(png);
  }
  const size = decoded.getSize();
  if (decoded.isEmpty() || !size.width || !size.height) throw new Error('Could not decode the attached image.');
  if (size.width * size.height > 50_000_000) throw new Error('Choose images with at most 50 million pixels.');
  return decoded;
}

async function preparePromptImages(message: string, images: JsonRecord[], frameLimit: number): Promise<JsonRecord[]> {
  // Match the largest prompt envelope ThreadRuntime can emit, including its UUID,
  // queued behavior and newline. JSON escaping and UTF-8 count toward this limit.
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ message, images: [], streamingBehavior: 'followUp', type: 'prompt', id: '0'.repeat(36) }) + '\n');
  let remaining = frameLimit - envelopeBytes - Math.max(0, images.length - 1);
  if (Buffer.byteLength(JSON.stringify({ message, images, streamingBehavior: 'followUp', type: 'prompt', id: '0'.repeat(36) }) + '\n') <= frameLimit) {
    const prepared: JsonRecord[] = [];
    for (const frame of images) {
      if (!isImageContent(frame)) throw new Error('Invalid attached image.');
      await decodeRasterImage(frame);
      prepared.push({ type: frame.type, mimeType: frame.mimeType, data: frame.data });
    }
    return prepared;
  }
  if (remaining <= images.length * 128) throw new Error('The prompt text leaves too little room for images in OMP. Shorten it before sending.');
  const prepared: JsonRecord[] = [];
  for (const [index, frame] of images.entries()) {
    if (!isImageContent(frame)) throw new Error('Invalid attached image.');
    const original = await decodeRasterImage(frame);
    let candidate: JsonRecord = { type: frame.type, mimeType: frame.mimeType, data: frame.data };
    const allowance = Math.floor(remaining / (images.length - index));
    let encodedBytes = Buffer.byteLength(JSON.stringify(candidate));
    if (encodedBytes > allowance) {
      const size = original.getSize(); const longest = Math.max(size.width, size.height);
      const minimumEdge = Math.min(longest, 640);
      let edge = Math.min(longest, 2560);
      let fitted = false;
      while (!fitted) {
        const scale = edge / longest;
        const resized = scale < 1 ? original.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' }) : original;
        for (const quality of [null, 92, 82, 70]) {
          const data = quality === null ? resized.toPNG() : resized.toJPEG(quality);
          candidate = { type: 'image', mimeType: quality === null ? 'image/png' : 'image/jpeg', data: data.toString('base64') };
          encodedBytes = Buffer.byteLength(JSON.stringify(candidate));
          if (encodedBytes <= allowance) { fitted = true; break; }
        }
        if (fitted) break;
        if (edge <= minimumEdge) throw new Error(`These ${images.length} images cannot fit OMP's ${Math.floor(frameLimit / 1024)} KB input frame without losing useful detail. Send fewer images or shorten the text. Your attachments were kept.`);
        edge = Math.max(minimumEdge, Math.floor(edge * 0.8));
      }
    }
    prepared.push(candidate); remaining -= encodedBytes;
  }
  return prepared;
}

async function writeMessageClipboard(message: { text: string; images?: ImageContent[] }): Promise<void> {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escaped = message.text.replace(/[&<>"']/g, character => entities[character] ?? character);
  const imageTags: string[] = [];
  let bitmap: Blob | undefined;
  for (const [index, image] of (message.images ?? []).entries()) {
    const decoded = await decodeRasterImage(image);
    const png = decoded.toPNG();
    bitmap ??= new Blob([new Uint8Array(png)], { type: 'image/png' });
    imageTags.push(`<div><img src="data:image/png;base64,${png.toString('base64')}" alt="Attached image ${index + 1}"></div>`);
  }
  const first = new ClipboardItem({
    'text/plain': message.text,
    'text/html': `<div style="white-space:pre-wrap">${escaped}</div>${imageTags.join('')}`,
    ...(bitmap ? { 'image/png': bitmap } : {}),
  });
  // Rich-text targets receive every inline image; bitmap-only targets receive the first.
  await clipboard.write([first]);
}
function emit(event: UiEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('pi:event', event);
}
function createWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;
  const next = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 620,
    title: 'Pico', backgroundColor: '#303030', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: qa, devTools: true },
  });
  window = next;
  contextMenu = new NativeContextMenu(next, qa);
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  next.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  next.webContents.on('will-attach-webview', event => { event.preventDefault(); });
  next.once('ready-to-show', () => { if (!qa) next.show(); });
  next.on('closed', () => { if (window === next) { window = null; contextMenu = null; } });
  void next.loadFile(rendererFile).catch(error => { process.stderr.write(`Pico renderer failed: ${sanitizeDiagnostic(String(error))}\n`); });
  return next;
}
const host: DesktopHost = {
  async chooseDirectory(title) {
    const result = await dialog.showOpenDialog(createWindow(), { title, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  async chooseExecutable() {
    const result = await dialog.showOpenDialog(createWindow(), { title: 'Choose OMP executable', properties: ['openFile'], defaultPath: '/opt/homebrew/bin' });
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  async chooseImages() {
    const result = await dialog.showOpenDialog(createWindow(), { title: 'Attach images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    return result.canceled ? [] : result.filePaths;
  },
  async confirmDelete(thread: ThreadRecord) {
    const result = await dialog.showMessageBox(createWindow(), { type: 'warning', message: `Delete “${displaySessionTitle(thread.displayTitle)}”?`, detail: 'This deletes the saved conversation and its dedicated OMP session. The project folder is not deleted. Running work in this thread will stop.', buttons: ['Cancel', 'Delete thread'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  },
  async confirmTerminal(thread) {
    const result = await dialog.showMessageBox(createWindow(), { type: 'question', message: 'Continue in Terminal?', detail: `Pico will close the OMP process for “${displaySessionTitle(thread.displayTitle)}” first. Its continuation command will be copied. Paste it into Terminal to continue.`, buttons: ['Cancel', 'Copy command and open Terminal'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  },
  async reveal(path) {
    try {
      if ((await stat(path)).isDirectory()) { const error = await shell.openPath(path); if (error) throw new Error(error); }
      else shell.showItemInFolder(path);
    } catch (error) { throw new Error(`Could not reveal this location: ${error instanceof Error ? error.message : String(error)}`); }
  },
  async terminal(command) {
    clipboard.writeText(command);
    const error = await shell.openPath('/System/Applications/Utilities/Terminal.app');
    if (error) throw new Error(`The command was copied, but Terminal could not open: ${error}`);
  },
  darkMode() { return nativeTheme.shouldUseDarkColors; },
};
function menuCommand(command: UiCommand): void {
  createWindow(); emit({ kind: 'command', command });
}
function installMenus(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Pico', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => menuCommand('settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New thread', accelerator: 'CmdOrCtrl+N', click: () => menuCommand('new-thread') }, { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: () => menuCommand('open-project') }, { type: 'separator' }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+Alt+S', click: () => menuCommand('toggle-sidebar') }, { label: 'Toggle changes', accelerator: 'CmdOrCtrl+Alt+D', click: () => menuCommand('toggle-changes') }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Navigate', submenu: [{ label: 'Quick switcher…', accelerator: 'CmdOrCtrl+K', click: () => menuCommand('quick-switcher') }] },
    { label: 'Conversation', submenu: [{ label: 'Send', accelerator: 'CmdOrCtrl+Enter', click: () => menuCommand('send') }, { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => menuCommand('stop') }, { label: 'Find in conversation…', accelerator: 'CmdOrCtrl+F', click: () => menuCommand('find') }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: 'Show workspace', click: () => createWindow().show() }, { role: 'front' }] },
  ]));
}
if (!qa && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const current = createWindow(); current.show(); current.focus(); });
  app.on('activate', () => { if (!qa) createWindow().show(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !qa) app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !controller) return;
    event.preventDefault(); quitting = true;
    void controller.shutdown().then(() => app.exit(0), error => { process.stderr.write(`${sanitizeDiagnostic(String(error))}\n`); app.exit(1); });
  });
  void app.whenReady().then(async () => {
    await mkdir(chromiumData, { recursive: true });
    const coordinator = new AppController(new Persistence(support), host, emit);
    controller = coordinator;
    const actions = new DesktopActions(coordinator);
    ipcMain.handle('pi:request', async (event, value: unknown): Promise<BridgeResult> => {
      if (!window || event.sender.id !== window.webContents.id || event.senderFrame?.url !== rendererUrl) return { ok: false, error: 'Untrusted application request.' };
      try {
        const request = parseRequest(value);
        if (request.kind === 'context-menu') {
          return { ok: true, value: await contextMenu?.open(request.items) ?? null };
        }
        if (request.kind === 'close-context-menu') {
          contextMenu?.close();
          return { ok: true, value: null };
        }
        if (request.kind === 'copy-message') {
          const message = coordinator.runtimes.get(request.id)?.snapshot().messages.find(item => item.id === request.messageID);
          if (!message) throw new Error('This message is no longer available to copy.');
          await writeMessageClipboard(message);
          return { ok: true, value: null };
        }
        if (request.kind === 'prompt' && request.images.length) {
          const runtime = coordinator.runtimes.get(request.id);
          if (!runtime) throw new Error('Open the conversation before sending images.');
          request.images = await preparePromptImages(request.message, request.images, runtime.client.maxInputFrameBytes);
        }
        return { ok: true, value: await actions.perform(request) };
      }
      catch (error) { return { ok: false, error: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)) }; }
    });
    nativeTheme.on('updated', () => coordinator.notify());
    installMenus();
    const current = createWindow();
    await coordinator.bootstrap();
    if (qa) await runElectronSmoke(current, coordinator, process.argv.includes('--ui-qa'), process.argv.includes('--resume-smoke'), contextMenu);
  }).catch(error => { process.stderr.write(`Pico failed: ${sanitizeDiagnostic(String(error))}\n`); app.exit(1); });
}
