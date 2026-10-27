import type { ChatMessage, ImageContent, Json, JsonRecord, ToolActivity } from '../shared/types';
import { isRecord } from './frames';
import { sanitizeDiagnostic } from './diagnostics';
import { isImageContent } from '../shared/validation';

export class MessageStore {
  readonly messages = new Map<string, ChatMessage>();
  readonly tools = new Map<string, ToolActivity>();
  private blocks = new Map<string, Map<number, JsonRecord>>();
  private finalized = new Set<string>();
  private owners = new Map<string, string>();
  private readonly userSources = new Map<string, JsonRecord>();
  private restoring = false;
  constructor(private readonly emitMessage: (message: ChatMessage) => void, private readonly emitTool: (tool: ToolActivity) => void) {}
  userSource(id: string): JsonRecord | undefined { return this.userSources.get(id); }

  consume(frame: JsonRecord): void {
    if (frame.type === 'message_start' || frame.type === 'message_update' || frame.type === 'message_end') this.reduceMessage(frame);
    else if (typeof frame.toolCallId === 'string' && frame.toolCallId) {
      const tool: ToolActivity = this.tools.get(frame.toolCallId) ?? { id: frame.toolCallId, name: 'Tool', target: '', detail: '', output: '', state: 'pending', startedAt: Date.now(), endedAt: null };
      this.tools.set(tool.id, tool);
      if (typeof frame.toolName === 'string') tool.name = frame.toolName;
      switch (frame.type) {
        case 'tool_execution_start': tool.state = 'running'; tool.startedAt = Date.now(); this.describe(tool, frame.args); break;
        case 'tool_execution_update': tool.output = MessageStore.displayResult(frame.partialResult); break;
        case 'tool_stream_update': {
          const output = MessageStore.displayResult(frame.update);
          if (output) tool.output = output;
          if (isRecord(frame.update) && typeof frame.update.diff === 'string') tool.output = sanitizeDiagnostic(frame.update.diff, 65536);
          break;
        }
        case 'tool_execution_end': tool.output = MessageStore.displayResult(frame.result); tool.state = frame.isError === true ? 'failed' : 'succeeded'; tool.endedAt = Date.now(); break;
        default: return;
      }
      const owner = this.owners.get(tool.id);
      const message = owner ? this.messages.get(owner) : undefined;
      if (message && !message.toolIDs.includes(tool.id)) { message.toolIDs.push(tool.id); if (!this.restoring) this.emitMessage(message); }
      if (!this.restoring) this.emitTool(tool);
    }
  }
  restore(history: Json[]): void {
    this.restoring = true;
    this.messages.clear(); this.tools.clear(); this.blocks.clear(); this.finalized.clear(); this.owners.clear();
    this.userSources.clear();
    try {
      history.forEach((message, index) => this.reduceMessage({ type: 'message_end', messageId: `history-${index}`, message }));
      for (const tool of this.tools.values()) if (tool.state === 'pending' || tool.state === 'running') { tool.state = 'interrupted'; tool.endedAt = Date.now(); }
    } finally { this.restoring = false; }
  }
  interrupt(): void {
    for (const message of this.messages.values()) if (message.isStreaming) { message.isStreaming = false; this.emitMessage(message); }
    for (const tool of this.tools.values()) if (tool.state === 'pending' || tool.state === 'running') { tool.state = 'interrupted'; tool.endedAt = Date.now(); this.emitTool(tool); }
  }
  settle(): void {
    for (const message of this.messages.values()) if (message.isStreaming) { message.isStreaming = false; this.finalized.add(message.id); this.emitMessage(message); }
  }
  static displayResult(value: Json | undefined): string {
    if (typeof value === 'string') return sanitizeDiagnostic(value, 65536);
    if (!isRecord(value)) return '';
    const text = Array.isArray(value.content) ? value.content.flatMap(block => isRecord(block) && typeof block.text === 'string' ? [block.text] : []).join('\n') : '';
    return sanitizeDiagnostic(text || (typeof value.output === 'string' ? value.output : typeof value.text === 'string' ? value.text : typeof value.message === 'string' ? value.message : ''), 65536);
  }
  private reduceMessage(frame: JsonRecord): void {
    if (typeof frame.messageId !== 'string' || !frame.messageId) return;
    const id = frame.messageId;
    const snapshot: JsonRecord = isRecord(frame.message) ? frame.message : {};
    if (snapshot.role === 'toolResult') {
      if (typeof snapshot.toolCallId !== 'string') return;
      const tool: ToolActivity = this.tools.get(snapshot.toolCallId) ?? { id: snapshot.toolCallId, name: typeof snapshot.toolName === 'string' ? snapshot.toolName : 'Tool', target: '', detail: '', output: '', state: 'pending', startedAt: Date.now(), endedAt: null };
      tool.output = MessageStore.displayResult(snapshot); tool.state = snapshot.isError === true ? 'failed' : 'succeeded'; tool.endedAt = Date.now(); this.tools.set(tool.id, tool);
      if (!this.restoring) this.emitTool(tool);
      return;
    }
    if (this.finalized.has(id) && frame.type !== 'message_end') return;
    const existing = this.messages.get(id);
    const role = typeof snapshot.role === 'string' ? snapshot.role : existing?.role ?? 'assistant';
    const message: ChatMessage = existing ?? { id, role, text: '', thinking: '', error: null, isStreaming: false, toolIDs: [] };
    this.messages.set(id, message); message.role = role;
    if (role === 'user' && snapshot.content !== undefined) this.userSources.set(id, snapshot);
    if (typeof snapshot.customType === 'string') message.customType = snapshot.customType;
    if (isRecord(snapshot.details)) message.details = snapshot.details;
    if (typeof snapshot.display === 'boolean') message.display = snapshot.display;
    const event: JsonRecord = isRecord(frame.assistantMessageEvent) ? frame.assistantMessageEvent : {};
    const partial: JsonRecord = isRecord(event.partial) ? event.partial : {};
    if (snapshot.content !== undefined) this.replaceContent(snapshot.content, message);
    else if (partial.content !== undefined) this.replaceContent(partial.content, message);
    else if (frame.type === 'message_update') this.applyDelta(event, message);
    else if (role === 'bashExecution' || role === 'pythonExecution') message.text = sanitizeDiagnostic([snapshot.command ?? snapshot.code, snapshot.output].filter((value): value is string => typeof value === 'string' && !!value).join('\n\n'), 65536);
    else if (typeof snapshot.summary === 'string') message.text = snapshot.summary;
    if (typeof snapshot.errorMessage === 'string') message.error = sanitizeDiagnostic(snapshot.errorMessage);
    if (snapshot.stopReason === 'aborted') message.error = 'Interrupted';
    message.isStreaming = frame.type !== 'message_end' && role === 'assistant';
    if (frame.type === 'message_end') this.finalized.add(id);
    if (!this.restoring) this.emitMessage(message);
  }
  private replaceContent(content: Json, message: ChatMessage): void {
    const blocks = new Map<number, JsonRecord>();
    if (typeof content === 'string') blocks.set(0, { type: 'text', text: content });
    else if (Array.isArray(content)) content.forEach((block, index) => { if (isRecord(block)) blocks.set(index, block); });
    this.blocks.set(message.id, blocks); this.renderBlocks(message);
  }
  private applyDelta(event: JsonRecord, message: ChatMessage): void {
    const subtype = event.type;
    const index = event.contentIndex ?? 0;
    if (typeof subtype !== 'string' || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > 100000) return;
    let blocks = this.blocks.get(message.id);
    if (!blocks) { blocks = new Map(); this.blocks.set(message.id, blocks); }
    const old = blocks.get(index);
    let block: JsonRecord = { ...old };
    const kind = subtype.startsWith('thinking') ? 'thinking' : 'text';
    switch (subtype) {
      case 'text_start': case 'thinking_start': block = { type: kind }; break;
      case 'text_delta': case 'thinking_delta': block.type = kind; block[kind] = (typeof block[kind] === 'string' ? block[kind] : '') + (typeof event.delta === 'string' ? event.delta : ''); break;
      case 'text_end': case 'thinking_end': block.type = kind; block[kind] = typeof event.content === 'string' ? event.content : ''; break;
      case 'toolcall_end': if (isRecord(event.toolCall)) block = event.toolCall; else return; break;
      default: return;
    }
    blocks.set(index, block);
    if ((subtype === 'text_delta' || subtype === 'thinking_delta') && (!old || old.type === kind)) {
      let previous = false, later = false;
      for (const [position, entry] of blocks) {
        if (entry.type === kind && typeof entry[kind] === 'string') {
          if (position < index) previous = true;
          if (position > index) later = true;
        }
      }
      if (!later) {
        const delta = (typeof old?.[kind] !== 'string' && previous ? '\n\n' : '') + (typeof event.delta === 'string' ? event.delta : '');
        if (kind === 'text') message.text += delta; else message.thinking += delta;
        return;
      }
    }
    if ((subtype === 'text_end' || subtype === 'thinking_end') && old?.[kind] === event.content) return;
    this.renderBlocks(message);
  }
  private renderBlocks(message: ChatMessage): void {
    const text: string[] = [], thinking: string[] = [], calls: string[] = [];
    const images: ImageContent[] = [];
    const blocks = this.blocks.get(message.id);
    if (blocks) for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
      if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking.push(block.thinking);
      else if (isImageContent(block)) images.push({ type: block.type, mimeType: block.mimeType, data: block.data });
      else if (block.type === 'toolCall' && typeof block.id === 'string') {
        const tool: ToolActivity = this.tools.get(block.id) ?? { id: block.id, name: 'Tool', target: '', detail: '', output: '', state: 'pending', startedAt: Date.now(), endedAt: null };
        if (typeof block.name === 'string') tool.name = block.name;
        this.describe(tool, block.arguments); this.tools.set(tool.id, tool); this.owners.set(tool.id, message.id); calls.push(tool.id);
        if (!this.restoring) this.emitTool(tool);
      }
    }
    message.text = text.join('\n\n'); message.thinking = thinking.join('\n\n'); message.toolIDs = calls; message.images = images;
  }
  private describe(tool: ToolActivity, argumentsValue: Json | undefined): void {
    delete tool.paths;
    if (!isRecord(argumentsValue)) return;
    const purpose = [argumentsValue.i, argumentsValue.title].find(value => typeof value === 'string' && value.trim());
    const target = tool.name === 'eval' ? purpose : argumentsValue.path ?? argumentsValue.file_path ?? argumentsValue.command ?? argumentsValue.query ?? purpose;
    const paths = tool.name === 'edit' && typeof argumentsValue.input === 'string' ? MessageStore.patchTargets(argumentsValue.input) : [];
    if (paths.length) tool.paths = paths;
    tool.target = paths.join(', ') || (typeof target === 'string' ? sanitizeDiagnostic(target) : '');
    tool.detail = sanitizeDiagnostic(Object.entries(argumentsValue).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, value]) => /api.?key|token|password|secret|credential|authorization|^(?:content|data|images)$/i.test(key) || (typeof value !== 'string' && typeof value !== 'number') ? [] : [`${key}: ${sanitizeDiagnostic(String(value))}`]).join('\n'), 65536);
    if (tool.name === 'write' && typeof argumentsValue.content === 'string') tool.input = argumentsValue.content;
    else delete tool.input;
  }
  private static patchTargets(patch: string): string[] {
    if (!/^\*\*\* Begin Patch\r?\n/.test(patch)) return [];
    const paths = new Set<string>();
    const end = patch.indexOf('\n*** End Patch');
    let hasFile = false;
    // Only patch control lines identify files; source lines and incomplete headers do not.
    for (const match of patch.matchAll(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]\r?$|^MV (?:"([^"\r\n]+)"|([^"\r\n]+))\r?$/gm)) {
      if (end >= 0 && match.index > end) break;
      if (match[1] !== undefined) hasFile = true;
      else if (!hasFile) continue;
      const path = match[1] ?? match[2] ?? match[3];
      if (path) paths.add(sanitizeDiagnostic(path, path.length));
    }
    return [...paths];
  }
}
