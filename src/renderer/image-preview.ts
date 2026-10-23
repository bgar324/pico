import { Modal, element, iconButton } from './dom';

/** Full-resolution preview shared by draft and transcript images. */
export function openImagePreview(source: HTMLImageElement, owner: HTMLElement, onClose: () => void): Modal {
  const modal = new Modal('Image preview', () => modal.close());
  modal.node.classList.add('image-preview');
  const heading = modal.node.querySelector('h2');
  if (heading) heading.hidden = true;
  modal.footer.remove();
  const image = element('img'); image.src = source.src; image.alt = source.alt;
  const close = iconButton('close', 'Close image preview', () => modal.close(), 'image-preview-close');
  modal.body.append(image); modal.node.append(close);
  modal.node.addEventListener('click', event => {
    if (event.target !== modal.node) return;
    const bounds = modal.node.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) modal.close();
  });
  // Cached conversations detach without disposal when another thread opens.
  const observer = new MutationObserver(() => {
    if (!owner.isConnected || owner.closest('[hidden]')) modal.close();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  modal.onClose = () => { observer.disconnect(); onClose(); };
  queueMicrotask(() => { if (modal.node.isConnected) close.focus(); });
  return modal;
}
