import type { DialogRequest, JsonRecord, RuntimeSnapshot } from '../shared/types';
import { button, element, errorText, Modal, request } from './dom';
import { jsonRecord } from './helpers';
import { renderMarkdown } from './markdown';
import { icon } from './icons';

interface Answer { id: string; multi: boolean; selected: Set<string>; input: HTMLInputElement; options: HTMLInputElement[] }
export class AgentDialogs {
  private modal: Modal | null = null;
  private current: DialogRequest | null = null;
  private threadID = '';
  private error = element('p', 'error-text');
  private deadline = element('p', 'muted');
  private timer: number | undefined;
  private submitting = false;
  private submitButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private value: HTMLInputElement | HTMLTextAreaElement | null = null;
  private choices: HTMLInputElement[] = [];
  private answers: Answer[] = [];
  get active(): boolean { return this.modal !== null; }
  update(runtime: RuntimeSnapshot | undefined): void {
    const dialog = runtime?.dialogs[0];
    if (!dialog) { this.dismiss(); return; }
    if (this.current?.id === dialog.id && this.threadID === runtime?.id) {
      this.current = dialog;
      if (dialog.error) this.error.textContent = dialog.error;
      this.refreshDeadline(); return;
    }
    this.dismiss(); this.current = dialog; this.threadID = runtime?.id ?? ''; this.submitting = false;
    this.modal = new Modal(dialog.title || 'Agent request', () => { void this.respond(dialog.method === 'confirm' ? { confirmed: false } : { cancelled: true }); });
    this.modal.node.classList.add('agent-dialog');
    this.deadline = element('p', 'muted'); this.error = element('p', 'error-text'); this.error.setAttribute('role', 'alert');
    this.modal.body.append(this.deadline);
    if (dialog.message) { const message = element('div', 'markdown'); renderMarkdown(message, dialog.message); this.modal.body.append(message); }
    if (dialog.method === 'input' || dialog.method === 'editor') {
      this.value = dialog.method === 'editor' ? element('textarea', 'dialog-editor') : element('input');
      this.value.value = typeof dialog.frame.prefill === 'string' ? dialog.frame.prefill : '';
      this.value.placeholder = typeof dialog.frame.placeholder === 'string' ? dialog.frame.placeholder : 'Response';
      this.value.setAttribute('aria-label', 'Response'); this.modal.body.append(this.value);
      this.value.addEventListener('keydown', event => { if (event instanceof KeyboardEvent && event.key === 'Enter' && (dialog.method === 'input' || event.metaKey) && !event.isComposing) { event.preventDefault(); void this.submit(); } });
    } else if (dialog.method === 'select') {
      const options = Array.isArray(dialog.frame.options) ? dialog.frame.options : [];
      const descriptions = Array.isArray(dialog.frame.optionDetails) ? dialog.frame.optionDetails : [];
      for (const [index, option] of options.entries()) {
        if (typeof option !== 'string') continue;
        const label = element('label', 'dialog-option'); const input = element('input'); input.type = 'radio'; input.name = `select-${dialog.id}`; input.value = option;
        const text = element('span', 'option-text', option); const description = jsonRecord(descriptions[index]);
        if (typeof description?.description === 'string') text.append(element('small', 'muted', description.description));
        label.append(input, text); this.modal.body.append(label); this.choices.push(input);
        input.addEventListener('change', () => this.refreshDeadline());
      }
    } else if (dialog.method === 'ask') {
      const questions = Array.isArray(dialog.frame.questions) ? dialog.frame.questions : [];
      for (const raw of questions) {
        const question = jsonRecord(raw); if (!question || typeof question.id !== 'string' || typeof question.question !== 'string') continue;
        const fieldset = element('fieldset', 'question'); fieldset.append(element('legend', '', question.question));
        if (typeof question.header === 'string') fieldset.append(element('p', 'muted', question.header));
        const input = element('input'); input.placeholder = 'Other response'; input.setAttribute('aria-label', `Other response for ${question.question}`);
        const answer: Answer = { id: question.id, multi: question.multi === true, selected: new Set(), input, options: [] }; this.answers.push(answer);
        const options = Array.isArray(question.options) ? question.options : [];
        for (const [index, rawOption] of options.entries()) {
          const option = jsonRecord(rawOption); if (!option || typeof option.label !== 'string') continue;
          const label = element('label', 'dialog-option'); const choice = element('input'); choice.type = answer.multi ? 'checkbox' : 'radio'; choice.name = `ask-${question.id}`; choice.value = option.label;
          const text = element('span', 'option-text', option.label);
          if (question.recommended === index) text.append(element('small', 'muted', 'Recommended'));
          if (typeof option.description === 'string') text.append(element('small', 'muted', option.description));
          if (typeof option.preview === 'string') text.append(element('pre', 'option-preview', option.preview));
          label.append(choice);
          if (answer.multi) { const mark = icon('check'); mark.classList.add('choice-check'); label.append(mark); }
          label.append(text); fieldset.append(label); answer.options.push(choice);
          choice.addEventListener('change', () => {
            if (!answer.multi) { answer.selected.clear(); input.value = ''; }
            if (choice.checked) answer.selected.add(choice.value); else answer.selected.delete(choice.value);
            this.refreshDeadline();
          });
        }
        input.addEventListener('input', () => { if (!answer.multi && input.value.trim()) { answer.selected.clear(); for (const choice of answer.options) choice.checked = false; } this.refreshDeadline(); });
        fieldset.append(input); this.modal.body.append(fieldset);
      }
    }
    this.modal.body.append(this.error); this.error.textContent = dialog.error;
    this.cancelButton = button(dialog.method === 'confirm' ? 'Deny' : 'Cancel', () => this.respond(dialog.method === 'confirm' ? { confirmed: false } : { cancelled: true }));
    this.submitButton = button(dialog.method === 'confirm' ? 'Allow' : 'Submit', () => this.submit(), 'primary');
    this.modal.footer.append(this.cancelButton, this.submitButton);
    this.timer = window.setInterval(() => this.refreshDeadline(), 500); this.refreshDeadline();
  }
  private refreshDeadline(): void {
    const dialog = this.current; if (!dialog) return;
    const remaining = dialog.deadline === null ? null : Math.max(0, Math.ceil((dialog.deadline - Date.now()) / 1000));
    this.deadline.hidden = remaining === null; this.deadline.textContent = remaining === null ? '' : remaining ? `Expires in ${remaining} seconds` : 'Request expired. Waiting for OMP…';
    const complete = dialog.method === 'select' ? this.choices.some(choice => choice.checked) : dialog.method === 'ask' ? this.answers.length > 0 && this.answers.every(answer => answer.multi || answer.selected.size > 0 || !!answer.input.value.trim()) : true;
    if (this.submitButton) this.submitButton.disabled = this.submitting || remaining === 0 || !complete;
    if (this.cancelButton) this.cancelButton.disabled = this.submitting;
  }
  private async submit(): Promise<void> {
    const dialog = this.current; if (!dialog || this.submitButton?.disabled) return;
    switch (dialog.method) {
      case 'confirm': await this.respond({ confirmed: true }); break;
      case 'input': case 'editor': await this.respond({ value: this.value?.value ?? '' }); break;
      case 'select': { const selected = this.choices.find(choice => choice.checked); if (selected) await this.respond({ value: selected.value }); break; }
      case 'ask': await this.respond({ answers: this.answers.map(answer => {
        const fields: JsonRecord = { id: answer.id, selectedOptions: answer.options.filter(choice => answer.selected.has(choice.value)).map(choice => choice.value) };
        const custom = answer.input.value.trim(); if (custom) fields.customInput = custom; return fields;
      }) }); break;
    }
  }
  private async respond(fields: JsonRecord): Promise<void> {
    const current = this.current; if (!current || this.submitting) return;
    const threadID = this.threadID; this.submitting = true; this.refreshDeadline();
    try {
      const admitted = await request({ kind: 'dialog', id: threadID, dialogID: current.id, fields });
      if (admitted !== true && this.current?.id === current.id) throw new Error('OMP did not accept this response. Your input was kept.');
    } catch (error) { if (this.current?.id === current.id) this.error.textContent = errorText(error); }
    finally { if (this.current?.id === current.id) { this.submitting = false; this.refreshDeadline(); } }
  }
  private dismiss(): void {
    window.clearInterval(this.timer); this.modal?.close(); this.modal = null; this.current = null; this.value = null; this.choices = []; this.answers = []; this.submitButton = null; this.cancelButton = null;
  }
}
