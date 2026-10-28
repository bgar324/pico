import type { ChatMessage, RuntimeSnapshot } from '../shared/types';
import { isBusy } from '../shared/types';
import { button, element, errorText, request } from './dom';

interface EditTarget {
  threadID: string;
  message: ChatMessage;
  node: HTMLElement;
  body: HTMLElement;
  control: HTMLButtonElement;
}
interface EditSession {
  target: EditTarget;
  input: HTMLTextAreaElement;
  footer: HTMLElement;
  availability: HTMLElement;
  error: HTMLElement;
  cancel: HTMLButtonElement;
  send: HTMLButtonElement;
  pending: boolean;
}

/** Owns the draft and request lifetime independently of the canonical message DOM. */
export class SentMessageEditor {
  private session: EditSession | null = null;
  private runtime: RuntimeSnapshot | undefined;
  private threadID: string | null = null;
  private activation = 0;
  private disposed = false;

  constructor(private readonly isActive: () => boolean, private readonly onSent: () => void) {}

  activate(): void { this.activation++; }

  update(runtime: RuntimeSnapshot | undefined, threadID: string | null): void {
    if (this.disposed) return;
    if (this.threadID !== threadID) { this.clear(false); this.activation++; this.threadID = threadID; }
    this.runtime = runtime;
    this.render();
  }

  open(target: EditTarget): void {
    if (this.disposed || target.threadID !== this.threadID || target.message.delivery || target.message.id.startsWith('pending-steer-')) return;
    if (this.session) {
      if (this.session.target.message.id !== target.message.id) {
        this.session.error.textContent = this.session.pending ? 'Wait for this message to send.' : 'Send or cancel this edit before editing another message.';
        this.session.error.hidden = false;
      }
      if (!this.session.pending) this.session.input.focus({ preventScroll: true });
      return;
    }
    const input = element('textarea', 'sent-message-editor');
    input.value = target.message.text;
    input.rows = 1;
    input.setAttribute('aria-label', 'Edit message');
    const footer = element('div', 'sent-message-edit-footer');
    const availability = element('p', 'sent-message-edit-help muted');
    availability.setAttribute('role', 'status');
    const error = element('p', 'sent-message-edit-help error-text');
    error.hidden = true; error.setAttribute('role', 'alert');
    const actions = element('div', 'sent-message-edit-actions');
    const cancel = button('Cancel', () => this.cancel(), 'sent-message-edit-cancel');
    const send = button('Send', () => this.submit(), 'primary sent-message-edit-send');
    send.title = 'Send edited message (Command/Ctrl+Enter)';
    actions.append(cancel, send); footer.append(availability, error, actions);
    const session: EditSession = { target, input, footer, availability, error, cancel, send, pending: false };
    this.session = session;
    input.addEventListener('input', () => { error.hidden = true; this.render(); });
    footer.addEventListener('keydown', event => this.keydown(event, session));
    input.addEventListener('keydown', event => this.keydown(event, session));
    target.node.classList.add('is-editing');
    target.node.insertBefore(input, target.body); target.node.append(footer);
    this.render();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollIntoView({ block: 'nearest' });
  }

  remove(messageID: string): void {
    if (this.session?.target.message.id === messageID && !this.session.pending) this.clear(false);
  }

  dispose(): void {
    this.disposed = true; this.activation++; this.clear(false); this.runtime = undefined;
  }

  private unavailable(): string | null {
    const runtime = this.runtime;
    if (!runtime || runtime.status.kind !== 'ready') return 'Reconnect to send this edit.';
    if (isBusy(runtime.status)) return 'Wait for the current work to finish before sending this edit.';
    if (runtime.queuedFollowUps.length || runtime.queuedSteers.length) return 'Wait for queued messages to send or remove them before sending this edit.';
    return null;
  }

  private render(): void {
    const session = this.session;
    if (!session) return;
    const unavailable = this.unavailable();
    const blank = !session.input.value.trim() && !session.target.message.images?.length;
    session.input.readOnly = session.pending;
    session.cancel.disabled = session.pending;
    session.send.disabled = session.pending || blank || unavailable !== null;
    session.send.textContent = session.pending ? 'Sending…' : 'Send';
    session.footer.setAttribute('aria-busy', String(session.pending));
    const status = session.pending ? 'Starting a new branch…' : unavailable ?? (blank ? 'Enter a message to send.' : '');
    session.availability.hidden = !status;
    if (session.availability.textContent !== status) session.availability.textContent = status;
  }

  private keydown(event: KeyboardEvent, session: EditSession): void {
    if (this.session !== session || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); this.cancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); event.stopPropagation(); void this.submit();
    }
  }

  private cancel(): void {
    if (!this.session || this.session.pending) return;
    this.clear(true);
  }

  private async submit(): Promise<void> {
    const session = this.session;
    if (!session || session.pending || this.unavailable() || (!session.input.value.trim() && !session.target.message.images?.length)) return;
    const activation = this.activation;
    session.pending = true; session.error.hidden = true; this.render();
    session.input.focus({ preventScroll: true });
    try {
      const accepted = await request({ kind: 'edit-message', id: session.target.threadID, messageID: session.target.message.id, message: session.input.value });
      if (this.disposed || this.session !== session) return;
      if (accepted !== true) throw new Error('The message was not sent. Your edit is still here.');
      const follow = this.activation === activation && this.isActive();
      this.clear(false);
      if (follow) this.onSent();
    } catch (failure) {
      if (this.disposed || this.session !== session) return;
      session.error.textContent = errorText(failure); session.error.hidden = false;
    } finally {
      if (this.session === session) { session.pending = false; this.render(); }
    }
  }

  private clear(restoreFocus: boolean): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.target.node.classList.remove('is-editing');
    session.input.remove(); session.footer.remove();
    if (restoreFocus && this.isActive() && session.target.control.isConnected) session.target.control.focus({ preventScroll: true });
  }
}
