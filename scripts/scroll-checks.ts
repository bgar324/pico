import type { RuntimeSnapshot } from '../src/shared/types';
import type { Conversation } from '../src/renderer/conversation';

async function frame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export async function checkManualStreamingScroll(view: Conversation, fixture: RuntimeSnapshot): Promise<string> {
  const tail = fixture.messages.at(-1);
  if (!tail) throw new Error('Missing streaming scroll fixture.');
  let runtime: RuntimeSnapshot = { ...fixture, status: { kind: 'ready', activity: 'running' }, messages: fixture.messages.slice(-40).map(message => message.id === tail.id ? { ...message, isStreaming: true } : message) };
  const append = (): void => {
    runtime = { ...runtime, revision: runtime.revision + 1, messages: runtime.messages.map(message => message.id === tail.id ? { ...message, text: `${message.text}\n\nMore streamed text that must not move the reader. ${'Readable output. '.repeat(20)}` } : message) };
    view.update(runtime, runtime.id);
  };
  view.update(runtime, runtime.id); await frame();
  view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 }));
  view.scroll.scrollTop -= 12; view.scroll.dispatchEvent(new Event('scroll'));
  const nearBottomPosition = view.scroll.scrollTop;
  for (let index = 0; index < 4; index++) {
    append(); await frame();
    if (view.scroll.scrollTop !== nearBottomPosition) throw new Error('A small upward scroll near the bottom was overridden by streamed text.');
  }
  // Cancel the already-queued bottom frame, even for a one-pixel upward gesture.
  view.followLatest();
  view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
  view.scroll.scrollTop -= 1; view.scroll.dispatchEvent(new Event('scroll'));
  const interruptedJump = view.scroll.scrollTop;
  append(); await frame();
  if (view.scroll.scrollTop !== interruptedJump) throw new Error('A queued jump to latest overrode a newer upward scroll.');
  // Returning to the bottom manually does not silently re-arm following.
  view.scroll.scrollTop = view.scroll.scrollHeight; view.scroll.dispatchEvent(new Event('scroll'));
  const manuallyReturned = view.scroll.scrollTop;
  append(); await frame();
  if (view.scroll.scrollTop !== manuallyReturned) throw new Error('A passive scroll event silently resumed streaming follow.');
  view.jump.click(); await frame(); append(); await frame();
  if (view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop > 2) throw new Error('Explicit Jump to latest did not resume following.');
  view.scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
  view.scroll.scrollTop -= 4; view.scroll.dispatchEvent(new Event('scroll'));
  const keyboardPosition = view.scroll.scrollTop;
  append(); await frame();
  if (view.scroll.scrollTop !== keyboardPosition) throw new Error('Streaming overrode keyboard scrolling.');
  view.followLatest(); await frame();
  view.scroll.scrollTop -= 8; view.scroll.dispatchEvent(new Event('scroll'));
  const pointerPosition = view.scroll.scrollTop;
  append(); await frame();
  if (view.scroll.scrollTop !== pointerPosition) throw new Error('Streaming overrode manual scrollbar movement.');
  view.followLatest(); await frame();
  view.scroll.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse' }));
  append(); await frame();
  if (view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop > 2) throw new Error('A plain pointer click unexpectedly paused following.');
  return 'Small upward wheel gestures, keyboard/scrollbar movement, and pending bottom frames yield to the reader; plain clicks preserve follow and an explicit Jump or submission resumes it.';
}
