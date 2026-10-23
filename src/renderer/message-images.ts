import type { ImageContent } from '../shared/types';
import { Modal, button, element } from './dom';
import { openImagePreview } from './image-preview';

interface Preview {
  node: HTMLImageElement;
  trigger: HTMLButtonElement;
  load: () => void;
  error: (() => void) | undefined;
}

export class MessageImages {
  readonly node = element('div', 'message-images');
  private values: readonly ImageContent[] = [];
  private previews: Preview[] = [];
  private modal: Modal | null = null;

  constructor(private readonly onLoad: () => void, private readonly onError?: (preview: HTMLImageElement) => void) {
    this.node.hidden = true;
  }

  update(images: readonly ImageContent[]): void {
    if (this.values.length === images.length && images.every((image, index) => this.values[index]?.data === image.data && this.values[index]?.mimeType === image.mimeType)) return;
    this.clear();
    this.values = images;
    for (const [index, image] of images.entries()) {
      const node = element('img');
      node.alt = `Attached image ${index + 1}`; node.loading = 'lazy'; node.decoding = 'async';
      const trigger = button('', () => {
        this.modal?.close();
        this.modal = openImagePreview(node, this.node, () => { this.modal = null; });
      }, 'message-image-open');
      trigger.setAttribute('aria-label', `Preview attached image ${index + 1}`);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.append(node);
      const load = (): void => { if (node.isConnected) this.onLoad(); };
      const error = this.onError ? (): void => { if (node.isConnected) { this.onError?.(node); trigger.hidden = node.hidden; } } : undefined;
      node.addEventListener('load', load);
      if (error) node.addEventListener('error', error);
      node.src = `data:${image.mimeType};base64,${image.data}`;
      this.previews.push({ node, trigger, load, error }); this.node.append(trigger);
    }
    this.node.hidden = images.length === 0;
  }

  dispose(): void { this.clear(); }

  private clear(): void {
    this.modal?.close();
    for (const preview of this.previews) {
      preview.node.removeEventListener('load', preview.load);
      if (preview.error) preview.node.removeEventListener('error', preview.error);
      preview.node.removeAttribute('src'); preview.trigger.remove();
    }
    this.previews = []; this.values = []; this.node.hidden = true;
  }
}
