import { Conversation } from '../src/renderer/conversation';
import { TodoPanel } from '../src/renderer/todo-panel';
import type { RuntimeSnapshot } from '../src/shared/types';

function verify(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
async function settle(): Promise<void> { await new Promise<void>(resolve => window.setTimeout(resolve, 280)); }

export async function checkMainFrameStates(): Promise<string[]> {
  const host = document.createElement('main'); host.className = 'main';
  host.style.cssText = 'position:fixed;inset:8px auto 8px 8px;width:1100px;z-index:100';
  const view = new Conversation(), footer = document.createElement('section'), editor = document.createElement('input');
  footer.className = 'composer'; footer.append(editor);
  const panels = new TodoPanel(host, footer);
  host.append(view.node, footer, panels.rail, panels.controls); document.body.append(host);
  const notes = Array.from({ length: 18 }, (_, index) => ({ note: index === 17 ? 'A deeply nested searchable sentinel.' : `Review ${index}: preserve selected prose during incremental updates. [Reference](https://example.com).`, severity: 'nit' }));
  let runtime: RuntimeSnapshot = {
    id: 'main-frame-a', revision: 1, status: { kind: 'ready', activity: 'idle' }, models: [], selectedModelID: '', thinkingLevels: [], thinkingLevel: '', contextUsage: null,
    messages: [{ id: 'review', role: 'custom', text: '', thinking: '', toolIDs: [], error: null, isStreaming: false, customType: 'advisor', display: true, details: { notes } }],
    tools: [], dialogs: [], queuedFollowUps: [], queuedSteers: [], error: null, notice: null,
    todoPhases: [{ name: 'Checks', tasks: [{ content: 'Preserve the current selection', status: 'completed' }, { content: 'Keep progress readable', status: 'in_progress' }] }],
    subagents: [{ id: 'review-agent', title: 'Review agent', status: 'running', detail: 'Inspecting the main frame.', messageID: 'review' }],
  };
  try {
    view.update(runtime, runtime.id); panels.update(runtime, runtime.id); await settle();
    editor.focus(); view.showFind(); view.findInput.value = 'searchable sentinel'; view.findInput.dispatchEvent(new Event('input')); await settle();
    const match = view.content.querySelector<HTMLElement>('.advisor-notice.find-match');
    if (!match) throw new Error('Find lost a matching Advisor note.');
    const target = match.getBoundingClientRect(), viewport = view.scroll.getBoundingClientRect();
    verify(view.content.querySelector<HTMLDetailsElement>('.advisor-group')?.open && target.top >= viewport.top && target.bottom <= viewport.bottom, 'Find opened a batch but did not position the matching note in view.');
    view.findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    verify(view.find.inert && !view.findInput.value && !view.content.querySelector('.find-match') && document.activeElement === editor, 'Closing Find retained its query, interactive controls, highlighting, or lost the original focus.');
    await new Promise<void>(resolve => window.setTimeout(resolve, 25)); view.showFind(); await settle();
    verify(!view.find.hidden && !view.find.inert && document.activeElement === view.findInput, 'Reversing a Find exit allowed an obsolete completion to hide the reopened surface.');
    view.find.querySelector<HTMLButtonElement>('[aria-label="Close find"]')?.click(); await settle();

    const group = view.content.querySelector<HTMLDetailsElement>('.advisor-group'), note = view.content.querySelector<HTMLElement>('.advisor-notice');
    const text = note?.querySelector('.result-prose p')?.firstChild;
    if (!group || !note || !text) throw new Error('Missing selectable Advisor prose.');
    const disclosureSummary = group.querySelector('summary'), link = note.querySelector('a');
    if (!disclosureSummary || !link) throw new Error('Missing native disclosure controls.');
    disclosureSummary.focus(); disclosureSummary.click(); link.focus();
    verify(document.activeElement === disclosureSummary, 'Closing disclosure content remained focusable during its visual exit.');
    disclosureSummary.click(); await settle();
    const range = document.createRange(); range.selectNodeContents(text);
    getSelection()?.removeAllRanges(); getSelection()?.addRange(range); const selected = getSelection()?.toString();
    notes.push({ note: 'An appended note must not replace existing prose.', severity: 'nit' });
    runtime = { ...runtime, revision: runtime.revision + 1, messages: runtime.messages.map(message => ({ ...message, details: { notes: [...notes] } })) };
    view.update(runtime, runtime.id);
    verify(view.content.querySelector('.advisor-notice') === note && getSelection()?.toString() === selected, 'Appending Advisor notes replaced unchanged content or destroyed selection.');
    getSelection()?.removeAllRanges();

    host.style.width = '720px'; await settle();
    verify(panels.toggle.getAttribute('aria-expanded') === 'false' && panels.controls.querySelector('.agent-toggle')?.getAttribute('aria-expanded') === 'false', 'Compact mode automatically opened an unrequested Tasks or Agents overlay.');
    panels.toggle.click(); await new Promise<void>(resolve => window.setTimeout(resolve, 25)); panels.toggle.click();
    await new Promise<void>(resolve => window.setTimeout(resolve, 25)); panels.toggle.click(); await settle();
    verify(!panels.node.hidden && !panels.node.inert && panels.toggle.getAttribute('aria-expanded') === 'true', 'Rapid task reversals left the selected panel hidden or inert.');
    const task = panels.node.querySelector<HTMLElement>('.todo-content');
    if (!task) throw new Error('Missing task text.');
    const taskRange = document.createRange(); taskRange.selectNodeContents(task);
    getSelection()?.addRange(taskRange); const taskSelection = getSelection()?.toString();
    runtime = { ...runtime, revision: runtime.revision + 1, todoPhases: runtime.todoPhases.map(phase => ({ ...phase, tasks: phase.tasks.map((item, index) => index ? { ...item, details: 'A progress update elsewhere.' } : item) })) };
    panels.update(runtime, runtime.id);
    verify(panels.node.querySelector('.todo-content') === task && getSelection()?.toString() === taskSelection, 'An unrelated task update rebuilt selected rows.'); getSelection()?.removeAllRanges();
    host.style.width = '1100px'; await settle();
    const summary = panels.rail.querySelector<HTMLElement>('.subagent-summary');
    if (!summary) throw new Error('Missing agent disclosure.');
    summary.click(); summary.focus();
    runtime = { ...runtime, revision: runtime.revision + 1, subagents: runtime.subagents.map(agent => ({ ...agent, detail: `${agent.detail}\n\nAdditional progress.` })) };
    panels.update(runtime, runtime.id);
    verify(document.activeElement === summary && summary.parentElement instanceof HTMLDetailsElement && summary.parentElement.open, 'An agent update replaced its focused summary or collapsed its details.');
    panels.update({ ...runtime, todoPhases: [], subagents: [] }, runtime.id); await settle();
    verify(document.activeElement === editor, 'Removing focused activity left keyboard focus on the document body.');
    return [
      'Find reveals the exact Advisor note, clears on Escape, restores focus, and survives interrupted exits.',
      'Advisor and task updates preserve unchanged selected prose; agent updates preserve focused disclosures.',
      'Compact panels default closed, reverse safely, and return focus when their data disappears.',
    ];
  } finally {
    getSelection()?.removeAllRanges(); panels.dispose(); view.dispose(); host.remove();
  }
}
