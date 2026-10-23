import test from 'node:test';
import assert from 'node:assert/strict';
import { editableEntry } from '../src/omp/MessageEdit';

const user = (timestamp: number, text = 'Repeated prompt') => ({ role: 'user', timestamp, content: [{ type: 'text', text }] });

test('sent edits resolve a durable user on the active path, not a same-text sibling branch', () => {
  const first = user(10), selected = user(20);
  const history = { leafId: 'last', entries: [
    { type: 'message', id: 'first', parentId: null, message: first },
    { type: 'message', id: 'inactive-copy', parentId: 'first', message: selected },
    { type: 'message', id: 'selected', parentId: 'first', message: selected },
    { type: 'message', id: 'last', parentId: 'selected', message: { role: 'assistant', content: 'Response' } },
  ] };
  assert.equal(editableEntry(history, selected).id, 'selected');
  assert.equal(editableEntry(history, first).id, 'first');
});

test('same-timestamp users require matching full content and refuse an unresolved duplicate', () => {
  const source = user(10);
  const history = { leafId: 'b', entries: [
    { type: 'message', id: 'a', parentId: null, message: source },
    { type: 'message', id: 'b', parentId: 'a', message: user(10, 'Different prompt') },
  ] };
  assert.equal(editableEntry(history, source).id, 'a');
  const duplicate = history.entries[1]; assert.ok(duplicate); duplicate.message = source;
  assert.throws(() => editableEntry(history, source), /uniquely/);
});

test('missing, cyclic, stale or image-mismatched history never selects another user', () => {
  const source = user(10);
  for (const history of [
    { leafId: 'missing', entries: [] },
    { leafId: 'a', entries: [{ id: 'a', type: 'message', parentId: 'a', message: source }] },
    { leafId: 'a', entries: [{ id: 'a', type: 'message', parentId: null, message: user(11) }] },
    { leafId: 'a', entries: [{ id: 'a', type: 'message', parentId: null, message: { ...source, content: [...source.content, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } }] },
  ]) assert.throws(() => editableEntry(history, source));
});
