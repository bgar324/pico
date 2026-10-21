import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeSnapshot, ChatMessage, ToolActivity } from '../src/shared/types';
import { diffLines, formatContextUsage, fuzzyScore, isAttachments, isGitDiff, isGitSnapshot, isRuntimeSnapshot, reduceRuntime, sortedThreads } from '../src/renderer/helpers';
import { displaySessionTitle } from '../src/shared/titles';

function runtime(): RuntimeSnapshot {
  return { id: 'thread', revision: 1, status: { kind: 'ready', activity: 'idle' }, error: null, notice: null, models: [], selectedModelID: '', thinkingLevels: [], thinkingLevel: '', contextUsage: null, dialogs: [], subagents: [], todoPhases: [], queuedFollowUps: [], queuedSteers: [], messages: [], tools: [] };
}
const message: ChatMessage = { id: 'message', role: 'assistant', text: 'Actual streamed text', thinking: '', error: null, isStreaming: true, toolIDs: [] };
const tool: ToolActivity = { id: 'tool', name: 'Read', target: 'src/index.ts', detail: '', output: 'source', state: 'running', startedAt: 1, endedAt: null };

test('runtime message/tool/summary transitions leave frozen bridge snapshots untouched', () => {
  const initial = runtime(); Object.freeze(initial.messages); Object.freeze(initial.tools); Object.freeze(initial);
  const cache = new Map([[initial.id, initial]]);
  assert.equal(reduceRuntime(cache, { kind: 'message', threadID: initial.id, revision: 2, message }), true);
  const afterMessage = cache.get(initial.id); assert.notEqual(afterMessage, initial); assert.equal(afterMessage?.messages[0], message); assert.equal(initial.messages.length, 0);
  if (!afterMessage) throw new Error('Missing runtime'); Object.freeze(afterMessage.messages); Object.freeze(afterMessage);
  assert.equal(reduceRuntime(cache, { kind: 'tool', threadID: initial.id, revision: 3, tool }), true);
  const afterTool = cache.get(initial.id); assert.equal(afterTool?.tools[0], tool); assert.equal(afterMessage.tools.length, 0);
  const summary = { ...initial, revision: 4, status: { kind: 'ready', activity: 'running' } } satisfies RuntimeSnapshot;
  assert.equal(reduceRuntime(cache, { kind: 'summary', runtime: summary }), true);
  assert.equal(cache.get(initial.id)?.messages[0], message); assert.equal(cache.get(initial.id)?.tools[0], tool);
  assert.equal(reduceRuntime(cache, { kind: 'snapshot', runtime: initial }), false);
  assert.equal(cache.get(initial.id)?.revision, 4);
});

test('canonical message updates replace by identity instead of duplicating tokens', () => {
  const initial = runtime(); const cache = new Map([[initial.id, initial]]);
  reduceRuntime(cache, { kind: 'message', threadID: initial.id, revision: 2, message });
  reduceRuntime(cache, { kind: 'message', threadID: initial.id, revision: 3, message: { ...message, text: 'Complete canonical text', isStreaming: false } });
  assert.equal(cache.get(initial.id)?.messages.length, 1); assert.equal(cache.get(initial.id)?.messages[0]?.text, 'Complete canonical text');
  assert.equal(reduceRuntime(cache, { kind: 'message', threadID: initial.id, revision: 2, message }), false);
});

test('compact current-context counts preserve useful precision without capping the window', () => {
  for (const [tokens, expected] of [[0, '0/922K'], [999, '999/922K'], [1000, '1K/922K'], [2500, '2.5K/922K'], [99950, '100K/922K'], [1000000, '1M/922K'], [4000000, '4M/922K'], [1000000000, '1B/922K']] as const) {
    assert.equal(formatContextUsage({ tokens, contextWindow: 922000 }), expected);
  }
  assert.equal(formatContextUsage({ tokens: 2500, contextWindow: 1000000 }), '2.5K/1M');
});

test('runtime bridge requires nullable, finite current context usage with a positive window', () => {
  assert.equal(isRuntimeSnapshot(runtime()), true);
  assert.equal(isRuntimeSnapshot({ ...runtime(), contextUsage: { tokens: 4000000, contextWindow: 922000 } }), true);
  assert.equal(isRuntimeSnapshot({ ...runtime(), contextUsage: { tokens: 0, contextWindow: 1 } }), true);
  const { contextUsage: _usage, ...missing } = runtime();
  assert.equal(isRuntimeSnapshot(missing), false);
  for (const contextUsage of [undefined, {}, { tokens: -1, contextWindow: 922000 }, { tokens: NaN, contextWindow: 922000 }, { tokens: Infinity, contextWindow: 922000 }, { tokens: 2500, contextWindow: 0 }, { tokens: 2500, contextWindow: -1 }, { tokens: 2500, contextWindow: Infinity }, { tokens: 2500, contextWindow: NaN }]) {
    assert.equal(isRuntimeSnapshot({ ...runtime(), contextUsage }), false);
  }
});
test('runtime bridge accepts only bounded, ordered observed work periods with unique identities', () => {
  const completed = { id: 'round-one', startedAt: 1000, endedAt: 3000, messageID: 'native-user' };
  const active = { id: 'round-two', startedAt: 3000, endedAt: null, messageID: null };
  assert.equal(isRuntimeSnapshot({ ...runtime(), workPeriods: [] }), true);
  assert.equal(isRuntimeSnapshot({ ...runtime(), workPeriods: [completed, active] }), true);
  assert.equal(isRuntimeSnapshot({ ...runtime(), workPeriods: [{ ...active, endedAt: 3000 }] }), true);
  assert.equal(isRuntimeSnapshot(runtime()), true);
  for (const workPeriods of [
    null, {}, [null], [{}],
    [{ ...active, id: '' }], [{ ...active, id: 1 }],
    [{ ...active, startedAt: NaN }], [{ ...active, startedAt: Infinity }],
    [{ ...active, startedAt: -1 }], [{ ...active, startedAt: '3000' }],
    [{ ...active, endedAt: undefined }], [{ ...active, endedAt: NaN }],
    [{ ...active, endedAt: Infinity }], [{ ...active, endedAt: 2999 }],
    [{ ...active, messageID: undefined }], [{ ...active, messageID: '' }], [{ ...active, messageID: 1 }],
    [completed, { ...active, id: completed.id }],
    [completed, { ...active, startedAt: 2999 }],
    [active, { ...completed, startedAt: 4000, endedAt: 5000 }],
    [{ ...active, id: 'first-active' }, active],
    Array.from({ length: 33 }, (_, index) => ({ ...completed, id: `round-${index}`, startedAt: index, endedAt: index })),
  ]) assert.equal(isRuntimeSnapshot({ ...runtime(), workPeriods }), false, JSON.stringify(workPeriods));
});



test('context summaries stay thread-local across selected-thread changes and token updates', () => {
  const a = { ...runtime(), id: 'a', contextUsage: { tokens: 2500, contextWindow: 922000 } };
  const b = { ...runtime(), id: 'b', contextUsage: { tokens: 4000000, contextWindow: 200000 } };
  const cache = new Map<string, RuntimeSnapshot>();
  reduceRuntime(cache, { kind: 'snapshot', runtime: a }); reduceRuntime(cache, { kind: 'snapshot', runtime: b });
  const display = (id: string): string | null => { const usage = cache.get(id)?.contextUsage; return usage ? formatContextUsage(usage) : null; };
  assert.equal(display('a'), '2.5K/922K'); assert.equal(display('b'), '4M/200K');
  reduceRuntime(cache, { kind: 'message', threadID: 'a', revision: 2, message });
  assert.equal(display('a'), '2.5K/922K');
  reduceRuntime(cache, { kind: 'summary', runtime: { ...a, revision: 3, contextUsage: null } });
  assert.equal(display('a'), null); assert.equal(display('b'), '4M/200K');
  assert.equal(reduceRuntime(cache, { kind: 'snapshot', runtime: a }), false);
  assert.equal(display('a'), null);
});

test('unified patch numbering handles independent hunks and no-newline markers', () => {
  const lines = diffLines('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -10,2 +20,2 @@\n same\n-old\n+new\n\\ No newline at end of file\n@@ -100 +90 @@\n-final\n+end');
  assert.deepEqual(lines[4], { kind: 'context', old: 10, next: 20, text: ' same' });
  assert.deepEqual(lines[5], { kind: 'removed', old: 11, next: null, text: '-old' });
  assert.deepEqual(lines[6], { kind: 'added', old: null, next: 21, text: '+new' });
  assert.equal(lines[7]?.old, null); assert.equal(lines[9]?.old, 100); assert.equal(lines[10]?.next, 90);
});

test('fuzzy switching ranks contiguous and boundary matches deterministically', () => {
  assert.equal(fuzzyScore('xyz', 'Fix auth'), null);
  assert.equal(fuzzyScore('', 'anything'), 0);
  const exact = fuzzyScore('auth', 'Auth'); const scattered = fuzzyScore('auth', 'a longer useful title here');
  assert.ok(exact !== null); assert.ok(scattered === null || exact > scattered);
  assert.equal(fuzzyScore('Ab', 'alpha_beta'), fuzzyScore('ab', 'alpha_beta'));
});

test('bridge result validators reject malformed arrays and patches', () => {
  assert.equal(isAttachments([{ id: 'i', name: 'i.png', byteCount: 1, frame: { type: 'image', mimeType: 'image/png', data: 'AA==' } }]), true);
  assert.equal(isAttachments([{ id: 'i', name: 'i.png', byteCount: 10, frame: null }]), false);
  assert.equal(isAttachments([{ id: 'i', name: 'i.png', byteCount: 10, frame: { type: 'image', mimeType: 'image/png', data: 'AA==' } }]), false);
  assert.equal(isAttachments([{ id: 'i', name: 'remote', byteCount: 1, frame: { type: 'image', mimeType: 'image/svg+xml', data: 'AA==' } }]), false);
  assert.equal(isGitDiff({ staged: '', unstaged: '', truncated: false }), true);
  assert.equal(isGitDiff({ staged: '', unstaged: '', truncated: 'false' }), false);
  assert.equal(isGitSnapshot({ branch: 'main', files: [{ path: 'a b', originalPath: null, status: ' M', additions: 3, deletions: 0 }] }), true);
  assert.equal(isGitSnapshot({ branch: 'main', files: [{ path: 'a b', status: ' M' }] }), false);
});

test('runtime bridge preserves valid image-only messages and rejects remote image content', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  assert.equal(isRuntimeSnapshot({ ...runtime(), messages: [{ ...message, text: '', images: [image] }] }), true);
  assert.equal(isRuntimeSnapshot({ ...runtime(), messages: [{ ...message, images: [{ ...image, data: 'https://example.com/image.png' }] }] }), false);
  assert.equal(isRuntimeSnapshot({ ...runtime(), messages: [{ ...message, images: [{ ...image, mimeType: 'image/svg+xml' }] }] }), false);
});

test('thread sorting is stable for equal timestamps without mutating metadata', () => {
  const base = { projectPath: '/repo', displayTitle: '', ompSessionDirectory: '/sessions', createdAt: '2026-01-01', updatedAt: '2026-01-01', draft: '', wasRunning: false };
  const threads = [{ ...base, id: 'b' }, { ...base, id: 'a' }, { ...base, id: 'c', updatedAt: '2026-02-01' }];
  assert.deepEqual(sortedThreads(threads).map(thread => thread.id), ['c', 'a', 'b']); assert.equal(threads[0]?.id, 'b');
});

test('native terminal-card titles display their readable task name', () => {
  assert.equal(displaySessionTitle('\u{F06A9} AGENTS: Move agents below todos'), 'Move agents below todos');
  assert.equal(displaySessionTitle('💬 CHAT: Explain title formatting'), 'Explain title formatting');
});

test('ordinary names and incomplete terminal cards retain their text', () => {
  for (const title of ['THINK: Consolidate controls', 'Fix auth: retry expired links', '🧠 Consolidate controls', 'Project AGENTS: Move agents', '\u{F06A9} AGENTS:']) {
    assert.equal(displaySessionTitle(title), title);
  }
});
