import { isBusy, isReady, type ImageAttachment, type RetractedMessage, type RuntimeSnapshot, type ThreadRecord } from '../shared/types';
import { button, element, errorText, request } from './dom';
import { formatContextUsage, isAttachments, isRetractedMessage } from './helpers';
import { ComposerSettings } from './composer-settings';
import { icon } from './icons';
import { ImageDrafts } from './image-drafts';
import { imageByteCount } from '../shared/validation';
import type { QueuedEditRequest } from './queued-messages';

interface WithdrawnDraft { message: RetractedMessage; images: ImageAttachment[] }

export class Composer {
  readonly node = element('section', 'composer');
  readonly editor = element('textarea', 'composer-editor');
  private readonly settings = new ComposerSettings();
  private readonly model = this.settings.model;
  private readonly thinking = this.settings.thinking;
  private readonly selectors = element('div', 'composer-selectors');
  private readonly message = element('div', 'composer-message');
  private readonly recover = button('Restore withdrawn message', () => {
    const id = this.thread?.id;
    if (id) void this.restoreWithdrawn(id).catch(error => this.onError(errorText(error)));
  }, 'composer-recover');
  private readonly contextUsage = this.settings.contextUsage;
  private readonly images = new ImageDrafts(() => this.updateControls(), text => this.onError(text));
  private readonly attach = button('', () => this.pickImages(), 'attach-images icon-button');
  private picking = false;
  private renderedContextUsage: RuntimeSnapshot['contextUsage'] = null;
  private catalogModels: RuntimeSnapshot['models'] | undefined | null = null;
  private catalogSelectedModelID = '';
  private catalogMissingModelID = '';
  private catalogThinkingLevels: RuntimeSnapshot['thinkingLevels'] | undefined | null = null;
  private readonly send = button('', () => this.send.dataset.mode === 'stop' ? this.abort() : this.submit(false), 'send-icon icon-button');
  private actionMode: 'send' | 'stop' = 'send';
  private runtime: RuntimeSnapshot | undefined;
  private thread: ThreadRecord | undefined;
  private drafts = new Map<string, string>();
  private admitting = new Set<string>();
  private readonly retracting = new Set<string>();
  private readonly withdrawn = new Map<string, WithdrawnDraft>();
  private readonly notices = new Map<string, string>();
  private draftTimers = new Map<string, number>();
  private starting = false;
  private dismissDrop: (() => void) | null = null;
  constructor(private readonly onError: (text: string) => void, private readonly startThread: () => Promise<{ thread: ThreadRecord; runtime: RuntimeSnapshot } | null>, private readonly onSubmit: (threadID: string) => void) {
    this.editor.placeholder = 'Do anything'; this.editor.setAttribute('aria-label', 'Message OMP');
    this.editor.dataset.testid = 'composer'; this.send.dataset.testid = 'send';
    this.message.setAttribute('role', 'status');
    this.send.append(icon('arrow-up'));
    this.attach.append(icon('plus')); this.attach.title = 'Attach images'; this.attach.setAttribute('aria-label', 'Attach images');
    const controls = element('div', 'composer-controls'); const actions = element('div', 'composer-actions');
    this.selectors.append(this.settings.node); actions.append(this.send); controls.append(this.attach, this.selectors, actions);
    const footer = element('div', 'composer-footer');
    this.recover.hidden = true; footer.append(this.message, this.recover);
    const box = element('div', 'composer-box');
    box.append(this.images.node, this.editor, controls, footer);
    this.node.append(box);
    this.editor.addEventListener('input', () => {
      const id = this.thread?.id; if (!id) { this.updateControls(); return; }
      this.drafts.set(id, this.editor.value); window.clearTimeout(this.draftTimers.get(id));
      this.draftTimers.set(id, window.setTimeout(() => { this.draftTimers.delete(id); void request({ kind: 'draft', id, text: this.drafts.get(id) ?? '' }).catch(error => this.onError(errorText(error))); }, 250));
      this.updateControls();
    });
    this.editor.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && (!event.shiftKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void this.submit(event.metaKey && event.shiftKey); } });
    this.editor.addEventListener('paste', event => {
      const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
      if (files.length) { event.preventDefault(); if (!this.thread || !this.retracting.has(this.thread.id)) void this.images.addFiles(files); }
    });
    this.model.node.addEventListener('change', () => {
      const id = this.thread?.id; if (!id) return;
      this.model.disabled = true;
      void request({ kind: 'model', id, modelID: this.model.value }).catch(error => this.onError(errorText(error))).finally(() => this.updateControls());
    });
    this.thinking.node.addEventListener('change', () => {
      const id = this.thread?.id; if (!id) return;
      this.thinking.disabled = true;
      void request({ kind: 'thinking', id, level: this.thinking.value }).catch(error => this.onError(errorText(error))).finally(() => this.updateControls());
    });
    window.addEventListener('beforeunload', () => { for (const [id] of this.draftTimers) void window.pi.request({ kind: 'draft', id, text: this.drafts.get(id) ?? '' }); });
  }
  update(thread: ThreadRecord | undefined, runtime: RuntimeSnapshot | undefined): void {
    if (this.thread?.id !== thread?.id) {
      this.dismissDrop?.();
      this.closeMenus();
      if (this.thread) { const id = this.thread.id; window.clearTimeout(this.draftTimers.get(id)); this.draftTimers.delete(id); void request({ kind: 'draft', id, text: this.drafts.get(id) ?? this.editor.value }).catch(error => this.onError(errorText(error))); }
      this.thread = thread;
      this.editor.value = thread ? this.drafts.get(thread.id) ?? thread.draft : '';
    } else {
      if (thread && this.thread && thread.draft !== this.thread.draft && !this.starting && !this.draftTimers.has(thread.id) && !this.admitting.has(thread.id) && !this.retracting.has(thread.id)) {
        this.drafts.set(thread.id, thread.draft); this.editor.value = thread.draft;
      }
      this.thread = thread;
    }
    this.runtime = runtime; this.node.hidden = false; this.selectors.hidden = !thread;
    this.images.select(thread?.id ?? null);
    const models = runtime?.models;
    const selectedModelID = runtime?.selectedModelID ?? '';
    if (models !== this.catalogModels || selectedModelID !== this.catalogSelectedModelID) {
      this.catalogSelectedModelID = selectedModelID;
      const missingModelID = selectedModelID && !models?.some(model => model.id === selectedModelID) ? selectedModelID : '';
      if (models !== this.catalogModels || missingModelID !== this.catalogMissingModelID) {
        this.catalogModels = models;
        this.catalogMissingModelID = missingModelID;
        const options = models?.map(model => ({ label: model.name, value: model.id, description: model.provider })) ?? [];
        if (!options.length) options.push({ label: 'No models available', value: '', description: '' });
        if (missingModelID) options.push({ label: missingModelID, value: missingModelID, description: '' });
        this.model.setOptions(options);
      }
    }
    this.model.value = selectedModelID;
    if (runtime?.thinkingLevels !== this.catalogThinkingLevels) {
      this.catalogThinkingLevels = runtime?.thinkingLevels;
      const levels = runtime?.thinkingLevels.filter(level => level !== 'inherit' && level !== 'auto') ?? [];
      this.thinking.setOptions([
        { label: 'Inherit', value: 'inherit' },
        ...levels.map(level => ({ label: level.charAt(0).toUpperCase() + level.slice(1), value: level })),
      ]);
    }
    this.thinking.value = runtime?.thinkingLevel ?? '';
    this.updateControls();
  }
  closeMenus(): void { this.settings.close(); }
  bindDropTarget(target: HTMLElement): () => void {
    const lifetime = new AbortController(), options = { signal: lifetime.signal };
    const overlay = element('div', 'composer-drop-overlay');
    overlay.hidden = true; overlay.setAttribute('role', 'status');
    overlay.append(element('strong', '', 'Drop files to add to your message'), element('span', '', 'Images attach as previews. Other files are added as local references.'));
    target.append(overlay);
    let depth = 0;
    const reset = (): void => { depth = 0; overlay.hidden = true; };
    this.dismissDrop = reset;
    const canDrop = (): boolean => !this.attach.disabled && !target.closest('[inert]') && !document.querySelector('dialog[open]');
    target.addEventListener('dragenter', event => {
      if (!event.dataTransfer?.types.includes('Files') || !canDrop()) return;
      event.preventDefault(); depth++; overlay.hidden = false;
    }, options);
    target.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      const accepted = canDrop();
      event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
      if (accepted) { depth = Math.max(1, depth); overlay.hidden = false; } else reset();
    }, options);
    target.addEventListener('dragleave', () => { if (--depth <= 0) reset(); }, options);
    target.addEventListener('drop', event => {
      reset();
      const transfer = event.dataTransfer;
      if (!transfer?.types.includes('Files')) return;
      const entries = Array.from(transfer.items);
      if (!this.thread && entries.length && entries.every(item => item.webkitGetAsEntry()?.isDirectory)) return;
      event.preventDefault(); event.stopPropagation();
      if (!canDrop()) return;
      const images: File[] = [], references: File[] = [];
      for (const file of transfer.files) {
        if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/gif' || file.type === 'image/webp') images.push(file);
        else references.push(file);
      }
      try {
        const paths = window.pi.pathsFromDrop(references);
        if (paths.length !== references.length) throw new Error('Could not access the dropped file paths. Drag local files from Finder.');
        if (paths.length) {
          this.editor.value += `${this.editor.value ? '\n\n' : ''}${paths.map(path => JSON.stringify(path)).join('\n')}`;
          this.editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (images.length) void this.images.addFiles(images);
        this.editor.focus({ preventScroll: true });
      } catch (error) { this.onError(errorText(error)); }
    }, options);
    window.addEventListener('dragend', reset, options);
    window.addEventListener('drop', reset, { ...options, capture: true });
    window.addEventListener('blur', reset, options);
    window.addEventListener('keydown', event => { if (event.key === 'Escape') reset(); }, options);
    return () => { reset(); lifetime.abort(); overlay.remove(); if (this.dismissDrop === reset) this.dismissDrop = null; };
  }
  private updateControls(): void {
    const runtime = this.runtime; const id = this.thread?.id;
    const ready = !!runtime && isReady(runtime.status); const busy = !!runtime && isBusy(runtime.status);
    const retracting = !!id && this.retracting.has(id);
    const hasImages = this.images.images.length > 0;
    const acceptsImages = !hasImages || runtime?.models.find(model => model.id === runtime.selectedModelID)?.supportsImages === true;
    const hasDraft = !!this.editor.value.trim() || hasImages;
    const stopping = runtime?.status.kind === 'ready' && runtime.status.activity === 'stopping';
    const mode = busy && !hasDraft ? 'stop' : 'send';
    const canSend = !this.starting && !this.picking && !this.images.busy && !retracting && (!id || ready && acceptsImages && !this.admitting.has(id)) && hasDraft;
    const label = mode === 'stop' ? stopping ? 'Stopping' : 'Stop' : this.starting || id && this.admitting.has(id) ? 'Sending' : busy ? 'Queue message' : 'Send message';
    this.editor.disabled = this.starting; this.send.disabled = mode === 'stop' ? stopping : !canSend;
    this.attach.disabled = this.starting || this.picking || this.images.busy || retracting || !!id && !ready;
    if (this.actionMode !== mode) { this.actionMode = mode; this.send.replaceChildren(icon(mode === 'stop' ? 'stop' : 'arrow-up')); }
    this.send.dataset.mode = mode; this.send.setAttribute('aria-label', label); this.send.title = label;
    this.send.setAttribute('aria-busy', String(this.starting || !!id && this.admitting.has(id) || stopping));
    this.attach.setAttribute('aria-busy', String(this.picking || this.images.busy));
    if (this.attach.disabled) this.dismissDrop?.();
    this.model.disabled = !ready || !runtime?.models.length; this.thinking.disabled = !ready || !runtime?.thinkingLevels.length;
    this.message.className = 'composer-message muted';
    this.message.textContent = retracting ? 'Withdrawing queued message…' : id && this.withdrawn.has(id) ? 'The withdrawn message is held here in memory. Send the current draft or remove attachments, then restore it. Keep this window open until it is restored.' : id && this.notices.get(id) || (runtime && ready && !runtime.models.length ? 'No models available. Configure OMP in Terminal, then reopen this thread.' : ready && !acceptsImages ? 'The selected model does not support images. Choose a vision model.' : '');
    this.message.hidden = !this.message.textContent;
    this.recover.hidden = !id || !this.withdrawn.has(id);
    this.recover.disabled = retracting || this.picking || this.images.busy || !!id && this.admitting.has(id);
    this.updateContextUsage();
  }
  private updateContextUsage(): void {
    const usage = this.runtime && isReady(this.runtime.status) ? this.runtime.contextUsage : null;
    if (usage?.tokens === this.renderedContextUsage?.tokens && usage?.contextWindow === this.renderedContextUsage?.contextWindow && this.contextUsage.textContent) return;
    this.renderedContextUsage = usage;
    if (!usage) { this.contextUsage.textContent = 'Unavailable'; this.contextUsage.removeAttribute('title'); this.contextUsage.removeAttribute('aria-label'); return; }
    this.contextUsage.textContent = formatContextUsage(usage);
    this.contextUsage.title = `Current context: ${usage.tokens.toLocaleString('en-US')} tokens / ${usage.contextWindow.toLocaleString('en-US')} token window. Not cumulative session usage.`;
    this.contextUsage.setAttribute('aria-label', this.contextUsage.title);
  }
  private async ensureThread(): Promise<boolean> {
    if (this.thread) return true;
    if (this.starting) return false;
    const message = this.editor.value;
    this.starting = true; this.updateControls();
    try {
      const started = await this.startThread();
      if (!started) return false;
      this.images.transfer(null, started.thread.id);
      this.update(started.thread, started.runtime);
      this.editor.value = message; this.drafts.set(started.thread.id, message);
      await request({ kind: 'draft', id: started.thread.id, text: message });
      return true;
    } catch (error) { this.editor.value = message; this.onError(errorText(error)); return false; }
    finally { this.starting = false; this.updateControls(); }
  }
  private async pickImages(): Promise<void> {
    if (this.picking || this.images.busy || this.thread && this.retracting.has(this.thread.id) || !(await this.ensureThread())) return;
    const id = this.thread?.id; if (!id) return;
    this.picking = true; this.updateControls();
    try {
      const images = await request({ kind: 'attach-images', id });
      if (!isAttachments(images)) throw new Error('Could not read the selected images.');
      this.images.add(images, id);
    } catch (error) { this.onError(errorText(error)); }
    finally { this.picking = false; this.updateControls(); }
  }
  async submit(steer: boolean): Promise<void> {
    if (this.starting || this.picking || this.images.busy || this.thread && this.retracting.has(this.thread.id)) return;
    const message = this.editor.value;
    if (!message.trim() && !this.images.images.length) return;
    const ownedFocus = document.activeElement === this.editor || document.activeElement === this.send;
    if (!this.thread && !(await this.ensureThread())) return;
    const thread = this.thread; const runtime = this.runtime;
    if (!thread || !runtime || !isReady(runtime.status) || this.admitting.has(thread.id)) return;
    const images = [...this.images.images];
    if (images.length && !runtime.models.find(model => model.id === runtime.selectedModelID)?.supportsImages) { this.onError('The selected model does not support images. Choose a vision model.'); return; }
    this.admitting.add(thread.id);
    this.onSubmit(thread.id);
    this.drafts.set(thread.id, ''); window.clearTimeout(this.draftTimers.get(thread.id)); this.draftTimers.delete(thread.id);
    this.editor.value = ''; this.updateControls();
    if (this.thread?.id === thread.id && (document.activeElement === this.editor || document.activeElement === this.send || ownedFocus && document.activeElement === document.body) && !this.editor.closest('[inert]') && this.editor.getClientRects().length) this.editor.focus({ preventScroll: true });
    let accepted = false;
    try {
      const admitted = await request({ kind: 'prompt', id: thread.id, message, steer, images: images.map(image => image.frame) });
      if (admitted !== true) throw new Error('OMP did not accept the message. Your draft was kept.');
      accepted = true;
      this.images.remove(new Set(images.map(image => image.id)), thread.id);
      await request({ kind: 'draft', id: thread.id, text: this.drafts.get(thread.id) ?? '' });
    } catch (error) {
      if (!accepted) {
        const current = this.drafts.get(thread.id) ?? '';
        const restored = message && current ? `${message}\n\n${current}` : message || current;
        this.drafts.set(thread.id, restored);
        if (this.thread?.id === thread.id) this.editor.value = restored;
        await request({ kind: 'draft', id: thread.id, text: restored }).catch(failure => this.onError(errorText(failure)));
      }
      this.onError(errorText(error));
    } finally { this.admitting.delete(thread.id); this.updateControls(); }
  }
  async retractQueued(value: QueuedEditRequest): Promise<void> {
    const id = value.threadID;
    if (this.retracting.has(id)) return;
    if (this.thread?.id !== id) return;
    if (this.starting || this.picking || this.images.busy || this.admitting.has(id)) { this.onError('Wait for the current draft operation to finish, then edit the queued message.'); return; }
    if (this.withdrawn.has(id)) { this.onError('Restore the previously withdrawn message before editing another.'); return; }
    try {
      // Check the known count even if preview loading failed. Byte capacity can
      // also be checked before removal when the local preview is available.
      if (this.images.images.length + value.entry.imageCount > 20) throw new Error('This draft and queued message would exceed 20 images. Send the draft or remove attachments before editing the queued message.');
      if (value.images) this.images.checkCapacity(value.images.map((frame, index) => ({ id: `preflight-${index}`, name: 'Queued image', frame, byteCount: imageByteCount(frame) })), id);
      this.drafts.set(id, this.editor.value);
      this.retracting.add(id); this.images.setLocked(id, true); this.notices.delete(id); this.updateControls();
      const result = await request({ kind: 'retract-queued', id, queue: value.queue, message: value.entry.text, imageRef: value.entry.imageRef });
      if (result === null) { this.notices.set(id, 'This queued message has already been sent or is no longer available. Nothing was restored.'); return; }
      if (!isRetractedMessage(result)) throw new Error('OMP returned an invalid withdrawn message.');
      // Retain the exact recovered payload before attempting a bounded merge.
      // Unknown native attachments must not disappear after destructive removal.
      this.withdrawn.set(id, { message: result, images: result.images.map((frame, index) => ({ id: crypto.randomUUID(), name: `Withdrawn image ${index + 1}`, frame, byteCount: imageByteCount(frame) })) });
      await this.restoreWithdrawn(id);
    } catch (error) {
      this.onError(errorText(error));
    } finally {
      this.retracting.delete(id); this.images.setLocked(id, false); this.updateControls();
    }
  }

  private async restoreWithdrawn(id: string): Promise<void> {
    const recovered = this.withdrawn.get(id);
    if (!recovered) return;
    this.images.checkCapacity(recovered.images, id);
    const current = this.thread?.id === id ? this.editor.value : this.drafts.get(id) ?? '';
    const text = recovered.message.text;
    const restored = text && current ? `${text}\n\n${current}` : text || current;
    this.images.add(recovered.images, id);
    this.drafts.set(id, restored); this.withdrawn.delete(id);
    window.clearTimeout(this.draftTimers.get(id)); this.draftTimers.delete(id);
    if (recovered.message.imagesDropped) this.notices.set(id, 'OMP withdrew this message but could not return all of its images. The recovered text and any available images are in the draft; missing images must be attached again.');
    else this.notices.delete(id);
    if (this.thread?.id === id) {
      this.editor.value = restored;
      if (!this.editor.closest('[inert]') && this.editor.getClientRects().length) this.editor.focus({ preventScroll: true });
    }
    this.updateControls();
    await request({ kind: 'draft', id, text: restored });
  }
  async abort(): Promise<void> {
    const id = this.thread?.id; if (!id || !this.runtime || !isBusy(this.runtime.status)) return;
    try { await request({ kind: 'abort', id }); } catch (error) { this.onError(errorText(error)); }
  }
}
