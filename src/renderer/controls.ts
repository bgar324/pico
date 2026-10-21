import { button, element } from './dom';
import { icon } from './icons';

// Bundled Chromium supports explicit invokers; TypeScript 5.9 predates this DOM overload.
declare global {
  interface HTMLElement { showPopover(options: { source: HTMLElement }): void }
}

export interface MenuItem {
  label: string;
  action: () => void | Promise<void>;
  selected?: boolean;
  description?: string;
}

export class Menu {
  readonly node = element('div', 'menu-surface');
  private anchor: HTMLElement | null = null;
  private lifetime: AbortController | null = null;
  private layoutObserver: ResizeObserver | null = null;
  private removalObserver: MutationObserver | null = null;
  private layoutFrame = 0;
  private search = '';
  private searchTime = 0;

  constructor(className = '') {
    if (className) this.node.classList.add(className);
    this.node.popover = 'auto';
    this.node.setAttribute('role', 'menu');
    this.node.addEventListener('beforetoggle', event => {
      if (event instanceof ToggleEvent && event.newState === 'closed') {
        this.anchor?.setAttribute('aria-expanded', 'false');
        this.stopObservingLayout();
      }
    });
    this.node.addEventListener('keydown', event => {
      const controls = Array.from(this.node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const current = controls.findIndex(control => control === document.activeElement);
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = (current + 1) % controls.length;
      else if (event.key === 'ArrowUp') next = (current - 1 + controls.length) % controls.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = controls.length - 1;
      else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
        this.close(); return;
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== ' ') {
        this.search = event.timeStamp - this.searchTime < 600 ? this.search + event.key : event.key;
        this.searchTime = event.timeStamp;
        next = controls.findIndex(control => (control.dataset.label ?? '').toLocaleLowerCase().startsWith(this.search.toLocaleLowerCase()));
      }
      if (next !== null && next >= 0) { event.preventDefault(); controls[next]?.focus(); }
    });
  }

  setItems(items: readonly MenuItem[], role: 'menuitem' | 'option' = 'menuitem'): void {
    this.node.replaceChildren();
    for (const item of items) {
      const row = button('', () => { this.close(); void item.action(); }, 'menu-option');
      row.dataset.label = item.label;
      row.setAttribute('role', role === 'option' ? 'option' : item.selected === undefined ? 'menuitem' : 'menuitemradio');
      if (item.selected !== undefined) row.setAttribute(role === 'option' ? 'aria-selected' : 'aria-checked', String(item.selected));
      const check = element('span', 'menu-check'); check.setAttribute('aria-hidden', 'true');
      if (item.selected) check.append(icon('check'));
      const label = element('span', 'menu-label', item.label);
      if (item.description) label.append(element('small', 'muted', item.description));
      row.append(label, check); this.node.append(row);
    }
  }

  open(anchor: HTMLElement, placement: 'vertical' | 'submenu' = 'vertical'): void {
    if (this.node.matches(':popover-open')) {
      const sameAnchor = this.anchor === anchor;
      this.close(sameAnchor);
      if (sameAnchor) return;
    }
    this.anchor = anchor; this.search = '';
    (anchor.closest('dialog') ?? document.body).append(this.node);
    if (anchor instanceof HTMLButtonElement) anchor.popoverTargetElement = this.node;
    this.node.showPopover({ source: anchor }); anchor.setAttribute('aria-expanded', 'true');
    const bounds = anchor.getBoundingClientRect();
    this.node.style.minWidth = `${Math.max(180, Math.min(bounds.width, window.innerWidth - 24))}px`;
    const width = this.node.offsetWidth, height = this.node.offsetHeight;
    if (placement === 'submenu') {
      const right = bounds.right + 6;
      this.node.style.left = `${Math.max(12, right + width <= window.innerWidth - 12 ? right : bounds.left - width - 6)}px`;
      this.node.style.top = `${Math.max(12, Math.min(bounds.top, window.innerHeight - height - 12))}px`;
      this.node.dataset.origin = 'top';
    } else {
      this.node.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
      const below = bounds.bottom + 6;
      const opensBelow = below + height <= window.innerHeight - 12;
      this.node.dataset.origin = opensBelow ? 'top' : 'bottom';
      this.node.style.top = `${Math.max(12, opensBelow ? below : bounds.top - height - 6)}px`;
    }
    this.observeLayout(anchor, bounds);
    this.node.querySelector<HTMLButtonElement>('[aria-selected="true"], [aria-checked="true"]')?.focus();
    if (!this.node.contains(document.activeElement)) this.node.querySelector('button')?.focus();
  }

  private observeLayout(anchor: HTMLElement, bounds: DOMRectReadOnly): void {
    this.stopObservingLayout();
    this.lifetime = new AbortController();
    const checkBounds = () => {
      this.layoutFrame = 0;
      const current = anchor.getBoundingClientRect();
      if (!this.node.isConnected || !this.node.matches(':popover-open') || !anchor.isConnected || anchor.closest('[inert]') || !anchor.getClientRects().length || Math.abs(current.left - bounds.left) > .5 || Math.abs(current.top - bounds.top) > .5 || Math.abs(current.width - bounds.width) > .5 || Math.abs(current.height - bounds.height) > .5) {
        this.close(this.node.contains(document.activeElement));
      }
    };
    const scheduleCheck = () => { if (!this.layoutFrame) this.layoutFrame = requestAnimationFrame(checkBounds); };
    this.layoutObserver = new ResizeObserver(scheduleCheck);
    this.removalObserver = new MutationObserver(scheduleCheck);
    for (let owner: HTMLElement | null = anchor; owner; owner = owner.parentElement) {
      this.layoutObserver.observe(owner);
      this.removalObserver.observe(owner, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'], childList: true });
    }
    window.addEventListener('resize', scheduleCheck, { signal: this.lifetime.signal });
    window.addEventListener('scroll', scheduleCheck, { capture: true, signal: this.lifetime.signal });
  }

  private stopObservingLayout(): void {
    this.lifetime?.abort(); this.lifetime = null;
    this.layoutObserver?.disconnect(); this.layoutObserver = null;
    this.removalObserver?.disconnect(); this.removalObserver = null;
    cancelAnimationFrame(this.layoutFrame); this.layoutFrame = 0;
  }

  close(returnFocus = true): void {
    if (this.node.matches(':popover-open')) this.node.hidePopover();
    this.stopObservingLayout();
    this.anchor?.setAttribute('aria-expanded', 'false');
    const parentMenu = this.anchor?.closest('[popover]');
    if (returnFocus && this.anchor?.isConnected && !this.anchor.closest('[inert]') && this.anchor.getClientRects().length && (!parentMenu || parentMenu.matches(':popover-open'))) this.anchor.focus({ preventScroll: true });
  }
}

export interface SelectOption { value: string; label: string; description?: string }

export class SelectControl {
  readonly node: HTMLButtonElement;
  private readonly label = element('span', 'select-label');
  private readonly menu = new Menu('select-menu');
  private options: readonly SelectOption[] = [];
  private selectedValue = '';

  constructor(label: string, className = '') {
    this.node = button('', () => this.open(), `select-control ${className}`);
    this.node.append(this.label);
    this.node.setAttribute('aria-label', label);
    this.node.setAttribute('aria-haspopup', 'listbox');
    this.node.setAttribute('aria-expanded', 'false');
    this.menu.node.setAttribute('role', 'listbox');
    this.menu.node.setAttribute('aria-label', label);
    this.node.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.open(); }
    });
  }

  get value(): string { return this.selectedValue; }
  set value(value: string) {
    this.selectedValue = value;
    const option = this.options.find(option => option.value === value);
    const text = option?.label ?? value;
    if (this.label.textContent !== text) this.label.textContent = text;
    this.node.dataset.value = value; this.node.title = text;
  }
  get disabled(): boolean { return this.node.disabled; }
  set disabled(value: boolean) { this.node.disabled = value; if (value) this.menu.close(false); }

  setOptions(options: readonly SelectOption[]): void { this.options = options; this.value = this.selectedValue; }

  private open(): void {
    if (this.disabled || !this.options.length) return;
    this.menu.setItems(this.options.map(option => ({
      label: option.label, selected: option.value === this.value,
      ...(option.description ? { description: option.description } : {}),
      action: () => { this.value = option.value; this.node.dispatchEvent(new Event('change', { bubbles: true })); },
    })), 'option');
    this.menu.open(this.node);
  }
}
