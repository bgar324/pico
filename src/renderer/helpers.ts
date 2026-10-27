import type { AppSnapshot, ChatMessage, GitDiff, GitSnapshot, ImageAttachment, Json, JsonRecord, QueuedMessage, RetractedMessage, RuntimeEvent, RuntimeSnapshot, ThreadRecord, ToolActivity } from '../shared/types';
import { isTodoPhases } from '../shared/todos';
import { imageByteCount, isImageContent } from '../shared/validation';

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
export function jsonRecord(value: Json | undefined): JsonRecord | null { return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }
export function isGitSnapshot(value: unknown): value is GitSnapshot {
  return isRecord(value) && typeof value.branch === 'string' && Array.isArray(value.files) && value.files.every(file => isRecord(file) && typeof file.path === 'string' && typeof file.status === 'string' && (file.additions === null || typeof file.additions === 'number') && (file.deletions === null || typeof file.deletions === 'number') && (file.originalPath === null || typeof file.originalPath === 'string'));
}
export function isGitDiff(value: unknown): value is GitDiff { return isRecord(value) && typeof value.staged === 'string' && typeof value.unstaged === 'string' && typeof value.truncated === 'boolean'; }
export function isAttachments(value: unknown): value is ImageAttachment[] {
  return Array.isArray(value) && value.length <= 20 && value.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && isImageContent(item.frame) && item.byteCount === imageByteCount(item.frame));
}
export function isRetractedMessage(value: unknown): value is RetractedMessage {
  return isRecord(value) && typeof value.text === 'string' && typeof value.imagesDropped === 'boolean' && Array.isArray(value.images) && value.images.every(isImageContent);
}
function isQueuedMessages(value: unknown): value is QueuedMessage[] {
  return Array.isArray(value) && value.every(item => isRecord(item) && typeof item.text === 'string' && typeof item.imageCount === 'number' && Number.isSafeInteger(item.imageCount) && item.imageCount >= 0 &&
    (item.imageCount === 0 ? item.imageRef === null : typeof item.imageRef === 'string' && item.imageRef.length > 0 && !item.imageRef.includes('\0')));
}
function isMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || value.customType !== undefined && typeof value.customType !== 'string' || value.details !== undefined && (!isRecord(value.details) || !isJson(value.details))) return false;
  if (value.display !== undefined && typeof value.display !== 'boolean') return false;
  if (value.images !== undefined && (!Array.isArray(value.images) || !value.images.every(isImageContent))) return false;
  return isRecord(value) && typeof value.id === 'string' && typeof value.role === 'string' && typeof value.text === 'string' && typeof value.thinking === 'string' && (value.error === null || typeof value.error === 'string') && typeof value.isStreaming === 'boolean' && Array.isArray(value.toolIDs) && value.toolIDs.every(id => typeof id === 'string');
}
function isTool(value: unknown): value is ToolActivity {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.target === 'string' && (value.paths === undefined || (Array.isArray(value.paths) && value.paths.every(path => typeof path === 'string'))) && typeof value.detail === 'string' && (value.input === undefined || typeof value.input === 'string') && typeof value.output === 'string' && ['pending', 'running', 'succeeded', 'failed', 'interrupted'].includes(String(value.state)) && typeof value.startedAt === 'number' && (value.endedAt === null || typeof value.endedAt === 'number');
}
function isWorkPeriods(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const [index, period] of value.entries()) {
    if (!isRecord(period) || typeof period.id !== 'string' || !period.id || ids.has(period.id) || typeof period.startedAt !== 'number' || !Number.isFinite(period.startedAt) || period.startedAt < previousEnd || (period.messageID !== null && (typeof period.messageID !== 'string' || !period.messageID))) return false;
    if (period.endedAt === null) {
      if (index !== value.length - 1) return false;
    } else {
      if (typeof period.endedAt !== 'number' || !Number.isFinite(period.endedAt) || period.endedAt < period.startedAt) return false;
      previousEnd = period.endedAt;
    }
    ids.add(period.id);
  }
  return true;
}
export function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.revision !== 'number' || !isRecord(value.status)) return false;
  const status = value.status;
  if (!(status.kind === 'connecting' || status.kind === 'closed' && (status.reason === null || typeof status.reason === 'string') || status.kind === 'ready' && ['idle', 'running', 'background', 'stopping'].includes(String(status.activity)))) return false;
  const usage = value.contextUsage;
  if (usage !== null && (!isRecord(usage) || typeof usage.tokens !== 'number' || !Number.isFinite(usage.tokens) || usage.tokens < 0 || typeof usage.contextWindow !== 'number' || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0)) return false;
  if (value.workPeriods !== undefined && !isWorkPeriods(value.workPeriods)) return false;
  if (!isTodoPhases(value.todoPhases) || !Array.isArray(value.subagents) || !value.subagents.every(agent => isRecord(agent) && (agent.messageID === null || typeof agent.messageID === 'string'))) return false;
  return (value.error === null || typeof value.error === 'string') && (value.notice === null || typeof value.notice === 'string') && typeof value.selectedModelID === 'string' && typeof value.thinkingLevel === 'string' && Array.isArray(value.thinkingLevels) && value.thinkingLevels.every(item => typeof item === 'string') && isQueuedMessages(value.queuedFollowUps) && isQueuedMessages(value.queuedSteers) && Array.isArray(value.models) && value.models.every(model => isRecord(model) && typeof model.id === 'string' && typeof model.provider === 'string' && typeof model.modelID === 'string' && typeof model.name === 'string' && typeof model.supportsImages === 'boolean') && Array.isArray(value.dialogs) && value.dialogs.every(dialog => isRecord(dialog) && typeof dialog.id === 'string' && ['confirm', 'select', 'input', 'editor', 'ask'].includes(String(dialog.method)) && typeof dialog.title === 'string' && typeof dialog.message === 'string' && isRecord(dialog.frame) && isJson(dialog.frame) && (dialog.deadline === null || typeof dialog.deadline === 'number') && (dialog.error === null || typeof dialog.error === 'string')) && Array.isArray(value.subagents) && value.subagents.every(agent => isRecord(agent) && typeof agent.id === 'string' && typeof agent.title === 'string' && typeof agent.status === 'string' && typeof agent.detail === 'string') && Array.isArray(value.messages) && value.messages.every(isMessage) && Array.isArray(value.tools) && value.tools.every(isTool);
}
export function isAppSnapshot(value: unknown): value is AppSnapshot {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.preferences)) return false;
  const m = value.manifest; const p = value.preferences;
  if (Array.isArray(m.threads) && m.threads.some(thread => isRecord(thread) && thread.nativeTitleAttemptedFor !== undefined && typeof thread.nativeTitleAttemptedFor !== 'string')) return false;
  return typeof value.revision === 'number' && (value.executablePath === null || typeof value.executablePath === 'string') && typeof value.connectionStatus === 'string' && (value.error === null || typeof value.error === 'string') && (value.theme === 'light' || value.theme === 'dark') && Array.isArray(m.projects) && m.projects.every(project => isRecord(project) && typeof project.id === 'string' && typeof project.path === 'string' && typeof project.expanded === 'boolean') && Array.isArray(m.threads) && m.threads.every(thread => isRecord(thread) && typeof thread.id === 'string' && typeof thread.projectPath === 'string' && typeof thread.displayTitle === 'string' && typeof thread.ompSessionDirectory === 'string' && typeof thread.createdAt === 'string' && typeof thread.updatedAt === 'string' && typeof thread.draft === 'string' && typeof thread.wasRunning === 'boolean' && (thread.lastModel === undefined || typeof thread.lastModel === 'string')) && (m.selectedThreadID === null || typeof m.selectedThreadID === 'string') && typeof m.sidebarVisible === 'boolean' && typeof p.executableOverride === 'string' && ['system', 'light', 'dark'].includes(String(p.appearance)) && typeof p.defaultProjectPath === 'string' && typeof p.sidebarWidth === 'number' && Array.isArray(value.runtimes) && value.runtimes.every(isRuntimeSnapshot);
}

const compactTokens = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export function formatContextUsage(usage: NonNullable<RuntimeSnapshot['contextUsage']>): string {
  return `${compactTokens.format(usage.tokens)}/${compactTokens.format(usage.contextWindow)}`;
}

export function fuzzyScore(query: string, target: string): number | null {
  const needle = query.trim().toLocaleLowerCase(); const text = target.toLocaleLowerCase();
  if (!needle) return 0;
  let score = 0; let previous = -1;
  for (const character of needle) {
    const index = text.indexOf(character, previous + 1);
    if (index < 0) return null;
    score += index === previous + 1 ? 12 : 1;
    if (index === 0 || '/ _-'.includes(text.charAt(index - 1))) score += 8;
    score -= (index - previous - 1) * 0.1;
    previous = index;
  }
  return score - text.length * 0.001;
}
export function sortedThreads(threads: ThreadRecord[]): ThreadRecord[] {
  return threads.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
export interface DiffLine { kind: 'context' | 'added' | 'removed' | 'header'; old: number | null; next: number | null; text: string }
export function diffLines(text: string): DiffLine[] {
  let old = 0; let next = 0; let inHunk = false;
  return text.split('\n').map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) { old = Number(match[1]); next = Number(match[2]); inHunk = true; return { kind: 'header', old: null, next: null, text: line }; }
    if (!inHunk || line.startsWith('\\')) return { kind: 'header', old: null, next: null, text: line };
    if (line.startsWith('+')) return { kind: 'added', old: null, next: next++, text: line };
    if (line.startsWith('-')) return { kind: 'removed', old: old++, next: null, text: line };
    if (line.startsWith(' ')) return { kind: 'context', old: old++, next: next++, text: line };
    return { kind: 'header', old: null, next: null, text: line };
  });
}

/** Late initial snapshots cannot replace newer streamed runtime revisions. */
export function reduceRuntime(runtimes: Map<string, RuntimeSnapshot>, event: RuntimeEvent): boolean {
  const id = event.kind === 'snapshot' || event.kind === 'summary' ? event.runtime.id : event.threadID;
  const revision = event.kind === 'snapshot' || event.kind === 'summary' ? event.runtime.revision : event.revision;
  const existing = runtimes.get(id);
  if (existing && revision <= existing.revision) return false;
  if (event.kind === 'snapshot') { runtimes.set(id, event.runtime); return true; }
  if (event.kind === 'summary') {
    runtimes.set(id, { ...event.runtime, messages: existing?.messages ?? [], tools: existing?.tools ?? [] }); return true;
  }
  if (!existing) return false;
  if (event.kind === 'message') {
    const messages = existing.messages.slice();
    const index = messages.findIndex(message => message.id === event.message.id);
    if (index < 0) messages.push(event.message); else messages[index] = event.message;
    runtimes.set(id, { ...existing, revision, messages });
  } else {
    const tools = existing.tools.slice();
    const index = tools.findIndex(tool => tool.id === event.tool.id);
    if (index < 0) tools.push(event.tool); else tools[index] = event.tool;
    runtimes.set(id, { ...existing, revision, tools });
  }
  return true;
}
