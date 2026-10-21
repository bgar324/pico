import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, json } from '../src/shared/validation';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../src/shared/sidebar-layout';

test('rejects unknown actions, malformed payloads and prototype mutation keys', () => {
  assert.throws(() => parseRequest({ kind: 'exec', command: 'rm -rf /' }));
  assert.throws(() => parseRequest({ kind: 'prompt', id: 'thread', message: 'hello', steer: true, images: [null] }));
  assert.throws(() => parseRequest({ kind: 'dialog', id: 'thread', dialogID: 'request', fields: JSON.parse('{"__proto__":{"admin":true}}') }));
  assert.throws(() => json({ number: Number.NaN }));
  assert.throws(() => parseRequest({ kind: 'add-project', path: '/tmp\0elsewhere' }));
});
test('validates settings bounds and explicit booleans', () => {
  const preferences = { executableOverride: '', appearance: 'dark', defaultProjectPath: '', sidebarWidth: 244 };
  assert.deepEqual(parseRequest({ kind: 'preferences', preferences }), { kind: 'preferences', preferences });
  assert.throws(() => parseRequest({ kind: 'preferences', preferences: { ...preferences, sidebarWidth: 999 } }));
  for (const sidebarWidth of [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]) {
    assert.equal(parseRequest({ kind: 'preferences', preferences: { ...preferences, sidebarWidth } }).kind, 'preferences');
  }
  for (const sidebarWidth of [SIDEBAR_MIN_WIDTH - 1, SIDEBAR_MAX_WIDTH + 1]) {
    assert.throws(() => parseRequest({ kind: 'preferences', preferences: { ...preferences, sidebarWidth } }));
  }
  assert.throws(() => parseRequest({ kind: 'sidebar', visible: 'yes' }));
  assert.throws(() => parseRequest({ kind: 'preferences', preferences: { ...preferences, appearance: 'neon' } }));
});
test('Git actions reject invalid counts without changing literal filenames', () => {
  const file = { path: ':literal* 雪\tname.txt', status: ' M', additions: 1, deletions: 0, originalPath: null };
  const request = parseRequest({ kind: 'git-diff', projectPath: '/tmp/project with spaces', file });
  assert.equal(request.kind, 'git-diff');
  if (request.kind === 'git-diff') assert.equal(request.file.path, file.path);
  assert.throws(() => parseRequest({ kind: 'git-diff', projectPath: '/tmp/project', file: { ...file, additions: -1 } }));
  assert.throws(() => parseRequest({ kind: 'git-diff', projectPath: '/tmp/project', file: { ...file, deletions: 1.5 } }));
});

test('image IPC uses raster base64, actual byte limits and an ID-only copy request', () => {
  const frame = { type: 'image', mimeType: 'image/png', data: Buffer.alloc(650_000).toString('base64') };
  const prompt = { kind: 'prompt', id: 'thread', message: '', steer: false, images: [frame] };
  assert.deepEqual(parseRequest(prompt), prompt);
  for (const image of [{ ...frame, mimeType: 'image/svg+xml' }, { ...frame, data: 'https://example.com/image.png' }, { ...frame, data: 'file:///private/image.png' }, { ...frame, data: 'AAAA=' }]) {
    assert.throws(() => parseRequest({ ...prompt, images: [image] }));
  }
  assert.deepEqual(parseRequest({ ...prompt, images: [{ ...frame, url: 'file:///secret', path: '/secret' }] }), prompt);
  assert.deepEqual(parseRequest({ kind: 'copy-message', id: 'thread', messageID: 'message', html: '<img src="file:///secret">' }), { kind: 'copy-message', id: 'thread', messageID: 'message' });
  assert.throws(() => parseRequest({ kind: 'copy-message', id: 'thread', messageID: null }));
  assert.deepEqual(parseRequest({ kind: 'promote-queued', id: 'thread', message: 'next' }), { kind: 'promote-queued', id: 'thread', message: 'next' });
});

test('context menus accept bounded plain labels and discard renderer action payloads', () => {
  const items = ['Rename…', 'Delete thread…'];
  assert.deepEqual(parseRequest({ kind: 'context-menu', items, click: 'delete-all' }), { kind: 'context-menu', items });
  assert.deepEqual(parseRequest({ kind: 'close-context-menu' }), { kind: 'close-context-menu' });
  assert.deepEqual(parseRequest({ kind: 'context-menu', items: Array(32).fill('Action') }), { kind: 'context-menu', items: Array(32).fill('Action') });
  for (const invalid of [undefined, null, 'Rename', [], Array(33).fill('Action'), [null], [1], [{}], [''], [' \t'], ['a'.repeat(201)], ['Rename\0'], ['Rename\nthread'], ['Delete\u007f'], new Array(2)]) {
    assert.throws(() => parseRequest({ kind: 'context-menu', items: invalid }));
  }
});
