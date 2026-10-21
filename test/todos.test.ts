import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTodo, committedTodoPhases, parseTodoPhases } from '../src/shared/todos';
import type { TodoPhase } from '../src/shared/types';

test('OMP phase parser keeps statuses and blocked metadata without sharing mutable engine data', () => {
  const raw: TodoPhase[] = [{ name: 'Implement', tasks: [
    { content: 'Inspect', status: 'completed' }, { content: 'Code', status: 'in_progress' },
    { content: 'Verify', status: 'pending' }, { content: 'Wait', status: 'blocked', blocker: 'Missing access', notes: ['Ask owner'], details: 'Needs credentials' },
    { content: 'Old approach', status: 'abandoned' },
  ] }];
  const parsed = parseTodoPhases(raw); assert.deepEqual(parsed, raw);
  assert.notEqual(parsed, raw); assert.notEqual(parsed?.[0]?.tasks, raw[0]?.tasks);
  parsed?.[0]?.tasks[3]?.notes?.push('Changed');
  assert.deepEqual(raw[0]?.tasks[3]?.notes, ['Ask owner']);
  for (const invalid of [null, {}, [{ name: 'Phase', tasks: [{ content: 'Task', status: 'done' }] }], [{ name: 'Phase', tasks: [{ content: 'Task', status: 'blocked', blocker: 1 }] }], [{ name: 'Phase', tasks: [{ content: 'Task', status: 'pending', notes: ['ok', 2] }] }]]) assert.equal(parseTodoPhases(invalid), null);
  assert.deepEqual(parseTodoPhases([]), []);
});

test('active task preserves phase order but prioritizes actual in-progress work over pending work', () => {
  const phases: TodoPhase[] = [
    { name: 'First', tasks: [{ content: 'Blocked', status: 'blocked' }, { content: 'Pending first', status: 'pending' }] },
    { name: 'Second', tasks: [{ content: 'Current', status: 'in_progress' }, { content: 'Later', status: 'pending' }] },
  ];
  assert.equal(activeTodo(phases)?.content, 'Current');
  phases[1]?.tasks.splice(0, 1);
  assert.equal(activeTodo(phases)?.content, 'Pending first');
  assert.equal(activeTodo([{ name: 'Finished', tasks: [{ content: 'Done', status: 'completed' }, { content: 'Dropped', status: 'abandoned' }] }]), undefined);
});

test('only successful state-changing todo results commit snapshots, including clearing the list', () => {
  const phases = [{ name: 'Phase', tasks: [{ content: 'Task', status: 'completed' }] }];
  assert.deepEqual(committedTodoPhases({ details: { op: 'done', phases } }), phases);
  assert.deepEqual(committedTodoPhases({ details: { phases } }), phases);
  assert.equal(committedTodoPhases({ isError: true, details: { op: 'done', phases } }), null);
  assert.equal(committedTodoPhases({ details: { op: 'view', phases } }), null);
  assert.equal(committedTodoPhases({ details: { op: 'init', phases: 'untrusted' } }), null);
  assert.deepEqual(committedTodoPhases({ details: { op: 'rm', phases: [] } }), []);
});
