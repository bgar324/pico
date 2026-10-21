import { Menu, type SelectOption } from './controls';
import { button, element, iconButton, Modal } from './dom';
import { icon } from './icons';

function thinkingIcon(level: string): Parameters<typeof icon>[0] {
  switch (level) {
    case 'inherit': return 'inherit';
    case 'off': return 'off';
    case 'minimal': case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'max';
    default: return 'thinking';
  }
}

class ComposerChoice {
  readonly node: HTMLButtonElement;
  private readonly label = element('span', 'menu-label');
  private readonly menu = new Menu('thinking-menu');
  private options: readonly SelectOption[] = [];
  private selectedValue = '';
  private renderedValue: string | null = null;
  private renderedLabel: string | null = null;
  private modal: Modal | null = null;
  private renderModels: (() => void) | null = null;

  constructor(private readonly kind: 'model' | 'thinking', private readonly parent: Menu, private readonly returnFocus: () => void) {
    this.node = button('', () => this.open(), 'menu-option composer-setting-row');
    this.node.setAttribute('role', 'menuitem');
    this.node.setAttribute('aria-label', kind === 'model' ? 'Model' : 'Thinking level');
    this.node.setAttribute('aria-haspopup', kind === 'model' ? 'dialog' : 'menu');
    this.node.append(icon(kind === 'model' ? 'model' : 'thinking'), this.label, icon('chevron-right'));
    this.node.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); this.open(); }
    });
    this.menu.node.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); this.menu.close(); }
    });
  }
  get value(): string { return this.selectedValue; }
  set value(value: string) {
    if (this.selectedValue === value && this.renderedValue !== null) return;
    this.selectedValue = value;
    this.renderSelection();
  }
  get disabled(): boolean { return this.node.disabled; }
  set disabled(value: boolean) {
    if (this.node.disabled === value) return;
    this.node.disabled = value;
    if (value) this.dismiss();
  }
  setOptions(options: readonly SelectOption[]): void {
    if (this.options === options || this.options.length === options.length && this.options.every((option, index) => option.value === options[index]?.value && option.label === options[index]?.label)) return;
    this.options = options;
    this.renderSelection();
  }
  private renderSelection(): void {
    const value = this.selectedValue;
    const text = this.options.find(option => option.value === value)?.label ?? value;
    if (this.renderedLabel !== text) {
      this.label.replaceChildren(element('small', 'muted', this.kind === 'model' ? 'Model' : 'Thinking'), element('span', '', text || 'Unavailable'));
      this.node.title = text;
      this.renderedLabel = text;
    }
    if (this.renderedValue !== value) {
      if (this.kind === 'thinking') this.node.firstElementChild?.replaceWith(icon(thinkingIcon(value)));
      this.node.dataset.value = value;
      this.renderedValue = value;
    }
    this.renderModels?.();
    if (this.menu.node.matches(':popover-open')) this.renderThinking();
  }
  dismiss(): void { this.modal?.close(); this.menu.close(false); }
  private choose(value: string): void {
    this.value = value;
    this.node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  private renderThinking(): void {
    const focusedValue = this.menu.node.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.value : undefined;
    this.menu.setItems(this.options.map(option => ({ label: option.label, selected: option.value === this.value, action: () => this.choose(option.value) })));
    for (const [index, row] of Array.from(this.menu.node.children).entries()) {
      const option = this.options[index];
      if (option) { row.prepend(icon(thinkingIcon(option.value))); if (row instanceof HTMLElement) row.dataset.value = option.value; }
    }
    if (focusedValue) (Array.from(this.menu.node.querySelectorAll<HTMLButtonElement>('button')).find(row => row.dataset.value === focusedValue) ?? this.menu.node.querySelector('button'))?.focus({ preventScroll: true });
  }
  private open(): void {
    if (this.disabled) return;
    if (this.kind === 'thinking') {
      this.renderThinking(); this.menu.open(this.node, 'submenu');
      return;
    }
    this.parent.close();
    const modal = new Modal('Select model', () => modal.close());
    this.modal = modal; modal.node.classList.add('model-picker');
    const search = element('input'); search.type = 'search'; search.placeholder = 'Search models or providers'; search.setAttribute('aria-label', 'Search models');
    const results = element('div', 'switcher-results');
    const render = () => {
      const focusedValue = results.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.value : undefined;
      const query = search.value.trim().toLocaleLowerCase(); results.replaceChildren();
      for (const option of this.options) {
        if (!option.value || !`${option.label} ${option.value}`.toLocaleLowerCase().includes(query)) continue;
        const row = button('', () => { modal.close(); this.choose(option.value); }, 'model-picker-row');
        row.dataset.value = option.value;
        row.setAttribute('aria-pressed', String(option.value === this.value));
        row.append(icon('model'), element('span', 'menu-label', option.label));
        if (option.value === this.value) row.append(icon('check'));
        results.append(row);
      }
      if (!results.childElementCount) results.append(element('p', 'muted', 'No matching models'));
      if (focusedValue) (Array.from(results.querySelectorAll<HTMLButtonElement>('button')).find(row => row.dataset.value === focusedValue) ?? search).focus({ preventScroll: true });
    };
    this.renderModels = render;
    modal.onClose = () => {
      this.modal = null; this.renderModels = null;
      if (!document.querySelector('dialog[open]')) this.returnFocus();
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); } else if (event.key === 'Enter') { event.preventDefault(); results.querySelector('button')?.click(); } });
    results.addEventListener('keydown', event => {
      const rows = Array.from(results.querySelectorAll<HTMLButtonElement>('button'));
      const index = rows.findIndex(row => row === document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus(); }
    });
    modal.body.append(search, results); modal.footer.append(iconButton('close', 'Cancel', () => modal.close())); render();
  }
}

export class ComposerSettings {
  private readonly menu = new Menu('composer-settings-menu');
  readonly model = new ComposerChoice('model', this.menu, () => this.focus());
  readonly thinking = new ComposerChoice('thinking', this.menu, () => this.focus());
  readonly contextUsage = element('span', 'context-usage muted', 'Unavailable');
  readonly node = button('', () => this.menu.open(this.node), 'composer-settings-trigger icon-button');
  constructor() {
    this.node.append(icon('sliders')); this.node.title = 'Model, thinking, and context';
    this.node.setAttribute('aria-label', 'Model, thinking, and context'); this.node.setAttribute('aria-haspopup', 'menu'); this.node.setAttribute('aria-expanded', 'false');
    const context = element('div', 'composer-context-row');
    const text = element('span', 'menu-label'); text.append(element('small', 'muted', 'Context'), this.contextUsage);
    context.append(icon('context'), text); this.menu.node.append(this.model.node, this.thinking.node, context);
    this.menu.node.addEventListener('beforetoggle', event => { if (event instanceof ToggleEvent && event.newState === 'closed') this.thinking.dismiss(); });
  }
  private focus(): void { if (this.node.isConnected && !this.node.closest('[inert]') && this.node.getClientRects().length) this.node.focus({ preventScroll: true }); }
  close(): void { this.model.dismiss(); this.thinking.dismiss(); this.menu.close(false); }
}
