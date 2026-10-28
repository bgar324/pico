import { Conversation } from '../src/renderer/conversation';
import { Composer } from '../src/renderer/composer';
import { isRuntimeSnapshot } from '../src/renderer/helpers';
import type { QueuedEditRequest } from '../src/renderer/queued-messages';
import type { ChatMessage, ImageContent, RetractedMessage, RuntimeSnapshot } from '../src/shared/types';

function verify(value: unknown, message: string): void { if (!value) throw new Error(message); }
async function frame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function user(id: string, text: string, images?: ImageContent[]): ChatMessage {
  return { id, role: 'user', text, ...(images ? { images } : {}), thinking: '', toolIDs: [], error: null, isStreaming: false };
}

export async function checkSteeringProjections(view: Conversation, host: HTMLElement, history: RuntimeSnapshot): Promise<string> {
  const bridge = window.pi;
  const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
  const image: ImageContent = { type: 'image', mimeType: 'image/png', data: canvas.toDataURL().split(',')[1] ?? '' };
  const errors: string[] = [], edits: QueuedEditRequest[] = [];
  const copies: ChatMessage[] = [];
  let runtime: RuntimeSnapshot = { ...history, status: { kind: 'ready', activity: 'running' }, models: [{ id: 'vision', modelID: 'vision', provider: 'test', name: 'Vision', supportsImages: true }], selectedModelID: 'vision' };
  const thread = { id: history.id, projectPath: '/steering', displayTitle: 'Steering', ompSessionDirectory: '/steering/session', createdAt: '', updatedAt: '', draft: '', wasRunning: false };
  const other = { ...thread, id: `${thread.id}-other`, draft: 'Other thread draft' };
  const composer = new Composer(text => errors.push(text), async () => null, id => { if (id === runtime.id) view.followLatest(); });
  let promotion = Promise.withResolvers<boolean>();
  let retraction = Promise.withResolvers<RetractedMessage | null>();
  let admission = Promise.withResolvers<boolean>();
  let editDone: Promise<void> = Promise.resolve();
  let promotes = 0, prompts = 0, branches = 0, rejectedPromotion = false;
  const publish = (changes: Partial<RuntimeSnapshot> = {}): void => {
    runtime = { ...runtime, ...changes, revision: runtime.revision + 1 };
    view.update(runtime, runtime.id); composer.update(thread, runtime);
  };
  const projection = (id: string, text: string, status: 'sending' | 'accepted', queue: 'followUp' | 'steering', imageRef: string | null = null, images?: ImageContent[]): ChatMessage => ({
    ...user(id, text, images), delivery: { kind: 'steer', status, queue, imageRef },
  });
  const bubble = (id: string): HTMLElement => {
    const node = view.content.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!node) throw new Error(`Missing projected steer ${id}.`);
    return node;
  };
  const queuedEdit = (id: string): HTMLButtonElement => {
    const control = bubble(id).querySelector<HTMLButtonElement>('.queued-edit');
    if (!control) throw new Error('Missing projected queue withdrawal.');
    return control;
  };
  const away = async (): Promise<void> => {
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    view.scroll.scrollTop -= 300; view.scroll.dispatchEvent(new Event('scroll')); await frame();
    verify(view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop > 100, 'Steering scroll fixture was not away from latest.');
  };
  view.onEditQueued = value => { edits.push(value); editDone = composer.retractQueued(value); return editDone; };
  window.pi = { ...bridge, async request(request) {
    if (request.kind === 'draft') return { ok: true, value: null };
    if (request.kind === 'queued-images') return { ok: true, value: [image] };
    if (request.kind === 'copy-message') {
      const message = runtime.messages.find(message => message.id === request.messageID);
      if (!message) throw new Error('Message missing from the clipboard snapshot.');
      copies.push(message); return { ok: true, value: null };
    }
    if (request.kind === 'edit-message') { branches++; return { ok: true, value: true }; }
    if (request.kind === 'retract-queued') return { ok: true, value: await retraction.promise };
    if (request.kind === 'promote-queued') {
      promotes++;
      const entry = runtime.queuedFollowUps.find(row => row.text === request.message);
      if (!entry) throw new Error('Missing promotion fixture queue entry.');
      const pending = projection('promoted', entry.text, 'sending', 'followUp', entry.imageRef, entry.imageCount ? [image] : undefined);
      publish({ messages: [...runtime.messages, pending] });
      const accepted = await promotion.promise;
      if (rejectedPromotion) {
        publish({ messages: runtime.messages.filter(message => message.id !== pending.id) });
        return { ok: false, error: 'Steer rejected; queued message kept.' };
      }
      return { ok: true, value: accepted };
    }
    if (request.kind === 'prompt') {
      prompts++; verify(request.steer, 'Command-Shift-Return submitted a follow-up instead of a steer.');
      publish({ messages: [...runtime.messages, projection('shortcut', request.message, 'sending', 'steering')] });
      return { ok: true, value: await admission.promise };
    }
    return bridge.request(request);
  } };
  host.append(composer.node);
  try {
    publish({ queuedFollowUps: [{ text: 'Interrupt now', imageCount: 0, imageRef: null }, { text: 'Keep queued', imageCount: 0, imageRef: null }] });
    const historyDeadline = performance.now() + 10000;
    while (view.content.getAttribute('aria-busy') === 'true') { verify(performance.now() < historyDeadline, 'Steering fixture history did not hydrate.'); await frame(); }
    await frame(); await away();
    const steer = view.pending.querySelector<HTMLButtonElement>('.queued-send');
    if (!steer) throw new Error('Missing queued Steer action.');
    steer.click(); await frame();
    const sending = bubble('promoted');
    verify(sending.classList.contains('user-message') && sending.querySelector(':scope > .markdown:not(.reasoning)')?.textContent?.includes('Interrupt now') && sending.dataset.delivery === 'sending', 'Steer did not immediately appear as an ordinary user bubble.');
    verify(sending.querySelector('.message-delivery')?.textContent === 'Sending…' && !queuedEdit('promoted').checkVisibility(), 'Unacknowledged steer exposed withdrawal or claimed acceptance.');
    verify(!sending.querySelector<HTMLButtonElement>('.user-message-edit:not(.queued-edit)')?.checkVisibility(), 'Pending steer exposed historical branch Edit.');
    sending.querySelector<HTMLButtonElement>('.user-message-edit:not(.queued-edit)')?.click();
    verify(!sending.querySelector('.sent-message-editor'), 'Pending projection opened the historical branch editor.');
    verify(view.pending.querySelectorAll('.queued').length === 1 && view.pending.textContent?.includes('Keep queued') && !view.pending.textContent?.includes('Interrupt now'), 'Promoted steer remained duplicated in the queue or hid another follow-up.');
    const bounds = sending.getBoundingClientRect(), viewport = view.scroll.getBoundingClientRect();
    verify(view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop < 2 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom, 'Queued Steer failed to resume following latest.');
    publish({ messages: [...history.messages, projection('promoted', 'Interrupt now', 'accepted', 'steering')], queuedFollowUps: [{ text: 'Keep queued', imageCount: 0, imageRef: null }], queuedSteers: [{ text: 'Interrupt now', imageCount: 0, imageRef: null }] });
    promotion.resolve(true); await frame();
    verify(bubble('promoted') === sending && sending.querySelector('.message-delivery')?.textContent === 'Queued to interrupt' && queuedEdit('promoted').checkVisibility() && !queuedEdit('promoted').disabled, 'Acceptance replaced the bubble or did not offer queued withdrawal.');
    verify(view.pending.querySelectorAll('.queued').length === 1 && !sending.querySelector('.queued-send') && !sending.querySelector('[aria-busy="true"]'), 'Accepted steer gained duplicate actions or a busy indicator.');
    publish({ messages: [...history.messages, user('native-steer', 'Interrupt now')], queuedSteers: [] });
    verify(!view.content.querySelector('[data-message-id="promoted"]') && view.content.querySelectorAll('[data-message-id="native-steer"]').length === 1 && !bubble('native-steer').querySelector('.queued-edit') && bubble('native-steer').querySelector('.message-delivery')?.hasAttribute('hidden'), 'Canonical delivery did not replace the projection exactly once and clear pending controls.');
    const dropped = { ...user('pending-steer-dropped', 'Retained steer', [image]), error: 'OMP removed this steer before delivery. Your message is kept here and was not resent.' };
    publish({ messages: [dropped], queuedFollowUps: [] });
    const retained = bubble(dropped.id);
    retained.querySelector<HTMLButtonElement>('.user-message-edit')?.click();
    verify(retained.querySelector('.error-text:not([hidden])')?.textContent === dropped.error && retained.querySelector('img') && !retained.querySelector<HTMLButtonElement>('.user-message-edit')?.checkVisibility() && !retained.querySelector('.sent-message-editor') && retained.querySelector('.message-delivery')?.hasAttribute('hidden'), 'Removed native steer lost recoverable content or exposed historical branch editing.');
    retained.querySelector<HTMLButtonElement>('.user-message-copy')?.click(); await frame();
    verify(copies[0] === dropped && copies[0]?.images?.[0] === image, 'Retained steer copy did not use its full text/image snapshot.');

    publish({ messages: [projection('duplicate-one', 'Duplicate', 'accepted', 'steering')], queuedSteers: [{ text: 'Duplicate', imageCount: 0, imageRef: null }, { text: 'Duplicate', imageCount: 0, imageRef: null }], queuedFollowUps: [{ text: 'Duplicate', imageCount: 0, imageRef: null }] });
    verify(view.pending.querySelectorAll('.queued').length === 2 && view.content.querySelectorAll('.user-message').length === 1, 'FIFO projection suppression hid unrelated same-text rows.');
    publish({ messages: [projection('duplicate-one', 'Duplicate', 'accepted', 'steering'), projection('duplicate-two', 'Duplicate', 'accepted', 'steering')] });
    verify(view.pending.querySelectorAll('.queued').length === 1 && view.pending.querySelector('.queued')?.getAttribute('data-queue-state') === 'follow-up', 'Two same-text projections did not each suppress exactly one steering row.');
    publish({ messages: [projection('image-steer', 'Duplicate', 'accepted', 'steering', 'second-image', [image])], queuedSteers: [{ text: 'Duplicate', imageCount: 1, imageRef: 'first-image' }, { text: 'Duplicate', imageCount: 1, imageRef: 'second-image' }], queuedFollowUps: [] });
    verify(view.pending.querySelector('.queued')?.getAttribute('data-image-ref') === 'first-image' && queuedEdit('image-steer').disabled && queuedEdit('image-steer').title.includes('same text'), 'Image-ref matching hid the wrong duplicate or bypassed ambiguous attachment withdrawal.');

    publish({ messages: [projection('image-steer', 'Image steer', 'accepted', 'steering', 'second-image', [image])], queuedSteers: [{ text: 'Image steer', imageCount: 1, imageRef: 'second-image' }] });
    verify(!view.pending.children.length && bubble('image-steer').querySelector('img')?.getAttribute('src') === canvas.toDataURL(), 'Projected image steer lost actual image bytes or retained a second queue representation.');
    queuedEdit('image-steer').click(); queuedEdit('image-steer').click();
    verify(edits.length === 1 && edits[0]?.entry.imageRef === 'second-image' && edits[0]?.queue === 'steering' && edits[0]?.images?.[0] === image, 'Projected pencil did not reuse exact queue metadata/images or allowed double withdrawal.');
    publish({ messages: [], queuedSteers: [] });
    composer.update(other, { ...runtime, id: other.id }); view.update({ ...runtime, id: other.id, messages: [user('other-message', 'Other thread')] }, other.id); view.scroll.focus();
    retraction.resolve({ text: 'Image steer', images: [image], imagesDropped: false }); await editDone; await frame();
    verify(composer.editor.value === other.draft && !composer.node.querySelector('.composer-image') && document.activeElement === view.scroll && !view.content.textContent?.includes('Image steer'), 'Late projected withdrawal leaked text, images, or focus into another thread.');
    publish();
    verify(composer.editor.value === 'Image steer' && composer.node.querySelectorAll('.composer-image').length === 1, 'Disappearing projected row lost withdrawn source text or image after switching back.');
    composer.node.querySelector<HTMLButtonElement>('.image-remove')?.click(); composer.editor.value = ''; composer.editor.dispatchEvent(new Event('input', { bubbles: true }));

    retraction = Promise.withResolvers<RetractedMessage | null>();
    publish({ messages: [projection('withdraw-fails', 'Keep this steer', 'accepted', 'steering')], queuedSteers: [{ text: 'Keep this steer', imageCount: 0, imageRef: null }] });
    queuedEdit('withdraw-fails').click(); retraction.reject(new Error('Withdrawal unavailable')); await editDone; await frame();
    verify(errors.includes('Withdrawal unavailable') && bubble('withdraw-fails').textContent?.includes('Keep this steer') && !queuedEdit('withdraw-fails').disabled && !view.pending.children.length && composer.editor.value === '', 'Withdrawal failure lost the projected steer or left its pencil stuck.');

    rejectedPromotion = true; promotion = Promise.withResolvers<boolean>();
    publish({ messages: [], queuedSteers: [], queuedFollowUps: [{ text: 'Recover queued steer', imageCount: 0, imageRef: null }] });
    view.pending.querySelector<HTMLButtonElement>('.queued-send')?.click();
    verify(bubble('promoted').textContent?.includes('Recover queued steer') && !view.pending.children.length, 'Rejected-promotion fixture did not first project immediately.');
    promotion.resolve(false); await frame();
    verify(!view.content.querySelector('[data-message-id="promoted"]') && view.pending.querySelector('.queued-text')?.textContent === 'Recover queued steer' && view.pending.querySelector('.error-text:not([hidden])')?.textContent?.includes('Steer rejected') && !view.pending.querySelector<HTMLButtonElement>('.queued-send')?.disabled && promotes === 2 && prompts === 0, 'Failed promotion did not restore its queued row and retryable error without replay.');

    rejectedPromotion = false; promotion = Promise.withResolvers<boolean>();
    publish({ messages: [], queuedSteers: [], queuedFollowUps: [{ text: 'Late native acceptance', imageCount: 0, imageRef: null }] });
    view.pending.querySelector<HTMLButtonElement>('.queued-send')?.click();
    promotion.reject(new Error('Admission unknown after timeout')); await frame();
    verify(bubble('promoted').querySelector('.error-text:not([hidden])'), 'Unknown admission did not expose its unresolved failure.');
    publish({ messages: [projection('promoted', 'Late native acceptance', 'accepted', 'steering')], queuedFollowUps: [], queuedSteers: [{ text: 'Late native acceptance', imageCount: 0, imageRef: null }] });
    verify(!bubble('promoted').querySelector('.error-text:not([hidden])'), 'Late native acceptance retained an obsolete admission-unknown error.');

    publish({ messages: history.messages, queuedFollowUps: [], queuedSteers: [] }); await frame(); await away();
    composer.editor.value = 'Shortcut steer'; composer.editor.dispatchEvent(new Event('input', { bubbles: true }));
    composer.editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); await frame();
    verify(prompts === 1 && bubble('shortcut').textContent?.includes('Shortcut steer') && view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop < 2, 'Command-Shift-Return did not immediately reveal the projected steer and follow latest.');
    composer.update(other, { ...runtime, id: other.id }); view.update({ ...runtime, id: other.id, messages: [user('other-message', 'Other thread')] }, other.id); view.scroll.focus();
    admission.resolve(true); await frame();
    verify(composer.editor.value === other.draft && !view.content.querySelector('[data-message-id="shortcut"]') && document.activeElement === view.scroll, 'Late steer acceptance changed the selected other thread.');
    const valid = projection('boundary', 'Boundary steer', 'accepted', 'steering');
    const boundary = { ...runtime, messages: [valid] };
    verify(isRuntimeSnapshot(boundary) && !isRuntimeSnapshot({ ...boundary, messages: [{ ...valid, delivery: { ...valid.delivery, status: 'consumed' } }] }) && !isRuntimeSnapshot({ ...boundary, messages: [{ ...valid, delivery: { ...valid.delivery, queue: 'other' } }] }), 'Renderer boundary accepted invalid steer delivery metadata or rejected valid metadata.');
    verify(branches === 0 && errors.length === 1, 'Projected steers invoked historical branch editing or introduced unexpected composer errors.');
    return 'Steers project immediately in chat; explicit queued/shortcut actions follow latest, FIFO queue suppression preserves duplicate/image identities, accepted withdrawal retains real images, failures recover without replay, canonical replacement is singular, and late replies stay thread-local.';
  } finally {
    promotion.resolve(false); retraction.resolve(null); admission.resolve(false);
    view.onEditQueued = null; composer.node.remove(); window.pi = bridge;
  }
}
