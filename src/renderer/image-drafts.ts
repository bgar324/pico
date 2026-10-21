import type { ImageAttachment } from '../shared/types';
import { IMAGE_BYTE_LIMIT, IMAGE_TOTAL_BYTE_LIMIT, imageByteCount, isImageContent } from '../shared/validation';
import { Modal, button, element, errorText } from './dom';
import { icon } from './icons';

const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class ImageDrafts {
  readonly node = element('div', 'composer-images');
  private readonly drafts = new Map<string | null, ImageAttachment[]>();
  private readonly loading = new Map<string | null, number>();
  private key: string | null = null;
  private preview: { id: string; modal: Modal } | null = null;
  constructor(private readonly changed: () => void, private readonly onError: (text: string) => void) { this.node.hidden = true; }
  get images(): readonly ImageAttachment[] { return this.drafts.get(this.key) ?? []; }
  get busy(): boolean { return (this.loading.get(this.key) ?? 0) > 0; }
  select(key: string | null): void { if (key !== this.key) { this.preview?.modal.close(); this.key = key; this.render(); } }
  transfer(from: string | null, to: string): void {
    const images = this.drafts.get(from);
    if (!images?.length) return;
    this.drafts.set(to, [...this.drafts.get(to) ?? [], ...images]); this.drafts.delete(from);
    if (this.key === to || this.key === from) this.render();
  }
  add(images: readonly ImageAttachment[], key = this.key): void {
    const current = this.drafts.get(key) ?? [];
    if (current.length + images.length > 20) throw new Error(`This draft already has ${current.length} images. Attach at most 20 per message.`);
    for (const image of images) if (!isImageContent(image.frame) || image.byteCount !== imageByteCount(image.frame)) throw new Error('Choose PNG, JPEG, GIF, or WebP images up to 32 MiB each.');
    const bytes = current.reduce((sum, image) => sum + image.byteCount, 0) + images.reduce((sum, image) => sum + image.byteCount, 0);
    if (bytes > IMAGE_TOTAL_BYTE_LIMIT) throw new Error(`This draft would contain ${(bytes / 1048576).toFixed(1)} MiB of images. Attach at most 64 MiB per message.`);
    this.drafts.set(key, [...current, ...images]);
    if (key === this.key) this.render();
    this.changed();
  }
  async addFiles(files: readonly File[]): Promise<void> {
    if (!files.length) return;
    const key = this.key;
    this.loading.set(key, (this.loading.get(key) ?? 0) + 1); this.changed();
    try {
      const current = this.drafts.get(key) ?? [];
      if (current.length + files.length > 20) throw new Error(`This draft already has ${current.length} images. Attach at most 20 per message.`);
      if (files.some(file => file.size > IMAGE_BYTE_LIMIT)) throw new Error('Choose images up to 32 MiB each.');
      const bytes = current.reduce((sum, image) => sum + image.byteCount, 0) + files.reduce((sum, file) => sum + file.size, 0);
      if (bytes > IMAGE_TOTAL_BYTE_LIMIT) throw new Error(`This draft would contain ${(bytes / 1048576).toFixed(1)} MiB of images. Attach at most 64 MiB per message.`);
      const images = await Promise.all(files.map(async file => {
        if (!mimeTypes.has(file.type)) throw new Error('Choose PNG, JPEG, GIF, or WebP images.');
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.slice(reader.result.indexOf(',') + 1)) : reject(new Error('Could not read the image.'));
        reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the pasted image'}.`));
        reader.onabort = () => reject(new Error(`Reading ${file.name || 'the pasted image'} was cancelled.`));
        reader.readAsDataURL(file);
        const data = await promise;
        const frame = { type: 'image', mimeType: file.type, data };
        if (!isImageContent(frame)) throw new Error(`Could not read ${file.name || 'the pasted image'}.`);
        return { id: crypto.randomUUID(), name: file.name || 'Pasted image', byteCount: file.size, frame } satisfies ImageAttachment;
      }));
      this.add(images, key);
    } catch (error) { this.onError(errorText(error)); }
    finally { const count = (this.loading.get(key) ?? 1) - 1; if (count) this.loading.set(key, count); else this.loading.delete(key); this.changed(); }
  }
  remove(ids: ReadonlySet<string>, key = this.key): void {
    const images = (this.drafts.get(key) ?? []).filter(image => !ids.has(image.id));
    if (images.length) this.drafts.set(key, images); else this.drafts.delete(key);
    if (key === this.key) this.render();
    this.changed();
  }
  private openPreview(image: ImageAttachment, source: HTMLImageElement, trigger: HTMLButtonElement): void {
    this.preview?.modal.close();
    const modal = new Modal(image.name, () => modal.close());
    modal.node.classList.add('composer-image-preview');
    const fullImage = element('img'); fullImage.src = source.src; fullImage.alt = image.name;
    const close = button('Close', () => modal.close());
    modal.body.append(fullImage); modal.footer.append(close);
    this.preview = { id: image.id, modal };
    modal.onClose = () => {
      this.preview = null;
      if (!trigger.isConnected) Array.from(this.node.querySelectorAll<HTMLButtonElement>('.composer-image-open')).find(button => button.dataset.imageId === image.id)?.focus();
    };
    modal.node.addEventListener('click', event => {
      if (event.target !== modal.node) return;
      const bounds = modal.node.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) modal.close();
    });
    queueMicrotask(() => { if (modal.node.isConnected) close.focus(); });
  }
  private render(): void {
    if (this.preview && !this.images.some(image => image.id === this.preview?.id)) this.preview.modal.close();
    this.node.replaceChildren(); this.node.hidden = !this.images.length;
    for (const image of this.images) {
      const key = this.key;
      const item = element('div', 'composer-image'); const preview = element('img'); preview.alt = image.name;
      if (typeof image.frame.data === 'string' && typeof image.frame.mimeType === 'string') preview.src = `data:${image.frame.mimeType};base64,${image.frame.data}`;
      const open = button('', () => this.openPreview(image, preview, open), 'composer-image-open');
      open.title = `Preview ${image.name}`; open.setAttribute('aria-label', open.title); open.setAttribute('aria-haspopup', 'dialog'); open.dataset.imageId = image.id;
      open.append(preview);
      const remove = button('', () => {
        const index = this.images.findIndex(candidate => candidate.id === image.id);
        this.remove(new Set([image.id]), key);
        if (this.key !== key) return;
        const previews = this.node.querySelectorAll<HTMLButtonElement>('.composer-image-open');
        const next = previews[Math.min(index, previews.length - 1)] ?? this.node.closest('.composer')?.querySelector<HTMLTextAreaElement>('.composer-editor');
        next?.focus({ preventScroll: true });
      }, 'image-remove icon-button');
      remove.append(icon('close')); remove.title = `Remove ${image.name}`; remove.setAttribute('aria-label', remove.title);
      item.append(open, remove, element('span', 'composer-image-name', image.name)); this.node.append(item);
    }
  }
}
