import type { ImageContent, QueuedMessage, RuntimeSnapshot } from '../shared/types';
import { isImageContent } from '../shared/validation';
import { element, errorText, iconButton, request } from './dom';
import { icon } from './icons';
import { MessageImages } from './message-images';

// Electron supports state-preserving DOM moves, which TS 5.9 does not declare.
declare global { interface Element { moveBefore(node: Node, child: Node | null): void } }

type QueueEntry = QueuedMessage & { steering: boolean };
export interface QueuedEditRequest {
  threadID: string;
  queue: 'steering' | 'followUp';
  entry: QueuedMessage;
  images: readonly ImageContent[] | undefined;
}
type PreviewState = { kind: 'loading' } | { kind: 'ready'; images: readonly ImageContent[] } | { kind: 'failed'; error: string };
interface PreviewResource { state: PreviewState }
interface QueuedRow {
  key: string;
  entry: QueueEntry;
  node: HTMLElement;
  body: HTMLElement;
  images: MessageImages;
  previewStatus: HTMLElement;
  actions: HTMLElement;
  send: HTMLButtonElement;
  edit: HTMLButtonElement;
  error: HTMLElement;
  ambiguous: boolean;
  ambiguousEdit: boolean;
  pendingAction: 'steer' | 'edit' | null;
  alreadySent: boolean;
  decodeFailed: boolean;
}

const SEND_TITLE = 'Steer the current run at its next interruption point';
const AMBIGUOUS_SEND = 'Steer the earlier queued message with the same text first. Steer cannot choose between their attachments.';
const AMBIGUOUS_EDIT = 'Cannot edit messages with the same text while any of them has attachments. Wait for the earlier message to send.';

export class QueuedMessages {
  readonly node = element('div', 'pending-messages');
  private signature = '';
  private threadID: string | null = null;
  private rows = new Map<string, QueuedRow>();
  private readonly resources = new Map<string, PreviewResource>();
  private disposed = false;

  onEdit: ((value: QueuedEditRequest) => Promise<void>) | null = null;
  constructor(private readonly onImageLoad: () => void) {}

  update(runtime: RuntimeSnapshot | undefined, threadID: string | null): void {
    if (this.disposed) return;
    if (threadID !== this.threadID) { this.clear(); this.threadID = threadID; }
    const entries: QueueEntry[] = runtime && threadID ? [
      ...runtime.queuedSteers.map(entry => ({ ...entry, steering: true })),
      ...runtime.queuedFollowUps.map(entry => ({ ...entry, steering: false })),
    ] : [];
    const signature = JSON.stringify(entries);
    if (signature === this.signature) return;
    this.signature = signature;
    const nextRows = new Map<string, QueuedRow>();
    const occurrences = new Map<string, number>();
    const earlierFollowUps = new Map<string, boolean>();
    const liveRefs = new Map<string, number>();
    const queueCounts = new Map<string, { count: number; hasImages: boolean }>();
    for (const entry of entries) {
      const key = JSON.stringify([entry.steering, entry.text]);
      const count = queueCounts.get(key);
      if (count) { count.count++; count.hasImages ||= entry.imageCount > 0; }
      else queueCounts.set(key, { count: 1, hasImages: entry.imageCount > 0 });
    }
    for (const entry of entries) {
      const identity = JSON.stringify([entry.imageRef === null ? 'text' : 'image', entry.imageRef ?? entry.text]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const key = JSON.stringify([identity, occurrence]);
      const row = this.rows.get(key) ?? this.createRow(key, entry);
      row.entry = entry;
      const earlierHasImages = earlierFollowUps.get(entry.text);
      row.ambiguous = !entry.steering && earlierHasImages !== undefined && (earlierHasImages || entry.imageCount > 0);
      if (!entry.steering) earlierFollowUps.set(entry.text, (earlierHasImages ?? false) || entry.imageCount > 0);
      const duplicates = queueCounts.get(JSON.stringify([entry.steering, entry.text]));
      row.ambiguousEdit = !!duplicates && duplicates.count > 1 && duplicates.hasImages;
      nextRows.set(key, row);
      if (entry.imageRef !== null) liveRefs.set(entry.imageRef, entry.imageCount);
    }
    for (const [key, row] of this.rows) if (!nextRows.has(key)) this.release(row);
    this.rows = nextRows;
    for (const ref of this.resources.keys()) if (!liveRefs.has(ref)) this.resources.delete(ref);
    for (const [ref, count] of liveRefs) if (!this.resources.has(ref) && threadID) {
      const resource: PreviewResource = { state: { kind: 'loading' } };
      this.resources.set(ref, resource);
      void this.loadImages(threadID, ref, count, resource);
    }
    for (const [index, row] of [...this.rows.values()].entries()) {
      const current = this.node.children[index] ?? null;
      if (current !== row.node) {
        if (row.node.parentElement === this.node) this.node.moveBefore(row.node, current);
        else this.node.insertBefore(row.node, current);
      }
      this.renderRow(row);
    }
  }

  dispose(): void { this.disposed = true; this.clear(); this.threadID = null; }

  private createRow(key: string, entry: QueueEntry): QueuedRow {
    const node = element('article', 'queued'); node.tabIndex = -1;
    const marker = icon('queue'); marker.classList.add('queued-icon');
    const body = element('div', 'queued-text');
    const content = element('div', 'queued-content');
    const previewStatus = element('p', 'queued-preview-status muted'); previewStatus.hidden = true;
    const error = element('p', 'error-text'); error.hidden = true; error.setAttribute('role', 'alert');
    const actions = element('div', 'queued-actions');
    const images = new MessageImages(() => {
      if (this.isLive(row)) this.onImageLoad();
    }, preview => {
      if (!this.isLive(row)) return;
      preview.hidden = true; row.decodeFailed = true; this.renderPreview(row);
    });
    const send = iconButton('steer', 'Steer', () => this.sendNow(row), 'queued-send');
    send.append(element('span', '', 'Steer'));
    const edit = iconButton('edit', 'Edit queued message', () => this.edit(row), 'queued-edit');
    const row: QueuedRow = { key, entry, node, body, images, previewStatus, actions, send, edit, error, ambiguous: false, ambiguousEdit: false, pendingAction: null, alreadySent: false, decodeFailed: false };
    content.append(body, images.node, previewStatus, error);
    actions.append(send, edit); node.append(marker, content, actions);
    return row;
  }

  private renderRow(row: QueuedRow): void {
    const { entry } = row;
    if (row.body.textContent !== entry.text) row.body.textContent = entry.text;
    row.body.hidden = !entry.text && entry.imageCount === 0;
    if (!entry.text && entry.imageCount > 0) row.body.textContent = entry.imageCount === 1 ? 'Image' : `${entry.imageCount} images`;
    row.body.title = entry.text;
    row.node.dataset.queueState = entry.steering ? 'steer' : 'follow-up';
    if (entry.imageRef === null) delete row.node.dataset.imageRef;
    else row.node.dataset.imageRef = entry.imageRef;
    row.node.setAttribute('aria-label', entry.steering ? 'You, sending next' : 'You, queued');
    const description = row.alreadySent ? 'Already sent.' : entry.steering ? 'Sends at the next interruption point.' : 'Queued to send after the current run.';
    row.node.setAttribute('aria-description', [description, row.ambiguous ? AMBIGUOUS_SEND : '', row.ambiguousEdit ? AMBIGUOUS_EDIT : ''].filter(Boolean).join(' '));
    const hideActions = row.alreadySent;
    if (hideActions && row.actions.contains(document.activeElement)) row.node.focus({ preventScroll: true });
    row.actions.hidden = hideActions;
    row.send.hidden = entry.steering;
    row.send.disabled = row.pendingAction !== null || row.ambiguous;
    row.send.title = row.ambiguous ? AMBIGUOUS_SEND : SEND_TITLE;
    row.edit.disabled = row.pendingAction !== null || row.ambiguousEdit;
    row.edit.title = row.ambiguousEdit ? AMBIGUOUS_EDIT : 'Withdraw this message to edit in the composer';
    row.edit.setAttribute('aria-busy', String(row.pendingAction === 'edit'));
    this.renderPreview(row);
  }

  private renderPreview(row: QueuedRow): void {
    const state = row.entry.imageRef === null ? undefined : this.resources.get(row.entry.imageRef)?.state;
    row.node.setAttribute('aria-busy', String(state?.kind === 'loading'));
    if (state?.kind === 'ready') row.images.update(state.images);
    else row.images.update([]);
    const failure = state?.kind === 'failed' ? `Image preview unavailable: ${state.error}` : row.decodeFailed ? 'Could not display a queued image.' : null;
    const text = failure ?? (state?.kind === 'loading' ? 'Loading images…' : '');
    row.previewStatus.hidden = !text;
    row.previewStatus.setAttribute('role', failure ? 'alert' : 'status');
    row.previewStatus.classList.toggle('error-text', failure !== null);
    row.previewStatus.classList.toggle('muted', failure === null);
    if (row.previewStatus.textContent !== text) row.previewStatus.textContent = text;
  }

  private async loadImages(threadID: string, imageRef: string, count: number, resource: PreviewResource): Promise<void> {
    try {
      const images = await request({ kind: 'queued-images', id: threadID, imageRef });
      if (!this.isCurrentResource(threadID, imageRef, resource)) return;
      if (!Array.isArray(images) || images.length !== count || !images.every(isImageContent)) throw new Error('Invalid queued image preview.');
      resource.state = { kind: 'ready', images };
    } catch (failure) {
      if (!this.isCurrentResource(threadID, imageRef, resource)) return;
      resource.state = { kind: 'failed', error: errorText(failure) };
    }
    for (const row of this.rows.values()) if (row.entry.imageRef === imageRef) this.renderPreview(row);
    this.onImageLoad();
  }

  private async sendNow(row: QueuedRow): Promise<void> {
    const threadID = this.threadID;
    if (!threadID || !this.isLive(row) || row.entry.steering || row.pendingAction !== null || row.ambiguous || row.alreadySent) return;
    row.pendingAction = 'steer'; row.error.hidden = true; this.renderRow(row);
    try {
      const promoted = await request({ kind: 'promote-queued', id: threadID, message: row.entry.text });
      if (this.threadID !== threadID || !this.isLive(row)) return;
      if (promoted === false) row.alreadySent = true;
    } catch (failure) {
      if (this.threadID !== threadID || !this.isLive(row)) return;
      row.error.textContent = errorText(failure); row.error.hidden = false;
    } finally {
      if (this.threadID === threadID && this.isLive(row)) { row.pendingAction = null; this.renderRow(row); }
    }
  }

  private async edit(row: QueuedRow): Promise<void> {
    const threadID = this.threadID;
    const onEdit = this.onEdit;
    if (!threadID || !onEdit || !this.isLive(row) || row.pendingAction !== null || row.ambiguousEdit || row.alreadySent) return;
    const preview = row.entry.imageRef === null ? undefined : this.resources.get(row.entry.imageRef)?.state;
    row.pendingAction = 'edit'; row.error.hidden = true; this.renderRow(row);
    try {
      // The canonical queue can remove this row before the mutation response arrives.
      // Restoration belongs to the composer, not to this row's lifetime.
      await onEdit({ threadID, queue: row.entry.steering ? 'steering' : 'followUp', entry: row.entry, images: preview?.kind === 'ready' ? preview.images : undefined });
    } catch (failure) {
      if (this.threadID === threadID && this.isLive(row)) { row.error.textContent = errorText(failure); row.error.hidden = false; }
    } finally {
      if (this.threadID === threadID && this.isLive(row)) { row.pendingAction = null; this.renderRow(row); }
    }
  }

  private isLive(row: QueuedRow): boolean { return !this.disposed && this.rows.get(row.key) === row; }
  private isCurrentResource(threadID: string, ref: string, resource: PreviewResource): boolean {
    return !this.disposed && this.threadID === threadID && this.resources.get(ref) === resource;
  }
  private release(row: QueuedRow): void { row.images.dispose(); row.node.remove(); }
  private clear(): void {
    for (const row of this.rows.values()) this.release(row);
    this.rows.clear(); this.resources.clear(); this.signature = '';
  }
}
