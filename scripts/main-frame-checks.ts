import { Conversation } from '../src/renderer/conversation';
import { TodoPanel } from '../src/renderer/todo-panel';
import type { RuntimeSnapshot } from '../src/shared/types';
import { SurfacePresence } from '../src/renderer/surface-presence';

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
    const surface = document.createElement('aside');
    surface.style.cssText = 'height:360px;position:absolute;inset:0 auto auto 0;width:248px';
    const presence = new SurfacePresence(surface); host.append(surface);
    try {
      presence.setVisible(false, true); presence.setVisible(true); await settle();
      presence.setVisible(false, true);
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      presence.setVisible(true); await settle();
      verify(!surface.hidden && !surface.inert && getComputedStyle(surface).opacity === '1',
        'An instant hide followed by a repeated animated entry left an invisible occupied surface.');
      presence.setVisible(false);
      await new Promise<void>(resolve => window.setTimeout(resolve, 155));
      presence.setVisible(true, true); await settle();
      verify(!surface.hidden && !surface.inert && getComputedStyle(surface).opacity === '1' && getComputedStyle(surface).translate === '0px',
        'Snapping a nearly finished exit back open retained a transparent or translated surface.');
    } finally { presence.dispose(); surface.remove(); }
    const layout = { ...runtime, id: 'panel-layout' };
    const agentToggle = panels.controls.querySelector<HTMLButtonElement>('.agent-toggle');
    const agents = panels.rail.querySelector<HTMLElement>('.agents-panel');
    if (!agentToggle || !agents) throw new Error('Missing activity panel controls.');
    panels.update({ ...layout, todoPhases: [], subagents: [] }, layout.id); await settle();
    verify(parseFloat(getComputedStyle(host).paddingInlineEnd) < 1, 'Empty activity reserved a chat lane.');
    panels.update({ ...layout, subagents: [] }, layout.id); await settle();
    verify(panels.node.checkVisibility() && !agents.checkVisibility() && parseFloat(getComputedStyle(host).paddingInlineEnd) > 270, 'Tasks alone did not occupy their docked lane.');
    panels.update(layout, layout.id); await settle();
    verify(agents.getBoundingClientRect().top >= panels.node.getBoundingClientRect().bottom, 'Visible Tasks and Agents overlapped instead of stacking.');
    panels.toggle.click();
    await new Promise<void>(resolve => window.setTimeout(resolve, 150));
    const switched = { ...layout, id: 'panel-layout-switched' };
    panels.update(switched, switched.id); await settle();
    verify(!panels.node.hidden && !panels.node.inert && getComputedStyle(panels.node).opacity === '1' && getComputedStyle(panels.toggle).opacity === '1',
      'Switching conversations during a panel exit left Tasks or its toggle transparent.');
    panels.toggle.click(); await settle();
    verify(Math.abs(agents.getBoundingClientRect().top - panels.rail.getBoundingClientRect().top) < 1,
      'Collapsed Tasks retained a blank slot above Agents.');
    agentToggle.click(); await settle();
    verify(!panels.node.checkVisibility() && !agents.checkVisibility() && parseFloat(getComputedStyle(host).paddingInlineEnd) < 1,
      'Collapsing both panels left an empty reserved lane.');
    panels.update({ ...switched, revision: switched.revision + 1 }, switched.id); await settle();
    verify(parseFloat(getComputedStyle(host).paddingInlineEnd) < 1, 'A passive activity update reopened the empty chat lane.');
    agentToggle.click(); await settle();
    verify(agents.checkVisibility() && Math.abs(agents.getBoundingClientRect().top - panels.rail.getBoundingClientRect().top) < 1 && parseFloat(getComputedStyle(host).paddingInlineEnd) > 270,
      'Agents alone failed to dock at the top of its occupied lane.');
    panels.update({ ...switched, todoPhases: [], subagents: [] }, switched.id); await settle();
    verify(parseFloat(getComputedStyle(host).paddingInlineEnd) < 1, 'Removing all activity retained its lane.');
    host.style.width = '720px';
    const compact = { ...layout, id: 'panel-layout-compact' };
    panels.update(compact, compact.id); await settle();
    verify(panels.toggle.getAttribute('aria-expanded') === 'false' && agentToggle.getAttribute('aria-expanded') === 'false' && parseFloat(getComputedStyle(host).paddingInlineEnd) < 1,
      'Compact activity reserved a docked lane before opening.');
    panels.toggle.click(); await settle();
    verify(panels.node.checkVisibility() && parseFloat(getComputedStyle(host).paddingInlineEnd) < 1, 'A compact overlay shifted the conversation sideways.');
    host.style.width = '1100px'; await settle();
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

    const disclosureTool = { id: 'disclosure-tool', name: 'glob', target: 'src/**/*.ts', detail: 'Inspect source files', output: 'Found source files.', state: 'succeeded', startedAt: 0, endedAt: 1000 } satisfies RuntimeSnapshot['tools'][number];
    runtime = { ...runtime, revision: runtime.revision + 1, messages: [
      { id: 'disclosure-owner', role: 'assistant', text: '', thinking: '', toolIDs: [disclosureTool.id], error: null, isStreaming: false },
      { id: 'disclosure-advisor', role: 'custom', customType: 'advisor', text: '', thinking: '', toolIDs: [], error: null, isStreaming: false, details: { notes: [{ note: 'Keep the disclosure state through updates.', severity: 'concern' }] } },
      { id: 'disclosure-rule', role: 'developer', text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions.md">Keep the rule instructions readable.</system-reminder>', thinking: '', toolIDs: [], error: null, isStreaming: false },
    ], tools: [disclosureTool] };
    view.update(runtime, runtime.id);
    const disclosures = ['.activity-group', '.tool', '.advisor-group', '.notice-rule-details'];
    for (const selector of disclosures) {
      const disclosure = view.content.querySelector<HTMLDetailsElement>(selector), control = disclosure?.querySelector('summary');
      if (!disclosure || !control) throw new Error(`Missing disclosure fixture: ${selector}`);
      disclosure.open = false; editor.focus(); await settle();
      const caret = control.querySelector('.disclosure-caret');
      if (!caret) throw new Error(`Missing disclosure indicator: ${selector}`);
      const name = control.querySelector('.activity-current,.tool-name,.advisor-label') ?? control.querySelector(':scope > span');
      const glyph = control.querySelector(':scope > svg:not(.disclosure-caret),:scope > .activity-label > svg');
      if (!name || (!glyph && selector !== '.notice-rule-details')) throw new Error(`Missing preserved icon or label: ${selector}`);
      const fullText = control.querySelector('.activity-current,.advisor-label') ?? control.querySelector('.tool-target:not(:empty)') ?? name;
      const nameBounds = name.getBoundingClientRect(), textBounds = fullText.getBoundingClientRect(), caretBounds = caret.getBoundingClientRect();
      const textGap = caretBounds.left - textBounds.right;
      verify(textGap > 0 && textGap < 8 && nameBounds.width > 0, 'The caret was not one compact space after the full row text.');
      if (glyph) verify(glyph.getBoundingClientRect().width === 16 && glyph.getBoundingClientRect().right <= nameBounds.left && getComputedStyle(glyph).opacity === '1',
        'A disclosure lost its original leading icon.');
      verify(getComputedStyle(caret).opacity === '0', 'An idle collapsed row retained its caret.');
      control.click(); editor.focus(); await settle();
      const openAngle = new DOMMatrix(getComputedStyle(caret).transform);
      verify(disclosure.open && getComputedStyle(caret).opacity === '1' && (!glyph || getComputedStyle(glyph).opacity === '1') && Math.abs(openAngle.a) < .01 && openAngle.b > .99,
        'An expanded row lost its downward caret after focus left.');
      control.click(); editor.focus(); await settle();
      verify(!disclosure.open && getComputedStyle(caret).opacity === '0', 'Closing a row did not restore its idle caret behavior.');
      control.click(); await settle();
    }
    runtime = { ...runtime, revision: runtime.revision + 1, tools: [{ ...disclosureTool, output: 'Updated source results.' }],
      messages: runtime.messages.map(message => message.customType === 'advisor' ? { ...message, details: { notes: [{ note: 'A higher-severity update.', severity: 'blocker' }] } } : message.role === 'developer' ? { ...message, details: { refreshed: true } } : message) };
    view.update(runtime, runtime.id); editor.focus(); await settle();
    for (const selector of disclosures) {
      const disclosure = view.content.querySelector<HTMLDetailsElement>(selector), caret = disclosure?.querySelector('summary .disclosure-caret');
      verify(disclosure?.open && caret && getComputedStyle(caret).opacity === '1' && new DOMMatrix(getComputedStyle(caret).transform).b > .99,
        'Tool or Advisor updates reset a persistent expanded caret.');
    }
    return [
      'Find reveals the exact Advisor note, clears on Escape, restores focus, and survives interrupted exits.',
      'Advisor and task updates preserve unchanged selected prose; agent updates preserve focused disclosures.',
      'Compact panels default closed, reverse safely, and return focus when their data disappears.',
      'Tasks and Agents reserve a lane only while docked and expanded; collapsed, empty, and compact states stay centered, and interrupted thread switches restore opaque panels.',
      'Activity, tool, Advisor, and rule-instruction carets follow the full row text, persist downward when expanded, hide on collapse, and survive updates; existing leading icons remain visible.',
    ];
  } finally {
    getSelection()?.removeAllRanges(); panels.dispose(); view.dispose(); host.remove();
  }
}
