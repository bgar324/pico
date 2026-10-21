import { isBusy, isReady, type RuntimeSnapshot, type ThreadRecord } from '../shared/types';
import { button, element, errorText, request } from './dom';
import { formatContextUsage, isAttachments } from './helpers';
import { ComposerSettings } from './composer-settings';
import { icon } from './icons';
import { ImageDrafts } from './image-drafts';

export class Composer {
  readonly node = element('section', 'composer');
  readonly editor = element('textarea', 'composer-editor');
  private readonly settings = new ComposerSettings();
  private readonly model = this.settings.model;
  private readonly thinking = this.settings.thinking;
  private readonly selectors = element('div', 'composer-selectors');
  private readonly message = element('div', 'composer-message');
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
  private draftTimers = new Map<string, number>();
  private starting = false;
  constructor(private readonly onError: (text: string) => void, private readonly startThread: () => Promise<{ thread: ThreadRecord; runtime: RuntimeSnapshot } | null>, private readonly onSubmit: (threadID: string) => void) {
    this.editor.placeholder = 'Do anything'; this.editor.setAttribute('aria-label', 'Message OMP');
    this.editor.dataset.testid = 'composer'; this.send.dataset.testid = 'send';
    this.message.setAttribute('role', 'status');
    this.send.append(icon('arrow-up'));
    this.attach.append(icon('image')); this.attach.title = 'Attach images'; this.attach.setAttribute('aria-label', 'Attach images');
    const controls = element('div', 'composer-controls'); const actions = element('div', 'composer-actions');
    this.selectors.append(this.settings.node); actions.append(this.send); controls.append(this.attach, this.selectors, actions);
    const footer = element('div', 'composer-footer');
    footer.append(this.message);
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
      if (files.length) { event.preventDefault(); void this.images.addFiles(files); }
    });
    this.node.addEventListener('dragover', event => {
      if (Array.from(event.dataTransfer?.items ?? []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }
    });
    this.node.addEventListener('drop', event => {
      const files = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); event.stopPropagation(); void this.images.addFiles(files); }
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
      this.closeMenus();
      if (this.thread) { const id = this.thread.id; window.clearTimeout(this.draftTimers.get(id)); this.draftTimers.delete(id); void request({ kind: 'draft', id, text: this.drafts.get(id) ?? this.editor.value }).catch(error => this.onError(errorText(error))); }
      this.thread = thread;
      this.editor.value = thread ? this.drafts.get(thread.id) ?? thread.draft : '';
    } else {
      if (thread && this.thread && thread.draft !== this.thread.draft && !this.starting && !this.draftTimers.has(thread.id) && !this.admitting.has(thread.id)) {
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
        const options = models?.map(model => ({ label: `${model.name} · ${model.provider}`, value: model.id })) ?? [];
        if (!options.length) options.push({ label: 'No models available', value: '' });
        if (missingModelID) options.push({ label: missingModelID, value: missingModelID });
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
  private updateControls(): void {
    const runtime = this.runtime; const id = this.thread?.id;
    const ready = !!runtime && isReady(runtime.status); const busy = !!runtime && isBusy(runtime.status);
    const hasImages = this.images.images.length > 0;
    const acceptsImages = !hasImages || runtime?.models.find(model => model.id === runtime.selectedModelID)?.supportsImages === true;
    const hasDraft = !!this.editor.value.trim() || hasImages;
    const stopping = runtime?.status.kind === 'ready' && runtime.status.activity === 'stopping';
    const mode = busy && !hasDraft ? 'stop' : 'send';
    const canSend = !this.starting && !this.picking && !this.images.busy && (!id || ready && acceptsImages && !this.admitting.has(id)) && hasDraft;
    const label = mode === 'stop' ? stopping ? 'Stopping' : 'Stop' : this.starting || id && this.admitting.has(id) ? 'Sending' : busy ? 'Queue message' : 'Send message';
    this.editor.disabled = this.starting; this.send.disabled = mode === 'stop' ? stopping : !canSend;
    this.attach.disabled = this.starting || this.picking || this.images.busy || !!id && !ready;
    if (this.actionMode !== mode) { this.actionMode = mode; this.send.replaceChildren(icon(mode === 'stop' ? 'stop' : 'arrow-up')); }
    this.send.dataset.mode = mode; this.send.setAttribute('aria-label', label); this.send.title = label;
    this.send.setAttribute('aria-busy', String(this.starting || !!id && this.admitting.has(id) || stopping));
    this.attach.setAttribute('aria-busy', String(this.picking || this.images.busy));
    this.model.disabled = !ready || !runtime?.models.length; this.thinking.disabled = !ready || !runtime?.thinkingLevels.length;
    this.message.className = 'composer-message muted';
    this.message.textContent = runtime && ready && !runtime.models.length ? 'No models available. Configure OMP in Terminal, then reopen this thread.' : ready && !acceptsImages ? 'The selected model does not support images. Choose a vision model.' : '';
    this.message.hidden = !this.message.textContent;
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
    if (this.picking || this.images.busy || !(await this.ensureThread())) return;
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
    if (this.starting || this.picking || this.images.busy) return;
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
  async abort(): Promise<void> {
    const id = this.thread?.id; if (!id || !this.runtime || !isBusy(this.runtime.status)) return;
    try { await request({ kind: 'abort', id }); } catch (error) { this.onError(errorText(error)); }
  }
}
