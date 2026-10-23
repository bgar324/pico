import type { AppRequest, ImageContent, Json, JsonRecord, Preferences, GitFileChange } from './types';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from './sidebar-layout';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const IMAGE_BYTE_LIMIT = 32 * 1048576;
export const IMAGE_TOTAL_BYTE_LIMIT = 64 * 1048576;
export function imageByteCount(image: ImageContent): number {
  return image.data.length / 4 * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
}
export function isImageContent(value: unknown): value is ImageContent {
  if (!record(value) || value.type !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(value.mimeType)) || typeof value.data !== 'string') return false;
  const data = value.data;
  return data.length > 0 && data.length <= Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data) && imageByteCount({ type: 'image', mimeType: 'image/png', data }) <= IMAGE_BYTE_LIMIT;
}
function imageFrames(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Attach at most 20 images.');
  let byteCount = 0;
  return value.map(item => {
    if (!isImageContent(item)) throw new Error('Choose PNG, JPEG, GIF, or WebP images up to 32 MiB each.');
    byteCount += imageByteCount(item);
    if (byteCount > IMAGE_TOTAL_BYTE_LIMIT) throw new Error('Attach images totaling at most 64 MiB.');
    return { type: item.type, mimeType: item.mimeType, data: item.data };
  });
}
export function json(value: unknown, depth = 0): Json {
  if (depth > 40) throw new Error('Data nesting exceeds the supported limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (record(value)) {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Invalid data key.');
      result[key] = json(item, depth + 1);
    }
    return result;
  }
  throw new Error('Unsupported data value.');
}
export function parseRequest(value: unknown): AppRequest {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('Invalid app request.');
  const text = (key: string): string => {
    const item = value[key];
    if (typeof item !== 'string' || item.includes('\0')) throw new Error(`Invalid ${key}.`);
    if (item.length > 1_000_000) throw new Error(`${key} exceeds the input limit.`);
    return item;
  };
  const boolean = (key: string): boolean => {
    const item = value[key];
    if (typeof item !== 'boolean') throw new Error(`Invalid ${key}.`);
    return item;
  };
  const fields = (key: string): JsonRecord => {
    const parsed = json(value[key]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid ${key}.`);
    return parsed;
  };
  const file = (): GitFileChange => {
    const item = value.file;
    if (!record(item) || typeof item.path !== 'string' || typeof item.status !== 'string' ||
        !(item.originalPath === null || typeof item.originalPath === 'string') ||
        !(item.additions === null || typeof item.additions === 'number' && Number.isSafeInteger(item.additions) && item.additions >= 0) ||
        !(item.deletions === null || typeof item.deletions === 'number' && Number.isSafeInteger(item.deletions) && item.deletions >= 0)) throw new Error('Invalid Git file.');
    return { path: item.path, status: item.status, originalPath: item.originalPath, additions: item.additions, deletions: item.deletions };
  };
  switch (value.kind) {
    case 'snapshot': case 'open-project': case 'choose-executable': case 'test-connection': case 'diagnostics': case 'close-context-menu': case 'get-connections': return { kind: value.kind };
    case 'context-menu': {
      if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 32) throw new Error('Choose between 1 and 32 context menu actions.');
      const items: string[] = [];
      for (const item of value.items) {
        if (typeof item !== 'string' || item.trim().length === 0 || item.length > 200 || /[\u0000-\u001f\u007f]/u.test(item)) throw new Error('Invalid context menu action label.');
        items.push(item);
      }
      return { kind: value.kind, items };
    }
    case 'add-project': case 'locate-project': case 'reveal-project': return { kind: value.kind, path: text('path') };
    case 'connect-provider': return { kind: value.kind, providerId: text('providerId'), flowId: text('flowId') };
    case 'cancel-connection': return { kind: value.kind, flowId: text('flowId') };
    case 'connection-input': return { kind: value.kind, flowId: text('flowId'), promptId: text('promptId'), value: text('value') };
    case 'save-provider-key': {
      const key = text('key').trim();
      if (!key || key.length > 16384 || /[\r\n]/u.test(key)) throw new Error('Enter a single API key up to 16 KiB.');
      return { kind: value.kind, providerId: text('providerId'), key };
    }
    case 'disconnect-provider': {
      if (!Number.isSafeInteger(value.credentialId) || typeof value.credentialId !== 'number' || value.credentialId < 0) throw new Error('Choose a stored provider account.');
      return { kind: value.kind, providerId: text('providerId'), credentialId: value.credentialId };
    }
    case 'new-thread': return typeof value.projectPath === 'string' ? { kind: value.kind, projectPath: text('projectPath') } : { kind: value.kind };
    case 'select-thread': return typeof value.reopen === 'boolean' ? { kind: value.kind, id: text('id'), reopen: value.reopen } : { kind: value.kind, id: text('id') };
    case 'draft': return { kind: value.kind, id: text('id'), text: text('text') };
    case 'prompt': {
      const images = imageFrames(value.images);
      return { kind: value.kind, id: text('id'), message: text('message'), steer: boolean('steer'), images };
    }
    case 'abort': case 'delete-thread': case 'remove-project': case 'reveal-session': case 'terminal': case 'attach-images': case 'session-stats': return { kind: value.kind, id: text('id') };
    case 'model': return { kind: value.kind, id: text('id'), modelID: text('modelID') };
    case 'thinking': return { kind: value.kind, id: text('id'), level: text('level') };
    case 'copy-message': return { kind: value.kind, id: text('id'), messageID: text('messageID') };
    case 'edit-message': return { kind: value.kind, id: text('id'), messageID: text('messageID'), message: text('message') };
    case 'promote-queued': return { kind: value.kind, id: text('id'), message: text('message') };
    case 'retract-queued': {
      if (value.queue !== 'steering' && value.queue !== 'followUp') throw new Error('Choose a queued message to edit.');
      const imageRef = value.imageRef === null ? null : text('imageRef');
      if (imageRef !== null && (!imageRef || imageRef.length > 200)) throw new Error('Invalid queued image reference.');
      return { kind: value.kind, id: text('id'), queue: value.queue, message: text('message'), imageRef };
    }
    case 'queued-images': {
      const imageRef = text('imageRef');
      if (!imageRef || imageRef.length > 200) throw new Error('Invalid queued image reference.');
      return { kind: value.kind, id: text('id'), imageRef };
    }
    case 'dialog': return { kind: value.kind, id: text('id'), dialogID: text('dialogID'), fields: fields('fields') };
    case 'rename-thread': return { kind: value.kind, id: text('id'), title: text('title') };
    case 'sidebar': return { kind: value.kind, visible: boolean('visible') };
    case 'project-expanded': return { kind: value.kind, id: text('id'), expanded: boolean('expanded') };
    case 'git-status': return { kind: value.kind, projectPath: text('projectPath') };
    case 'git-diff': return { kind: value.kind, projectPath: text('projectPath'), file: file() };
    case 'open-file': return { kind: value.kind, projectPath: text('projectPath'), file: file(), reveal: boolean('reveal') };
    case 'open-url': return { kind: value.kind, url: text('url') };
    case 'open-local-link': return { kind: value.kind, id: text('id'), url: text('url') };
    case 'preferences': {
      const item = value.preferences;
      if (!record(item) || typeof item.executableOverride !== 'string' || typeof item.defaultProjectPath !== 'string' ||
          !(item.appearance === 'system' || item.appearance === 'light' || item.appearance === 'dark') ||
          typeof item.sidebarWidth !== 'number' || !Number.isFinite(item.sidebarWidth) || item.sidebarWidth < SIDEBAR_MIN_WIDTH || item.sidebarWidth > SIDEBAR_MAX_WIDTH) throw new Error('Invalid preferences.');
      const preferences: Preferences = { executableOverride: item.executableOverride, appearance: item.appearance, defaultProjectPath: item.defaultProjectPath, sidebarWidth: item.sidebarWidth };
      return { kind: value.kind, preferences };
    }
    default: throw new Error('Unsupported app action.');
  }
}
