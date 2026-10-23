import type { ImageAttachment } from '../shared/types';
import { IMAGE_BYTE_LIMIT, IMAGE_TOTAL_BYTE_LIMIT, imageByteCount, isImageContent } from '../shared/validation';
import { Modal, button, element, errorText } from './dom';
import { icon } from './icons';
import { openImagePreview } from './image-preview';

const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class ImageDrafts {
  readonly node = element('div', 'composer-images');
  private readonly drafts = new Map<string | null, ImageAttachment[]>();
  private readonly loading = new Map<string | null, number>();
  private readonly locked = new Set<string | null>();
  private key: string | null = null;
  private preview: { id: string; modal: Modal } | null = null;
  constructor(private readonly changed: () => void, private readonly onError: (text: string) => void) { this.node.hidden = true; }
  get images(): readonly ImageAttachment[] { return this.drafts.get(this.key) ?? []; }
  get busy(): boolean { return (this.loading.get(this.key) ?? 0) > 0; }
  setLocked(key: string, locked: boolean): void {
    if (locked) this.locked.add(key); else this.locked.delete(key);
    if (key === this.key) for (const remove of this.node.querySelectorAll<HTMLButtonElement>('.image-remove')) remove.disabled = locked;
  }
  checkCapacity(images: readonly ImageAttachment[], key = this.key): void {
    const current = this.drafts.get(key) ?? [];
    if (current.length + images.length > 20) throw new Error(`This draft already has ${current.length} images. Attach at most 20 per message.`);
    for (const image of images) if (!isImageContent(image.frame) || image.byteCount !== imageByteCount(image.frame)) throw new Error('Choose PNG, JPEG, GIF, or WebP images up to 32 MiB each.');
    const bytes = current.reduce((sum, image) => sum + image.byteCount, 0) + images.reduce((sum, image) => sum + image.byteCount, 0);
    if (bytes > IMAGE_TOTAL_BYTE_LIMIT) throw new Error(`This draft would contain ${(bytes / 1048576).toFixed(1)} MiB of images. Attach at most 64 MiB per message.`);
  }
  select(key: string | null): void { if (key !== this.key) { this.preview?.modal.close(); this.key = key; this.render(); } }
  transfer(from: string | null, to: string): void {
    const images = this.drafts.get(from);
    if (!images?.length) return;
    this.drafts.set(to, [...this.drafts.get(to) ?? [], ...images]); this.drafts.delete(from);
    if (this.key === to || this.key === from) this.render();
  }
  add(images: readonly ImageAttachment[], key = this.key): void {
    this.checkCapacity(images, key);
    const current = this.drafts.get(key) ?? [];
    this.drafts.set(key, [...current, ...images]);
    if (key === this.key) this.render();
    this.changed();
  }
  async addFiles(files: readonly File[]): Promise<void> {
    if (!files.length || this.locked.has(this.key)) return;
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
    if (this.locked.has(key)) return;
    const images = (this.drafts.get(key) ?? []).filter(image => !ids.has(image.id));
    if (images.length) this.drafts.set(key, images); else this.drafts.delete(key);
    if (key === this.key) this.render();
    this.changed();
  }
  private openPreview(image: ImageAttachment, source: HTMLImageElement, trigger: HTMLButtonElement): void {
    this.preview?.modal.close();
    const modal = openImagePreview(source, this.node, () => {
      this.preview = null;
      if (!trigger.isConnected) Array.from(this.node.querySelectorAll<HTMLButtonElement>('.composer-image-open')).find(button => button.dataset.imageId === image.id)?.focus();
    });
    this.preview = { id: image.id, modal };
  }
  private render(): void {
    if (this.preview && !this.images.some(image => image.id === this.preview?.id)) this.preview.modal.close();
    this.node.replaceChildren(); this.node.hidden = !this.images.length;
    for (const [index, image] of this.images.entries()) {
      const key = this.key;
      const item = element('div', 'composer-image'); const preview = element('img'); preview.alt = `Attached image ${index + 1}`;
      if (typeof image.frame.data === 'string' && typeof image.frame.mimeType === 'string') preview.src = `data:${image.frame.mimeType};base64,${image.frame.data}`;
      const open = button('', () => this.openPreview(image, preview, open), 'composer-image-open');
      open.title = `Preview image ${index + 1}`; open.setAttribute('aria-label', open.title); open.setAttribute('aria-haspopup', 'dialog'); open.dataset.imageId = image.id;
      open.append(preview);
      const remove = button('', () => {
        const index = this.images.findIndex(candidate => candidate.id === image.id);
        this.remove(new Set([image.id]), key);
        if (this.key !== key) return;
        const previews = this.node.querySelectorAll<HTMLButtonElement>('.composer-image-open');
        const next = previews[Math.min(index, previews.length - 1)] ?? this.node.closest('.composer')?.querySelector<HTMLTextAreaElement>('.composer-editor');
        next?.focus({ preventScroll: true });
      }, 'image-remove icon-button');
      remove.append(icon('close')); remove.title = `Remove image ${index + 1}`; remove.setAttribute('aria-label', remove.title);
      remove.disabled = this.locked.has(key);
      item.append(open, remove); this.node.append(item);
    }
  }
}
