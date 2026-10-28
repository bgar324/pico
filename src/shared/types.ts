import type { ConnectionsSnapshot } from './connections';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonRecord = { [key: string]: Json };
export interface Project { id: string; path: string; expanded: boolean }
export interface ThreadRecord {
  id: string; projectPath: string; displayTitle: string; ompSessionDirectory: string;
  createdAt: string; updatedAt: string; draft: string; lastModel?: string; wasRunning: boolean;
  nativeTitleAttemptedFor?: string; ompSessionFile?: string;
}
export interface Manifest { projects: Project[]; threads: ThreadRecord[]; selectedThreadID: string | null; sidebarVisible: boolean }
export interface Preferences { executableOverride: string; appearance: 'system' | 'light' | 'dark'; defaultProjectPath: string; sidebarWidth: number }
export interface ModelChoice { id: string; provider: string; modelID: string; name: string; supportsImages: boolean }
export interface ChatMessage { id: string; role: string; text: string; thinking: string; error: string | null; isStreaming: boolean; toolIDs: string[]; images?: ImageContent[]; customType?: string; details?: JsonRecord; display?: boolean; delivery?: { kind: 'steer'; status: 'sending' | 'accepted'; queue: 'followUp' | 'steering'; imageRef: string | null } }
export interface ToolActivity { id: string; name: string; target: string; paths?: string[]; detail: string; input?: string; output: string; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted'; startedAt: number; endedAt: number | null }
export interface DialogRequest { id: string; method: 'confirm' | 'select' | 'input' | 'editor' | 'ask'; title: string; message: string; frame: JsonRecord; deadline: number | null; error: string | null }
export interface SubagentActivity { id: string; title: string; status: string; detail: string; messageID: string | null }
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked';
export interface TodoItem { content: string; status: TodoStatus; blocker?: string; details?: string; notes?: string[] }
export interface TodoPhase { name: string; tasks: TodoItem[] }
export type RuntimeStatus = { kind: 'connecting' } | { kind: 'ready'; activity: 'idle' | 'running' | 'background' | 'stopping' } | { kind: 'closed'; reason: string | null };
export interface WorkPeriod { id: string; startedAt: number; endedAt: number | null; messageID: string | null }
export interface QueuedMessage { text: string; imageCount: number; imageRef: string | null }
export interface RuntimeSummary { id: string; revision: number; status: RuntimeStatus; error: string | null; notice: string | null; models: ModelChoice[]; selectedModelID: string; thinkingLevels: string[]; thinkingLevel: string; contextUsage: { tokens: number; contextWindow: number } | null; dialogs: DialogRequest[]; subagents: SubagentActivity[]; todoPhases: TodoPhase[]; queuedFollowUps: QueuedMessage[]; queuedSteers: QueuedMessage[]; workPeriods?: WorkPeriod[] }
export interface RuntimeSnapshot extends RuntimeSummary { messages: ChatMessage[]; tools: ToolActivity[] }
export interface AppInfo { revision: number; manifest: Manifest; preferences: Preferences; executablePath: string | null; connectionStatus: string; error: string | null; theme: 'light' | 'dark' }
export interface AppSnapshot extends AppInfo { runtimes: RuntimeSnapshot[] }
export type RuntimeEvent = { kind: 'snapshot'; runtime: RuntimeSnapshot } | { kind: 'summary'; runtime: RuntimeSummary } | { kind: 'message'; threadID: string; revision: number; message: ChatMessage } | { kind: 'tool'; threadID: string; revision: number; tool: ToolActivity };
export type UiCommand = 'new-thread' | 'open-project' | 'toggle-sidebar' | 'toggle-changes' | 'quick-switcher' | 'find' | 'send' | 'stop' | 'settings';
export type UiEvent = { kind: 'app'; snapshot: AppInfo } | { kind: 'runtime'; event: RuntimeEvent } | { kind: 'command'; command: UiCommand } | { kind: 'connections'; snapshot: ConnectionsSnapshot };
export interface GitFileChange { path: string; status: string; additions: number | null; deletions: number | null; originalPath: string | null }
export interface GitSnapshot { branch: string; files: GitFileChange[] }
export interface GitDiff { staged: string; unstaged: string; truncated: boolean }
export type ImageContent = { type: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string };
export interface ImageAttachment { id: string; name: string; byteCount: number; frame: ImageContent }
export interface RetractedMessage { text: string; images: ImageContent[]; imagesDropped: boolean }
export type AppRequest =
  | { kind: 'snapshot' } | { kind: 'open-project' } | { kind: 'add-project'; path: string }
  | { kind: 'context-menu'; items: string[] } | { kind: 'close-context-menu' }
  | { kind: 'new-thread'; projectPath?: string } | { kind: 'select-thread'; id: string; reopen?: boolean }
  | { kind: 'draft'; id: string; text: string }
  | { kind: 'prompt'; id: string; message: string; steer: boolean; images: JsonRecord[] }
  | { kind: 'abort'; id: string } | { kind: 'model'; id: string; modelID: string } | { kind: 'thinking'; id: string; level: string }
  | { kind: 'dialog'; id: string; dialogID: string; fields: JsonRecord }
  | { kind: 'rename-thread'; id: string; title: string } | { kind: 'delete-thread'; id: string }
  | { kind: 'remove-project'; id: string } | { kind: 'locate-project'; path: string }
  | { kind: 'sidebar'; visible: boolean } | { kind: 'project-expanded'; id: string; expanded: boolean }
  | { kind: 'preferences'; preferences: Preferences } | { kind: 'choose-executable' } | { kind: 'test-connection' }
  | { kind: 'get-connections' }
  | { kind: 'connect-provider'; providerId: string; flowId: string }
  | { kind: 'connection-input'; flowId: string; promptId: string; value: string }
  | { kind: 'cancel-connection'; flowId: string }
  | { kind: 'save-provider-key'; providerId: string; key: string }
  | { kind: 'disconnect-provider'; providerId: string; credentialId: number }
  | { kind: 'diagnostics' } | { kind: 'reveal-project'; path: string } | { kind: 'reveal-session'; id: string }
  | { kind: 'terminal'; id: string } | { kind: 'attach-images'; id: string }
  | { kind: 'copy-message'; id: string; messageID: string }
  | { kind: 'edit-message'; id: string; messageID: string; message: string }
  | { kind: 'promote-queued'; id: string; message: string }
  | { kind: 'retract-queued'; id: string; queue: 'steering' | 'followUp'; message: string; imageRef: string | null }
  | { kind: 'queued-images'; id: string; imageRef: string }
  | { kind: 'git-status'; projectPath: string } | { kind: 'git-diff'; projectPath: string; file: GitFileChange }
  | { kind: 'open-file'; projectPath: string; file: GitFileChange; reveal: boolean }
  | { kind: 'open-url'; url: string } | { kind: 'session-stats'; id: string }
  | { kind: 'open-local-link'; id: string; url: string };
export type AppResult = AppSnapshot | ConnectionsSnapshot | GitSnapshot | GitDiff | ImageAttachment[] | readonly ImageContent[] | RetractedMessage | Json | boolean | null;
export type BridgeResult = { ok: true; value: AppResult } | { ok: false; error: string };
export interface PiBridge { request(request: AppRequest): Promise<BridgeResult>; subscribe(listener: (event: UiEvent) => void): () => void; pathsFromDrop(files: File[]): string[] }
export function isBusy(status: RuntimeStatus): boolean { return status.kind === 'ready' && status.activity !== 'idle' }
export function isReady(status: RuntimeStatus): boolean { return status.kind === 'ready' }
