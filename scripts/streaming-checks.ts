import { Conversation } from '../src/renderer/conversation';
import { renderMarkdown } from '../src/renderer/markdown';
import type { ChatMessage, RuntimeSnapshot } from '../src/shared/types';

function verify(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise;
};

/** Real presentation timing, completion, corrections, and stable text identity. */
export async function checkStreamingPresentation(view: Conversation, initial: RuntimeSnapshot): Promise<string> {
  let message: ChatMessage = { id: 'adaptive-reply', role: 'assistant', text: 'Already readable.', thinking: 'Existing reasoning.', toolIDs: [], error: null, isStreaming: true };
  let runtime = { ...initial, messages: [message] };
  const update = (change: Partial<ChatMessage>): void => {
    message = { ...message, ...change };
    runtime = { ...runtime, revision: runtime.revision + 1, messages: [message] };
    view.update(runtime, runtime.id);
  };
  view.update(runtime, runtime.id);
  const body = view.content.querySelector<HTMLElement>('[data-message-id="adaptive-reply"] > .markdown:not(.reasoning)');
  const reasoning = view.content.querySelector<HTMLElement>('.reasoning');
  verify(body && reasoning, 'Missing streamed message containers.');
  const source = 'Already readable.' + ' New words arrive in one network burst.'.repeat(12);
  update({ text: source, thinking: 'Existing reasoning. ' + 'Reasoning burst. '.repeat(20) });
  verify(body.textContent?.trim() === 'Already readable.', 'An arriving burst bypassed presentation buffering.');
  await sleep(180);
  const intermediate = body.textContent?.trim() ?? '';
  verify(intermediate.length > 'Already readable.'.length && intermediate.length < source.length && source.startsWith(intermediate), 'Burst presentation did not advance through an exact source prefix.');
  verify((reasoning.textContent?.length ?? 0) > 'Existing reasoning.'.length, 'Reasoning did not advance independently.');
  update({ isStreaming: false });
  verify(body.textContent?.trim() === source && reasoning.textContent?.trim() === message.thinking.trim(), 'Completion did not synchronously flush all buffered text.');
  verify(!body.querySelector('.stream-word'), 'Completion retained transient fade wrappers.');
  await sleep(120);
  verify(body.textContent?.trim() === source, 'A stale presentation frame overwrote the completed response.');

  update({ isStreaming: true, text: 'Restarted stream.' });
  update({ text: 'Restarted stream.' + ' Pending text.'.repeat(30) });
  update({ text: 'Authoritative replacement.' });
  verify(body.textContent?.trim() === 'Authoritative replacement.', 'A non-append correction replayed stale buffered text.');
  await sleep(100);
  verify(body.textContent?.trim() === 'Authoritative replacement.', 'A pending timer resurrected replaced source.');
  update({ text: 'Authoritative replacement.' + ' Hidden backlog.'.repeat(30) });
  view.activate();
  verify(body.textContent?.trim() === message.text && !body.querySelector('.stream-word'), 'Reactivation replayed or lost buffered text.');
  update({ isStreaming: false });

  const target = document.createElement('div'); target.className = 'markdown'; view.content.append(target);
  try {
    renderMarkdown(target, 'Read this.');
    renderMarkdown(target, 'Read this. Smooth', true);
    const word = target.querySelector<HTMLSpanElement>('.stream-word');
    verify(word, 'Fresh prose did not receive a fade.');
    const animation = word.getAnimations()[0];
    verify(animation, 'Fresh prose did not start a real animation.');
    await animation.ready;
    const start = animation.startTime;
    await sleep(45);
    const style = getComputedStyle(word);
    verify(Number(style.opacity) > 0 && Number(style.opacity) < 1 && style.filter === 'none', 'Streaming text did not progress through an opacity-only fade.');
    renderMarkdown(target, 'Read this. Smoother, ', true);
    verify(target.querySelector('.stream-word') === word && word.getAnimations()[0] === animation && animation.startTime === start, 'A word continuation or punctuation restarted its fade.');
    const selection = window.getSelection();
    const first = target.querySelector('p')?.firstChild;
    verify(first instanceof Text, 'Missing selectable prose.');
    selection?.setBaseAndExtent(first, 8, first, 0);
    renderMarkdown(target, 'Read this. Smoother, new prose.', true);
    verify(selection?.toString() === 'Read thi', 'Streaming append changed the selected text.');
    renderMarkdown(target, 'Read this. Smoother, new prose.');
    verify(selection?.toString() === 'Read thi' && !target.querySelector('.stream-word'), 'Final cleanup lost selection or retained animation wrappers.');
    selection?.removeAllRanges();
    renderMarkdown(target, 'hello ', true);
    renderMarkdown(target, 'hello world', true);
    verify(target.textContent?.trim() === 'hello world', 'A trailing space moved after the appended word.');
    for (const [before, after] of [['e', 'e\u0301'], ['👩', '👩\u200d💻']]) {
      renderMarkdown(target, '');
      renderMarkdown(target, `${before}`, true);
      const span = target.querySelector('.stream-word');
      verify(span, 'Unicode text did not receive an initial span.');
      renderMarkdown(target, `${after}`, true);
      verify(target.querySelector('.stream-word') === span && target.textContent?.trim() === after, 'A split Unicode continuation replaced its existing text span.');
    }
    renderMarkdown(target, 'A **partial', true);
    renderMarkdown(target, 'A **partial emphasis**', true);
    verify(target.querySelector('strong')?.textContent === 'partial emphasis', 'Markdown conversion duplicated or lost streamed text.');
    renderMarkdown(target, '```ts\nconst n = 1;\n```\n\nFollowing', true);
    renderMarkdown(target, '```ts\nconst n = 1;\n```\n\nFollowing prose', true);
    verify(!target.querySelector('pre .stream-word') && target.querySelector('p .stream-word'), 'Code animated or prose after code failed to fade.');
  } finally { target.remove(); }
  return 'Adaptive bursts and reasoning advance through source prefixes; completion, correction and activation flush without stale frames; opacity-only fades retain word/Unicode identity, selection and code boundaries.';
}
