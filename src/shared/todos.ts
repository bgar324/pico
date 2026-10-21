import type { TodoItem, TodoPhase, TodoStatus } from './types';
import { record as isRecord } from './validation';

// OMP 18.6: packages/tui/src/tools/todo.ts and modes/rpc/rpc-types.ts.
function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'abandoned' || value === 'blocked';
}
function isTodoItem(value: unknown): value is TodoItem {
  return isRecord(value) && typeof value.content === 'string' && isTodoStatus(value.status)
    && (value.blocker === undefined || typeof value.blocker === 'string')
    && (value.details === undefined || typeof value.details === 'string')
    && (value.notes === undefined || Array.isArray(value.notes) && value.notes.every(note => typeof note === 'string'));
}
export function isTodoPhases(value: unknown): value is TodoPhase[] {
  return Array.isArray(value) && value.every(phase => isRecord(phase) && typeof phase.name === 'string' && Array.isArray(phase.tasks) && phase.tasks.every(isTodoItem));
}
export function parseTodoPhases(value: unknown): TodoPhase[] | null {
  return isTodoPhases(value) ? value.map(phase => ({ name: phase.name, tasks: phase.tasks.map(task => ({ ...task, ...(task.notes ? { notes: [...task.notes] } : {}) })) })) : null;
}

/** Match OMP's nextActionableTask: in-progress first, otherwise first pending. */
export function activeTodo(phases: readonly TodoPhase[]): TodoItem | undefined {
  let pending: TodoItem | undefined;
  for (const phase of phases) for (const task of phase.tasks) {
    if (task.status === 'in_progress') return task;
    if (!pending && task.status === 'pending') pending = task;
  }
  return pending;
}

/** Failed results and pure views do not replace canonical state. */
export function committedTodoPhases(result: unknown): TodoPhase[] | null {
  if (!isRecord(result) || result.isError === true || !isRecord(result.details) || result.details.op === 'view') return null;
  return parseTodoPhases(result.details.phases);
}
