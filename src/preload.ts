import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PiBridge, UiEvent } from './shared/types';
import { json, record } from './shared/validation';

const bridge: PiBridge = {
  async request(request) {
    const reply: unknown = await ipcRenderer.invoke('pi:request', request);
    if (!record(reply)) throw new Error('Invalid application response.');
    if (reply.ok === false && typeof reply.error === 'string') return { ok: false, error: reply.error };
    if (reply.ok === true) return { ok: true, value: json(reply.value) };
    throw new Error('Invalid application response.');
  },
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, event: UiEvent): void => { listener(event); };
    ipcRenderer.on('pi:event', receive);
    return () => { ipcRenderer.removeListener('pi:event', receive); };
  },
  pathsFromDrop(files) {
    return files.map(file => webUtils.getPathForFile(file)).filter(path => path.length > 0);
  },
};
contextBridge.exposeInMainWorld('pi', bridge);
