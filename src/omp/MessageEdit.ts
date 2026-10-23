import type { Json, JsonRecord } from '../shared/types';
import { isRecord, RpcError } from './frames';

/** RPC message IDs are ephemeral. Resolve only an unambiguous active-path entry. */
export function editableEntry(history: Json, source: JsonRecord): { id: string; message: JsonRecord } {
  if (!isRecord(history) || !Array.isArray(history.entries) || typeof history.leafId !== 'string' || typeof source.timestamp !== 'number') {
    throw new RpcError('protocol', 'This message cannot be matched to saved history. Reopen the conversation before editing it.');
  }
  const entries = new Map<string, JsonRecord>();
  for (const entry of history.entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || (entry.parentId !== null && typeof entry.parentId !== 'string') || entries.has(entry.id)) {
      throw new RpcError('protocol', 'OMP returned invalid saved history. No message was edited.');
    }
    entries.set(entry.id, entry);
  }
  const seen = new Set<string>(), matches: JsonRecord[] = [];
  let id: string | null = history.leafId;
  while (id !== null) {
    const entry = entries.get(id);
    if (!entry || seen.has(id)) throw new RpcError('protocol', 'OMP returned incomplete saved history. No message was edited.');
    seen.add(id);
    if (entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user' && entry.message.timestamp === source.timestamp) {
      matches.push(entry);
    }
    id = typeof entry.parentId === 'string' ? entry.parentId : null;
  }
  // Same-millisecond messages can exist. Content disambiguates, never a first-match guess.
  const content = JSON.stringify(source.content);
  const exact = matches.filter(entry => isRecord(entry.message) && JSON.stringify(entry.message.content) === content);
  const selected = exact[0];
  if (exact.length !== 1 || !selected || typeof selected.id !== 'string' || !isRecord(selected.message)) throw new RpcError('invalid', 'This message is no longer uniquely available in the active history. No message was edited.');
  return { id: selected.id, message: selected.message };
}
