import type { AppRequest, AppResult, PiBridge } from '../shared/types';
import { icon } from './icons';

declare global { interface Window { pi: PiBridge } }

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
export function button(text: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', event => {
    void action();
    if (node.popoverTargetElement) event.preventDefault();
  });
  return node;
}
export function iconButton(name: Parameters<typeof icon>[0], label: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
  const node = button('', action, `icon-button ${className}`);
  node.append(icon(name)); node.title = label; node.setAttribute('aria-label', label);
  return node;
}
export async function request(value: AppRequest): Promise<AppResult> {
  const result = await window.pi.request(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function labeled(label: string, control: HTMLElement): HTMLLabelElement {
  const node = element('label', 'field');
  node.append(element('span', '', label), control);
  return node;
}
const copyTimers = new WeakMap<HTMLButtonElement, number>();
export async function copy(content: string | (() => Promise<unknown>), control: HTMLButtonElement): Promise<void> {
  if (control.disabled) return;
  window.clearTimeout(copyTimers.get(control));
  const label = control.dataset.copyLabel ?? control.getAttribute('aria-label') ?? 'Copy';
  control.dataset.copyLabel = label; control.disabled = true;
  control.querySelector('svg')?.replaceWith(icon('copy'));
  try {
    if (typeof content === 'string') await navigator.clipboard.writeText(content);
    else await content();
    control.querySelector('svg')?.replaceWith(icon('check'));
    control.setAttribute('aria-label', 'Copied'); control.title = 'Copied';
  } catch (error) {
    control.setAttribute('aria-label', 'Copy failed'); control.title = `Copy failed: ${errorText(error)}`;
  } finally {
    control.disabled = false;
    copyTimers.set(control, window.setTimeout(() => {
      copyTimers.delete(control);
      control.querySelector('svg')?.replaceWith(icon('copy'));
      control.setAttribute('aria-label', label); control.title = label;
    }, 1400));
  }
}

export class Modal {
  readonly node = element('dialog', 'modal');
  readonly body = element('div', 'modal-body');
  readonly footer = element('div', 'modal-footer');
  private readonly previous = document.activeElement;
  onClose: (() => void) | null = null;
  constructor(title: string, cancel: () => void) {
    const heading = element('h2', '', title);
    heading.id = `modal-${crypto.randomUUID()}`;
    this.node.setAttribute('aria-labelledby', heading.id);
    this.node.append(heading, this.body, this.footer);
    this.node.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    this.node.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(this.node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(node => node.getClientRects().length > 0 && (!node.closest('[popover]') || node.closest('[popover]')?.matches(':popover-open')));
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    });
    document.body.append(this.node);
    this.node.showModal();
    queueMicrotask(() => { this.body.querySelector<HTMLElement>('input,textarea,button')?.focus(); });
  }
  close(): void {
    for (const menu of this.node.querySelectorAll<HTMLElement>('[popover]:popover-open')) menu.hidePopover();
    this.node.close(); this.node.remove();
    if (this.previous instanceof HTMLElement && this.previous.isConnected) this.previous.focus();
    this.onClose?.();
  }
}
