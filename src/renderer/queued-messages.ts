import type { RuntimeSnapshot } from '../shared/types';
import { element, errorText, iconButton, request } from './dom';
import { icon } from './icons';

export class QueuedMessages {
  readonly node = element('div', 'pending-messages');
  private signature = '';
  update(runtime: RuntimeSnapshot | undefined, threadID: string | null): void {
    const entries = runtime ? [
      ...runtime.queuedSteers.map(text => ({ text, steering: true })),
      ...runtime.queuedFollowUps.map(text => ({ text, steering: false })),
    ] : [];
    const signature = JSON.stringify([threadID, entries]);
    if (signature === this.signature) return;
    this.signature = signature; this.node.replaceChildren();
    for (const item of entries) {
      const bubble = element('article', 'message user-message queued'); bubble.dataset.role = 'user';
      const body = element('div', 'plain-message', item.text);
      const footer = element('div', 'queued-actions');
      const status = element('span', 'queued-label muted');
      const statusLabel = item.steering ? 'Sending next' : 'Queued';
      status.append(icon(item.steering ? 'arrow-up' : 'circle'));
      status.title = statusLabel; status.setAttribute('role', 'img'); status.setAttribute('aria-label', statusLabel);
      footer.append(status);
      const error = element('p', 'error-text'); error.hidden = true; error.setAttribute('role', 'alert');
      if (!item.steering && threadID) {
        const send = iconButton('arrow-up', 'Send now', async () => {
          send.disabled = true; error.hidden = true;
          try {
            const promoted = await request({ kind: 'promote-queued', id: threadID, message: item.text });
            if (promoted === false) {
              status.replaceChildren(icon('check')); status.title = 'Already sent'; status.setAttribute('aria-label', 'Already sent'); send.hidden = true;
            }
          } catch (failure) { error.textContent = errorText(failure); error.hidden = false; }
          finally { send.disabled = false; }
        }, 'queued-send');
        send.title = 'Send now. Send into the current run at its next interruption point';
        footer.append(send);
      }
      bubble.append(body, footer, error); this.node.append(bubble);
    }
  }
}
