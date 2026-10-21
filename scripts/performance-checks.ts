import { Conversation } from '../src/renderer/conversation';
import type { ChatMessage, RuntimeSnapshot, ToolActivity } from '../src/shared/types';
import { MessageStore } from '../src/omp/MessageStore';
import { toolIcon } from '../src/renderer/icons';
import { Composer } from '../src/renderer/composer';
import { TodoPanel } from '../src/renderer/todo-panel';
import { checkSidebarTransitions } from './sidebar-checks';
import { checkMainFrameStates } from './main-frame-checks';

function verify(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
async function frame(): Promise<void> {
  const next = Promise.withResolvers<void>(); requestAnimationFrame(() => requestAnimationFrame(() => next.resolve())); await next.promise;
}
function source(id: string): RuntimeSnapshot {
  const messages: ChatMessage[] = Array.from({ length: 600 }, (_, index) => ({ id: `${id}-${index}`, role: 'assistant', text: `History message ${index}. ${'Readable prose. '.repeat(12)}`, thinking: '', toolIDs: [], error: null, isStreaming: false }));
  return { id, revision: 1, status: { kind: 'ready', activity: 'idle' }, models: [], selectedModelID: '', thinkingLevels: [], thinkingLevel: '', contextUsage: null, messages, tools: [], dialogs: [], subagents: [], todoPhases: [], queuedFollowUps: [], queuedSteers: [], error: null, notice: null };
}
async function complete(view: Conversation): Promise<void> {
  const deadline = performance.now() + 10000;
  while (view.content.getAttribute('aria-busy') === 'true') { verify(performance.now() < deadline, 'History loading did not complete.'); await frame(); }
}
function checkNotices(view: Conversation): string[] {
  const reminder = '<system-reminder>Eval runtime state is host-retained, not reconstructed from transcript text. No retained eval runtime is registered in this process.</system-reminder>';
  const imitation = 'Background job example has completed. Resume your work using the result below.\nOrdinary assistant wording.';
  const output = '  > project@1 build\n<widget>ready</widget>\n── Job fake ──\n  # literal heading\n';
  const store = new MessageStore(() => {}, () => {});
  const messages = [
    { role: 'developer', content: reminder },
    { role: 'system', content: reminder },
    { role: 'custom', customType: 'extension-status', display: false, content: 'Hidden engine state' },
    { role: 'user', content: reminder },
    { role: 'assistant', content: imitation },
    { role: 'custom', customType: 'async-result', content: `Background job Build has completed. Resume your work using the result below.\n${output}`, display: true, details: { jobs: [{ jobId: 'Build', type: 'bash' }] } },
    { role: 'bashExecution', command: 'npm run build', output },
    { role: 'pythonExecution', code: 'print("ready")', output },
    { role: 'custom', customType: 'advisor', display: true, content: 'INTERNAL_SOURCE_TOKEN\n<advisory severity="concern">Keep useful feedback.</advisory>', details: { notes: [{ note: 'Keep useful feedback.', severity: 'concern' }] } },
    { role: 'custom', customType: 'extension-status', display: true, content: 'Visible extension status' },
    { role: 'custom', customType: 'async-result', content: `2 background jobs have completed. Resume your work using the results below.\n── Job Build ──\n${output}── Job Other ──\nsecond output`, display: true, details: { jobs: [{ jobId: 'Build', type: 'bash' }, { jobId: 'Other', type: 'bash' }] } },
    { role: 'developer', content: [{ type: 'text', text: '<system-reminder reason="rule_violation" rule="ts-set-map" path="builtin-defaults:ts-set-map.md">\nUser-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.\n\nSmall, static string-keyed lookup tables: `Record<K, V>` / `Record<K, true>`.\n\n`Set` / `Map`: dynamic/non-string keys; runtime insertion/deletion; `.size`, `.clear()`, stable insertion order, or iterator APIs.\n\n```typescript\n// Static literal → Record\nconst LABEL_BY_KIND: Record<string, string> = {\n\ttext: "Text",\n\tjson: "JSON",\n\tbinary: "Binary",\n};\n\n// Dynamic membership → Set\nconst seen = new Set<string>();\nfor (const item of items) {\n\tif (seen.has(item.id)) continue;\n\tseen.add(item.id);\n}\n```\n</system-reminder>' }], attribution: 'agent' },
    { role: 'custom', customType: 'async-result', content: 'Background job Review has completed. Resume your work using the result below.\n<task-result id="Review">Agent audit dump</task-result>', display: true, details: { jobs: [{ jobId: 'Review', type: 'task', schema: { data: { summary: 'Agent audit dump' } } }] } },
    { role: 'custom', customType: 'async-result', content: '2 background jobs have completed. Resume your work using the results below.\n── Job Review ──\nAgent audit dump\n── Job Build ──\nBuild still visible', display: true, details: { jobs: [{ jobId: 'Review', type: 'task' }, { jobId: 'Build', type: 'bash' }] } },
    { role: 'developer', content: '<system-reminder>\ntodo failed, so todo progress is not visible to the user.\nFailure: Errors: Missing phase name for append operation\nRemaining items: none.\nOverall: 5/5 done, 0 open.\nActive phase 2/2 "Verification" (2/2).\n  Trace and repair:\n    - [X] Trace the eval reminder leak and audit engine-message ingestion.\n    - [X] Audit transcript rendering for other concrete provenance and formatting bugs.\n    - [X] Fix confirmed rendering bugs without hiding user or assistant content.\n  Verification:\n    - [X] Exercise affected message paths in an isolated renderer and run relevant checks.\n    - [X] Update behavior documentation and rebuild the packaged app.\nFix the todo payload and call todo again before continuing.\n</system-reminder>' },
    { role: 'custom', customType: 'irc:incoming', display: true, content: '<irc>\nIncoming IRC message from agent `AuthCompletion`:\n\nInternal status from the worker.\n\nSent while waiting/working. Active interruptible wait stopped early for immediate reading.\n\nIf response expected, reply via write (path: "agent://AuthCompletion", content: "..."); may finish current step first. No one replies on your behalf.\n</irc>' },
    { role: 'user', content: 'Incoming IRC message from agent `Example`: this is quoted user content.' },
    { role: 'assistant', content: 'Incoming IRC message from agent `Example`: this is an ordinary explanation.' },
    { role: 'custom', customType: 'async-result', content: '3 background jobs have completed. Resume your work using the results below.\n── Job Review ──\nAgent audit dump\n── Job Build ──\nHidden shell output\n── Job Calculation ──\nUseful calculation result', display: true, details: { jobs: [{ jobId: 'Review', type: 'task' }, { jobId: 'Build', type: 'bash' }, { jobId: 'Calculation', type: 'eval' }] } },
    { role: 'user', content: 'Shell job · bg_1 is quoted text, not a background delivery.' },
    { role: 'assistant', content: 'Shell job · bg_1 finished. The production deployment is ready.' },
  ];
  messages.forEach((message, index) => store.consume({ type: 'message_end', messageId: `notice-${index}`, message }));
  const runtime = { ...source('notices'), messages: structuredClone([...store.messages.values()]) };
  view.update(runtime, runtime.id);
  const row = (index: number): HTMLElement => {
    const node = view.content.querySelector<HTMLElement>(`[data-message-id="notice-${index}"]`);
    if (!node) throw new Error(`Missing notice ${index}.`);
    return node;
  };
  for (const index of [0, 1, 14]) {
    verify(!view.content.querySelector(`[data-message-id="notice-${index}"]`), 'A model-only runtime reminder leaked into the transcript.');
  }
  verify(!view.content.querySelector('[data-message-id="notice-2"]'), 'display:false custom message leaked.');
  verify(row(3).textContent?.includes('Eval runtime state is host-retained') && !row(3).querySelector('.result-source'), 'User content was reclassified as an internal notice.');
  verify(row(4).textContent?.includes(imitation.split('\n')[0] ?? '') && !row(4).querySelector('.background-result'), 'Assistant prose was promoted to a completion notice.');
  verify(!view.content.querySelector('[data-message-id="notice-5"]'), 'A background shell completion leaked into the transcript.');
  for (const [index, command] of [[6, 'npm run build'], [7, 'print("ready")']] as const) {
    verify(row(index).querySelector('.result-console code')?.textContent === `${command}\n\n${output}` && !row(index).querySelector('blockquote,h1'), 'Direct execution output was parsed as Markdown.');
  }
  verify(row(8).querySelector('.notice-concern')?.textContent?.includes('Keep useful feedback.') && !row(8).querySelector(':scope > .markdown > .result-prose') && !row(8).querySelector('.result-source'), 'Advisor content lost its note or retained source clutter.');
  verify(row(9).textContent?.includes('Visible extension status'), 'Visible extension content was hidden.');
  verify(!view.content.querySelector('[data-message-id="notice-10"]'), 'Batched shell completions created transcript cards.');
  verify(row(11).querySelector('.notice-rule-name')?.textContent === 'ts-set-map' && row(11).querySelector('.notice-rule-path')?.textContent === 'builtin-defaults:ts-set-map.md' && !row(11).querySelector<HTMLDetailsElement>('.notice-rule-details')?.open, 'Developer rule reminder lost its compact rule presentation.');
  verify(!view.content.querySelector('[data-message-id="notice-12"]'), 'Agent completion dump leaked into the transcript.');
  verify(!view.content.querySelector('[data-message-id="notice-13"]'), 'A task/shell-only delivery created a transcript card.');
  verify(!view.content.querySelector('[data-message-id="notice-15"]'), 'Internal incoming IRC delivery leaked into the transcript.');
  verify(row(16).textContent?.includes('quoted user content') && row(17).textContent?.includes('ordinary explanation'), 'IRC filtering altered user or assistant content.');
  const mixed = row(18).querySelectorAll('.background-result');
  verify(mixed.length === 1 && mixed[0]?.textContent?.includes('Useful calculation result') && !mixed[0]?.textContent?.includes('Hidden shell output') && !mixed[0]?.textContent?.includes('Agent audit dump'), 'Mixed delivery hid its Eval result or leaked internal task/shell output.');
  verify(row(19).textContent?.includes('quoted text') && row(20).textContent?.includes('production deployment is ready'), 'Shell-job filtering altered user or assistant prose.');
  view.showFind(); view.findInput.value = 'Keep useful feedback.'; view.findInput.dispatchEvent(new Event('input'));
  verify(!row(8).querySelector('.result-source'), 'Find reintroduced Advisor source controls.');
  view.findInput.value = 'reason="rule_violation"'; view.findInput.dispatchEvent(new Event('input'));
  verify(row(11).querySelector<HTMLDetailsElement>('.result-source')?.open, 'Find did not reveal the matching rule Source message.');
  view.update({ ...runtime, revision: 2, messages: runtime.messages.map(message => message.id === 'notice-11' ? { ...message, details: { refreshed: true } } : message) }, runtime.id);
  verify(row(11).querySelector<HTMLDetailsElement>('.result-source')?.open, 'An update collapsed the rule source opened by Find.');
  view.findInput.value = ''; view.findInput.dispatchEvent(new Event('input'));
  store.restore(messages);
  view.update({ ...runtime, revision: 3, messages: structuredClone([...store.messages.values()]) }, runtime.id);
  verify(!view.content.querySelector('[data-message-id="history-2"]') && view.content.querySelector('[data-message-id="history-9"]')?.textContent?.includes('Visible extension status'), 'Restored history lost custom-message visibility.');
  for (const index of [5, 10, 12, 13]) verify(!view.content.querySelector(`[data-message-id="history-${index}"]`), 'Restored task/shell completion leaked into the transcript.');
  verify(view.content.querySelectorAll('[data-message-id="history-18"] .background-result').length === 1 && view.content.querySelector('[data-message-id="history-18"] .background-result')?.textContent?.includes('Useful calculation result'), 'Restored mixed delivery lost its visible Eval result.');
  verify(!view.content.querySelector('[data-message-id="history-8"] .result-source'), 'Restored Advisor source controls leaked.');
  verify(!view.content.querySelector('[data-message-id="history-15"]'), 'Restored incoming IRC delivery leaked into the transcript.');
  return ['Engine notice provenance, hidden task/shell completions in live/restored history, mixed Eval results, literal direct execution, preserved assistant/user content, Advisor notes, and Find disclosure navigation.'];
}

async function checkAdvisorDisclosure(view: Conversation): Promise<string> {
  const store = new MessageStore(() => {}, () => {});
  const notes = [
    { note: 'Check the **cleanup path**.', severity: 'concern' },
    { note: 'Keep `x < y` readable.', severity: 'blocker' },
  ];
  const review = () => ({ role: 'custom', customType: 'advisor', display: true, content: 'INTERNAL_REVIEW_WRAPPER\n<advisory severity="concern">Check the **cleanup path**.</advisory>\n<advisory severity="blocker">Keep `x &lt; y` readable.</advisory>', details: { notes: [...notes] } });
  const publish = (): void => view.update({ ...source('advisor-disclosure'), messages: structuredClone([...store.messages.values()]) }, 'advisor-disclosure');
  store.consume({ type: 'message_end', messageId: 'review', message: review() }); publish(); await frame();
  const group = view.content.querySelector<HTMLDetailsElement>('.advisor-group'), summary = group?.querySelector('summary');
  const first = group?.querySelector<HTMLElement>('.advisor-notice .result-prose');
  if (!group || !summary || !first) throw new Error('Missing Advisor disclosure.');
  verify(!group.open && !first.checkVisibility() && group.getBoundingClientRect().height <= 32, 'Advisor feedback did not start as one compact collapsed row.');
  verify(group.querySelectorAll('.advisor-notice').length === 2 && !group.textContent?.includes('INTERNAL_REVIEW_WRAPPER'), 'Advisor XML/metadata duplicated notes or leaked its model-facing wrapper.');
  summary.click(); await frame();
  verify(first.checkVisibility() && group.querySelector('.notice-blocker code')?.textContent === 'x < y', 'Expanded Advisor feedback lost its note content or severity.');
  summary.focus();
  store.consume({ type: 'message_end', messageId: 'review', message: { ...review(), details: { notes: [...notes], refreshed: true } } }); publish(); await frame();
  verify(view.content.querySelector('.advisor-group') === group && group.open && document.activeElement === summary, 'Updating a review replaced its disclosure, closed it, or lost keyboard focus.');
  summary.click();
  notes.push({ note: 'A later review note remains searchable.', severity: 'nit' });
  store.consume({ type: 'message_end', messageId: 'review', message: review() }); publish(); await frame();
  verify(!group.open && group.querySelectorAll('.advisor-notice').length === 3, 'An added note reopened the closed disclosure or lost earlier feedback.');
  view.showFind(); view.findInput.value = 'later review note'; view.findInput.dispatchEvent(new Event('input')); await frame();
  verify(group.open && group.querySelector('.advisor-notes')?.checkVisibility(), 'Find did not reveal matching collapsed Advisor feedback.');
  view.findInput.value = ''; view.findInput.dispatchEvent(new Event('input'));
  store.restore([review()]);
  view.update({ ...source('advisor-restored'), messages: structuredClone([...store.messages.values()]) }, 'advisor-restored'); await frame();
  const restored = view.content.querySelector<HTMLDetailsElement>('.advisor-group');
  verify(restored && !restored.open && restored.querySelectorAll('.advisor-notice').length === 3, 'Restored review history lost notes or started expanded.');
  return 'Advisor batches stay compact by default, retain distinct notes and severity, preserve disclosure/focus through updates, and expand for Find without leaking raw source.';
}

function checkTodoActivity(view: Conversation): string {
  const store = new MessageStore(() => {}, () => {});
  const todo = { role: 'assistant', content: [{ type: 'toolCall', id: 'todo-only-tool', name: 'todo', arguments: { op: 'done' } }] };
  store.consume({ type: 'message_end', messageId: 'todo-only', message: todo });
  let runtime = { ...source('todo-activity'), messages: structuredClone([...store.messages.values()]), tools: structuredClone([...store.tools.values()]) };
  view.update(runtime, runtime.id);
  verify(!view.content.querySelector('.tool,.activity-group,.message:not([hidden])'), 'Todo-only bookkeeping created visible transcript activity.');

  const mixed = { role: 'assistant', content: [{ type: 'toolCall', id: 'todo-mixed-tool', name: 'set_todos', arguments: {} }, { type: 'toolCall', id: 'read-tool', name: 'read', arguments: { path: 'file.ts' } }] };
  const prose = { role: 'assistant', content: 'Todo is ordinary message content here.' };
  const orphan = { role: 'toolResult', toolCallId: 'todo-orphan-tool', toolName: 'todo', content: [{ type: 'text', text: 'Bookkeeping output' }] };
  store.consume({ type: 'message_end', messageId: 'mixed', message: mixed });
  store.consume({ type: 'message_end', messageId: 'prose', message: prose });
  store.consume({ type: 'message_end', messageId: 'orphan', message: orphan });
  runtime = { ...runtime, revision: 2, messages: structuredClone([...store.messages.values()]), tools: structuredClone([...store.tools.values()]) };
  view.update(runtime, runtime.id);
  verify(view.content.querySelectorAll('.tool').length === 1 && !!view.content.querySelector('[data-tool-id="read-tool"]'), 'Todo filtering hid a real tool or leaked mixed/orphan bookkeeping.');
  verify(view.content.querySelector('.activity-label')?.getAttribute('aria-label') === 'Activity · 1 action', 'Hidden Todo tools inflated the activity count.');
  verify(view.content.querySelector('[data-message-id="prose"]')?.textContent?.includes(prose.content), 'Todo filtering altered ordinary assistant prose.');
  store.restore([todo, mixed, prose, orphan]);
  view.update({ ...runtime, revision: 3, messages: structuredClone([...store.messages.values()]), tools: structuredClone([...store.tools.values()]) }, runtime.id);
  verify(view.content.querySelectorAll('.tool').length === 1 && !view.content.querySelector('[data-tool-id^="todo-"]'), 'Restored history leaked Todo tool activity.');
  return 'Todo-only, mixed, and orphan activity stays hidden without altering real tools or ordinary prose.';
}

function checkActivityPresentation(view: Conversation): string {
  const observedTools = ['read', 'bash', 'edit', 'ask', 'eval', 'glob', 'grep', 'task', 'wait', 'web_search', 'write', 'learn', 'manage_skill'];
  const glyphs = observedTools.map(name => toolIcon(name).innerHTML);
  const fallback = toolIcon('unknown-custom-tool').innerHTML;
  verify(new Set(glyphs).size === observedTools.length && glyphs.every(glyph => glyph !== fallback), 'Observed native tools lost their distinct tool glyphs.');
  const store = new MessageStore(() => {}, () => {});
  store.consume({ type: 'tool_execution_start', toolCallId: 'eval', toolName: 'eval', args: { i: 'Inspecting renderer state' } });
  let runtime = { ...source('activity-preview'), messages: structuredClone([...store.messages.values()]), tools: structuredClone([...store.tools.values()]) };
  view.update(runtime, runtime.id);
  const evalNode = view.content.querySelector<HTMLDetailsElement>('[data-tool-id="eval"]');
  const orphanGroup = evalNode?.closest<HTMLDetailsElement>('.activity-group');
  verify(orphanGroup && !orphanGroup.open && !view.content.querySelector(':scope > .tool'), 'An orphan Eval tool leaked outside collapsed Activity.');
  if (!orphanGroup || !evalNode) throw new Error('Missing Eval activity.');
  orphanGroup.open = true; evalNode.open = true;
  const owner = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Keep the explanation readable.' }, { type: 'text', text: 'I am checking the project.' },
    { type: 'toolCall', id: 'ask', name: 'ask', arguments: {} },
    { type: 'toolCall', id: 'eval', name: 'eval', arguments: { i: 'Inspecting renderer state' } },
    { type: 'toolCall', id: 'bash', name: 'bash', arguments: { command: 'npm run typecheck && npm test' } },
  ] };
  store.consume({ type: 'message_end', messageId: 'owner', message: owner });
  store.consume({ type: 'tool_execution_end', toolCallId: 'ask', toolName: 'ask', result: { content: [{ type: 'text', text: 'Choice accepted' }] } });
  store.consume({ type: 'tool_execution_end', toolCallId: 'eval', toolName: 'eval', isError: true, result: { content: [{ type: 'text', text: 'Evaluation failed' }] } });
  store.consume({ type: 'tool_execution_start', toolCallId: 'bash', toolName: 'bash', args: { command: 'npm run typecheck && npm test' } });
  runtime = { ...runtime, revision: 2, messages: structuredClone([...store.messages.values()]), tools: structuredClone([...store.tools.values()]) };
  view.update(runtime, runtime.id);
  const group = view.content.querySelector<HTMLDetailsElement>('.activity-group');
  verify(group && view.content.querySelectorAll('.activity-group').length === 1 && group.open && evalNode.open && evalNode.isConnected, 'Resolving tool ownership lost or duplicated its Activity disclosure.');
  verify(!view.content.querySelector('.message .tool,:scope > .tool') && view.content.querySelector('[data-message-id="owner"]')?.textContent?.includes('I am checking the project.'), 'Tools escaped Activity or hid assistant prose/reasoning.');
  verify(group?.querySelector('.activity-current')?.textContent === 'Bash npm run typecheck && npm test' && group.querySelector('.activity-current.work-shimmer') && !group.querySelector('.activity-state') && group.querySelector('.activity-summary')?.getAttribute('aria-description')?.startsWith('Running'), 'Activity lost its current running command/status or retained a right-hand spinner.');
  store.consume({ type: 'tool_execution_end', toolCallId: 'bash', toolName: 'bash', result: { content: [{ type: 'text', text: 'Checks passed' }] } });
  view.update({ ...runtime, revision: 3, tools: structuredClone([...store.tools.values()]) }, runtime.id);
  verify(!group?.querySelector<HTMLElement>('.activity-current')?.hidden && group?.querySelector('.activity-current')?.textContent === 'Bash npm run typecheck && npm test' && !group.querySelector('.activity-current.work-shimmer') && group.querySelector('.activity-state.failed'), 'Finished tool work lost its latest action or kept shimmering.');
  return 'Ask/Eval and orphan tools stay in Activity; live commands shimmer and completed rounds retain a static latest action.';
}
async function checkShimmerSpeed(view: Conversation, host: HTMLElement): Promise<string> {
  const composer = document.createElement('div');
  const tasks = new TodoPanel(host, composer);
  host.append(tasks.controls, tasks.rail, composer);
  let runtime: RuntimeSnapshot = {
    ...source('shimmer-speed'), status: { kind: 'ready', activity: 'running' },
    messages: [{ id: 'shimmer-user', role: 'user', text: 'Check the project', thinking: '', error: null, isStreaming: false, toolIDs: [] }],
    todoPhases: [{ name: 'Checks', tasks: [{ content: 'Inspect the cleanup path and verify the final result', status: 'in_progress' }] }],
  };
  const measure = async (selector: string, root: ParentNode): Promise<{ speed: number; width: number }> => {
    await frame();
    const node = root.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(`Missing shimmer surface ${selector}.`);
    const animation = node.getAnimations().find(value => value instanceof CSSAnimation && value.animationName === 'work-shimmer');
    if (!animation) throw new Error(`No moving shimmer on ${selector}.`);
    animation.currentTime = 100;
    const position = (): number => {
      const style = getComputedStyle(node);
      const distance = node.getBoundingClientRect().width + parseFloat(style.getPropertyValue('--shimmer-spread')) * 2 + 2;
      return -distance * parseFloat(style.backgroundPositionX) / 100;
    };
    const before = position(), start = Number(animation.currentTime);
    await new Promise<void>(resolve => window.setTimeout(resolve, 180));
    const traveled = position() - before, elapsed = Number(animation.currentTime) - start;
    verify(traveled > 0 && elapsed > 0, `Shimmer on ${selector} did not move left to right.`);
    return { speed: traveled * 1000 / elapsed, width: node.getBoundingClientRect().width };
  };
  try {
    view.update(runtime, runtime.id); tasks.update(runtime, runtime.id);
    const thinking = await measure('.work-shimmer', view.content);
    const task = await measure('.todo-content.work-shimmer', tasks.node);
    runtime = { ...runtime, revision: 2, tools: [{ id: 'shimmer-bash', name: 'bash', target: 'pwd', detail: '', output: '', state: 'running', startedAt: Date.now(), endedAt: null }] };
    view.update(runtime, runtime.id);
    const short = await measure('.activity-current.work-shimmer', view.content);
    runtime = { ...runtime, revision: 3, tools: runtime.tools.map(tool => ({ ...tool, target: 'npm test && npx tsc --noEmit && npm run lint && npm run build' })) };
    view.update(runtime, runtime.id);
    const long = await measure('.activity-current.work-shimmer', view.content);
    verify(long.width > short.width * 2, 'Shimmer comparison did not exercise different label widths.');
    view.node.style.width = '300px';
    const narrow = await measure('.activity-current.work-shimmer', view.content);
    verify(narrow.width < long.width && (view.content.querySelector<HTMLElement>('.activity-current')?.scrollWidth ?? 0) > narrow.width + 1, 'Narrow shimmer did not exercise a clipped command.');
    const speeds = [thinking.speed, task.speed, short.speed, long.speed, narrow.speed];
    verify(speeds.every(speed => Math.abs(speed - thinking.speed) < 1), `Shimmer speed differed across labels or resizing: ${speeds.join(', ')}.`);
    runtime = { ...runtime, revision: 4, tools: runtime.tools.map(tool => ({ ...tool, state: 'succeeded', endedAt: Date.now() })) };
    view.update(runtime, runtime.id);
    verify(!view.content.querySelector('.activity-current.work-shimmer,.activity-state'), 'Successful Activity retained motion or a status slot.');
    tasks.update({ ...runtime, todoPhases: [{ name: 'Checks', tasks: [{ content: 'Inspect the cleanup path and verify the final result', status: 'completed' }] }] }, runtime.id);
    verify(!tasks.node.querySelector('.work-shimmer'), 'Completed task kept shimmering.');
    return 'Measured left-to-right shimmer speed matches across Thinking, Tasks, short/long commands, and resized/truncated Activity; finished work stays static.';
  } finally {
    view.node.style.removeProperty('width');
    tasks.dispose(); tasks.controls.remove(); tasks.rail.remove(); composer.remove();
  }
}

async function checkWorkFeedback(view: Conversation): Promise<string> {
  const startedAt = Date.now() - 1000;
  let runtime: RuntimeSnapshot = { ...source('work-feedback'), status: { kind: 'ready', activity: 'running' }, messages: [{ id: 'work-user', role: 'user', text: 'Check the project', thinking: '', error: null, isStreaming: false, toolIDs: [] }], workPeriods: [{ id: 'work-1', startedAt, endedAt: null, messageID: 'work-user' }] };
  view.update(runtime, runtime.id);
  const duration = view.content.querySelector<HTMLElement>('.work-duration');
  if (!duration) throw new Error('Missing immediate work duration.');
  verify(duration.textContent?.startsWith('Working for ') && view.content.querySelector('.work-thinking')?.textContent === 'Thinking', 'Sending a message left an empty waiting state.');
  verify(getComputedStyle(duration).animationName === 'none' && !!view.content.querySelector('.work-thinking .work-shimmer'), 'The duration shimmered instead of the current activity.');
  verify(view.content.querySelector('[data-message-id="work-user"]')?.nextElementSibling?.classList.contains('work-period') && !!view.content.querySelector('.work-divider'), 'Work feedback was not anchored below the user message with a divider.');
  const before = Number(duration.textContent?.match(/\d+/)?.[0]);
  const parent = view.node.parentElement; if (!parent) throw new Error('Missing work-feedback host.');
  view.node.remove(); view.activate(); parent.append(view.node); view.update(runtime, runtime.id);
  const ticking = Promise.withResolvers<void>(); window.setTimeout(ticking.resolve, 1150); await ticking.promise;
  verify(Number(duration.textContent?.match(/\d+/)?.[0]) > before, 'Elapsed working time did not count up.');
  runtime = { ...runtime, revision: 2, messages: [...runtime.messages, { id: 'work-reply', role: 'assistant', text: '', thinking: 'Inspecting the workspace before answering.', error: null, isStreaming: true, toolIDs: [] }] };
  view.update(runtime, runtime.id);
  const reasoning = view.content.querySelector<HTMLElement>('[data-message-id="work-reply"] .reasoning');
  verify(!view.content.querySelector('.work-thinking') && reasoning && !reasoning.hidden && reasoning.textContent?.includes('Inspecting the workspace'), 'Real streamed reasoning retained a duplicate Thinking placeholder.');
  const endedAt = Date.now();
  runtime = { ...runtime, revision: 3, status: { kind: 'ready', activity: 'idle' }, messages: runtime.messages.map(message => message.id === 'work-reply' ? { ...message, text: 'The project checks are complete.', isStreaming: false } : message), workPeriods: [{ id: 'work-1', startedAt, endedAt, messageID: 'work-user' }] };
  view.update(runtime, runtime.id);
  const finished = duration.textContent;
  verify(finished?.startsWith('Worked for ') && !view.content.querySelector('.work-thinking'), 'Finished work still appeared active.');
  const frozen = Promise.withResolvers<void>(); window.setTimeout(frozen.resolve, 1150); await frozen.promise;
  verify(duration.textContent === finished, 'Completed elapsed time kept changing.');
  runtime = { ...runtime, revision: 4, status: { kind: 'ready', activity: 'running' }, workPeriods: [{ id: 'work-1', startedAt, endedAt: null, messageID: 'work-user' }], messages: [...runtime.messages, { id: 'work-advisor', role: 'custom', customType: 'advisor', text: '<advisory severity="concern">Check the cleanup path.</advisory>', thinking: '', error: null, isStreaming: false, toolIDs: [] }, { id: 'work-continuation', role: 'assistant', text: '', thinking: 'Checking the cleanup path.', error: null, isStreaming: true, toolIDs: [] }] };
  view.update(runtime, runtime.id);
  verify(view.content.querySelectorAll('.work-period').length === 1 && view.content.querySelector('.work-duration') === duration && duration.textContent?.startsWith('Working for '), 'Advisor continuation created a second work section instead of resuming the existing clock.');
  const rows = Array.from(view.content.children);
  const advisorIndex = rows.findIndex(node => node.getAttribute('data-message-id') === 'work-advisor');
  verify(advisorIndex > rows.findIndex(node => node.getAttribute('data-message-id') === 'work-reply') && rows[advisorIndex + 1]?.getAttribute('data-message-id') === 'work-continuation' && !view.content.querySelector('.response-actions,.work-thinking'), 'Advisor follow-up did not append directly to the stream or retained completed response controls.');
  runtime = { ...runtime, revision: 5, status: { kind: 'ready', activity: 'idle' }, workPeriods: [{ id: 'work-1', startedAt, endedAt: Date.now(), messageID: 'work-user' }], messages: runtime.messages.map(message => message.id === 'work-continuation' ? { ...message, text: 'The cleanup path is verified.', isStreaming: false } : message) };
  view.update(runtime, runtime.id);
  verify(view.content.querySelectorAll('.work-period').length === 1 && duration.textContent?.startsWith('Worked for ') && view.content.querySelectorAll('.response-actions').length === 1 && view.content.lastElementChild?.getAttribute('data-response-id') === 'work-continuation', 'Reviewed completion retained duplicate work or response controls.');
  return 'Immediate Thinking, ticking/frozen elapsed time, and late Advisor continuation appended under the original clock with one final response action.';
}

function checkResponseCopy(view: Conversation): string {
  const message = (id: string, role: string, text: string): ChatMessage => ({ id, role, text, thinking: '', error: null, isStreaming: false, toolIDs: [] });
  const copies = (): NodeListOf<Element> => view.node.querySelectorAll('.copy-message,.code-copy,.tool-copy,button[aria-label="Copy message"],button[aria-label="Copy response"]');
  const user = message('copy-user', 'user', 'Inspect the project');
  const progress = { ...message('copy-progress', 'assistant', 'I am checking the files.\n\n```ts\nconst pending = true;\n```'), toolIDs: ['copy-read'] };
  const answer = message('copy-answer', 'assistant', 'The project is ready.');
  const advisor = { ...message('copy-advisor', 'custom', 'A review note after the answer.'), customType: 'advisor' };
  const period = { id: 'copy-work', startedAt: Date.now(), endedAt: null, messageID: user.id };
  let runtime: RuntimeSnapshot = { ...source('response-copy'), messages: [user, progress], tools: [{ id: 'copy-read', name: 'read', target: 'project.ts', detail: 'path: project.ts', output: 'Project source', state: 'succeeded', startedAt: 1, endedAt: 2 }], queuedFollowUps: ['Check the next file'], status: { kind: 'ready', activity: 'running' }, workPeriods: [period] };
  view.update(runtime, runtime.id);
  verify(copies().length === 0, 'Intermediate progress or queued messages exposed copy controls.');
  runtime = { ...runtime, revision: 2, messages: [user, progress, { ...answer, isStreaming: true }] };
  view.update(runtime, runtime.id);
  verify(!view.content.querySelector('.response-actions'), 'Streaming answer exposed a copy control.');
  runtime = { ...runtime, revision: 3, status: { kind: 'ready', activity: 'background' }, messages: [user, progress, answer, advisor] };
  view.update(runtime, runtime.id);
  verify(!view.content.querySelector('.response-actions'), 'Background work exposed copy before completion.');
  runtime = { ...runtime, revision: 4, status: { kind: 'ready', activity: 'idle' }, workPeriods: [{ ...period, endedAt: Date.now() }] };
  view.update(runtime, runtime.id);
  const footer = view.content.querySelector<HTMLElement>('.response-actions');
  verify(footer?.dataset.responseId === answer.id && view.content.lastElementChild === footer && footer.querySelector('button[aria-label="Copy response"]'), 'Completed response did not expose one copy below trailing review content.');
  verify(copies().length === 1, 'Completed response retained extra per-message, queued, or per-block copy controls.');
  const followup = message('copy-followup', 'user', 'Now check the next file');
  runtime = { ...runtime, revision: 5, messages: [...runtime.messages, followup, message('copy-next-progress', 'assistant', 'Checking the next file.')], status: { kind: 'ready', activity: 'running' }, workPeriods: [...runtime.workPeriods ?? [], { ...period, id: 'copy-next-work', messageID: followup.id }] };
  view.update(runtime, runtime.id);
  verify(footer?.nextElementSibling?.getAttribute('data-message-id') === followup.id && view.content.querySelectorAll('.response-actions').length === 1, 'A new run moved the prior response copy or exposed an intermediate copy.');
  const steered = message('copy-steer', 'user', 'Also inspect the config');
  runtime = { ...runtime, revision: 6, messages: [...runtime.messages, steered] };
  view.update(runtime, runtime.id);
  verify(view.content.querySelectorAll('.response-actions').length === 1, 'A steer incorrectly marked the active response complete.');
  return 'One copy control below each completed answer, no interim/code/tool copies, and stable placement through review notes, new runs, and steers.';
}

async function checkComposerSizing(view: Conversation, host: HTMLElement): Promise<string> {
  const composer = new Composer(text => { throw new Error(text); }, async () => null, () => view.followLatest());
  host.append(composer.node);
  try {
    const runtime = source('composer-sizing'); view.update(runtime, runtime.id); await complete(view); await frame();
    const type = (text: string): void => { composer.editor.value = text; composer.editor.dispatchEvent(new Event('input', { bubbles: true })); };
    type('A long draft line that wraps naturally.\n'.repeat(30)); await frame();
    view.scroll.scrollTop = view.scroll.scrollHeight; view.scroll.dispatchEvent(new Event('scroll')); await frame();
    const top = view.scroll.scrollTop, composerTop = composer.node.getBoundingClientRect().top;
    const tail = view.content.lastElementChild; if (!tail) throw new Error('Missing long transcript tail.');
    const tailTop = tail.getBoundingClientRect().top;
    for (let index = 0; index < 5; index++) {
      type(`${composer.editor.value}x`);
      verify(view.scroll.scrollTop === top && tail.getBoundingClientRect().top === tailTop && composer.node.getBoundingClientRect().top === composerTop, 'Typing at the height cap temporarily shifted the transcript.');
      await frame();
      verify(view.scroll.scrollTop === top && tail.getBoundingClientRect().top === tailTop, 'Typing at the height cap bounced the transcript across frames.');
    }
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); view.scroll.scrollTop -= 200; view.scroll.dispatchEvent(new Event('scroll'));
    const manualTop = view.scroll.scrollTop; type(`${composer.editor.value}more`); await frame();
    verify(view.scroll.scrollTop === manualTop, 'Typing pulled a manually scrolled transcript back to the bottom.');
    type('Short draft'); await frame();
    verify(composer.editor.scrollHeight <= composer.editor.clientHeight && composer.node.getBoundingClientRect().top > composerTop, 'Deleting a long draft did not shrink the composer.');
    return 'Tall typing preserves transcript position synchronously and across frames, respects manual scrolling, and shrinks after deletion.';
  } finally { composer.node.remove(); }
}

async function checkSubmissionScroll(view: Conversation, host: HTMLElement): Promise<string> {
  const bridge = window.pi, errors: string[] = [];
  let runtime = source('submission-scroll');
  const thread = { id: runtime.id, projectPath: '/scroll', displayTitle: 'Scroll', ompSessionDirectory: '/scroll/session', createdAt: '', updatedAt: '', draft: '', wasRunning: false };
  const composer = new Composer(text => errors.push(text), async () => null, () => view.followLatest());
  const publish = (): void => { view.update(runtime, runtime.id); composer.update(thread, runtime); };
  const type = (text: string): void => { composer.editor.value = text; composer.editor.dispatchEvent(new Event('input', { bubbles: true })); };
  const away = async (): Promise<number> => {
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    view.scroll.scrollTop -= 300; view.scroll.dispatchEvent(new Event('scroll')); await frame();
    return view.scroll.scrollTop;
  };
  const atBottom = (): boolean => view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop < 2;
  let admission = Promise.withResolvers<boolean>(), promptID = 0;
  window.pi = { ...bridge, async request(request) {
    if (request.kind === 'draft') return { ok: true, value: null };
    if (request.kind !== 'prompt') return bridge.request(request);
    const message: ChatMessage = { id: `submitted-${++promptID}`, role: 'user', text: request.message, thinking: '', toolIDs: [], error: null, isStreaming: false };
    runtime = { ...runtime, revision: runtime.revision + 1, status: { kind: 'ready', activity: 'running' }, messages: [...runtime.messages, message] };
    publish();
    const accepted = await admission.promise;
    if (!accepted) {
      runtime = { ...runtime, revision: runtime.revision + 1, status: { kind: 'ready', activity: 'idle' }, messages: runtime.messages.filter(row => row.id !== message.id) }; publish();
    }
    return { ok: true, value: accepted };
  } };
  host.append(composer.node);
  try {
    publish(); await complete(view); await frame();
    const top = await away();
    runtime = { ...runtime, revision: 2, messages: [...runtime.messages, { id: 'passive', role: 'assistant', text: 'A passive update must preserve the reading position.', thinking: '', toolIDs: [], error: null, isStreaming: false }] };
    publish(); await frame(); verify(view.scroll.scrollTop === top, 'Passive updates pulled the transcript away from the reading position.');
    type('Follow-up after completion'); const pending = composer.submit(false); await frame();
    const row = view.content.querySelector('[data-message-id="submitted-1"]')?.getBoundingClientRect(), viewport = view.scroll.getBoundingClientRect();
    verify(atBottom() && row && row.top >= viewport.top && row.bottom <= viewport.bottom, 'Submitting after completion left the new user bubble outside the viewport.');
    admission.resolve(true); await pending;
    runtime = { ...runtime, revision: 3, status: { kind: 'ready', activity: 'idle' } }; publish(); await frame();
    await away(); type('A multiline follow-up.\n'.repeat(20)); await frame();
    admission = Promise.withResolvers<boolean>();
    const rejected = composer.submit(false); await frame(); verify(atBottom(), 'Sending a tall draft did not resume bottom-follow.');
    admission.resolve(false); await rejected; await frame();
    verify(errors.length === 1 && composer.editor.value.startsWith('A multiline follow-up.') && atBottom(), 'Rejected admission lost the draft or bottom-follow during composer resizing.');
    const manual = await away(); type('Keep reading here'); await frame();
    verify(view.scroll.scrollTop === manual, 'Typing without submitting overrode manual scrolling.');
    return 'Explicit submissions reveal the next user bubble after completion and resume following; passive updates and typing preserve manual scrolling, including rejected tall drafts.';
  } finally { admission.resolve(false); window.pi = bridge; composer.node.remove(); }
}

async function checkComposerImagePreview(host: HTMLElement): Promise<string> {
  const composer = new Composer(text => { throw new Error(text); }, async () => null, () => { throw new Error('Unexpected submission from image-preview check.'); });
  const runtime = source('composer-preview');
  const thread = { id: runtime.id, projectPath: '/preview', displayTitle: 'Preview', ompSessionDirectory: '/preview/session', createdAt: '', updatedAt: '', draft: '', wasRunning: false };
  composer.update(thread, runtime); host.append(composer.node);
  const dialog = (): HTMLDialogElement | null => document.querySelector('.composer-image-preview');
  const thumbnail = (): HTMLButtonElement => {
    const node = composer.node.querySelector<HTMLButtonElement>('.composer-image-open');
    if (!node) throw new Error('Missing composer image thumbnail.');
    return node;
  };
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Missing image canvas.');
  context.fillStyle = '#327ba8'; context.fillRect(0, 0, canvas.width, canvas.height);
  const data = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
  if (!data) throw new Error('Could not encode preview image.');
  const file = new File([data], 'Preview landscape.png', { type: 'image/png' });
  try {
    const clipboard = new DataTransfer(); clipboard.items.add(file);
    composer.editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    const deadline = performance.now() + 3000;
    while (!composer.node.querySelector('.composer-image-open')) { verify(performance.now() < deadline, 'Pasted image did not become an attachment.'); await frame(); }
    const trigger = thumbnail(); trigger.focus(); trigger.click(); await frame();
    const preview = dialog()?.querySelector<HTMLImageElement>('.modal-body img');
    if (!preview) throw new Error('Image click did not open its preview.');
    await preview.decode();
    const bounds = preview.getBoundingClientRect();
    verify(dialog()?.open && preview.naturalWidth === 1200 && preview.naturalHeight === 800 && preview.src === trigger.querySelector('img')?.src && preview.alt === file.name, 'Preview lost original image content or its accessible name.');
    verify(bounds.width > 72 && bounds.height > 60 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, 'Preview was not enlarged and fitted to the viewport.');
    const close = dialog()?.querySelector<HTMLButtonElement>('button');
    if (!close) throw new Error('Missing image preview close control.');
    verify(document.activeElement === close, 'Preview did not move focus to Close.');
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    verify(document.activeElement === close, 'Preview Tab escaped its focus trap.');
    close.click();
    verify(!dialog() && composer.node.querySelectorAll('.composer-image').length === 1 && document.activeElement === trigger, 'Closing preview changed the draft or lost thumbnail focus.');
    trigger.click(); dialog()?.dispatchEvent(new Event('cancel', { cancelable: true }));
    verify(!dialog() && document.activeElement === trigger, 'Escape cancellation did not dismiss preview and restore focus.');
    trigger.click(); dialog()?.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0, bubbles: true }));
    verify(!dialog() && composer.node.querySelectorAll('.composer-image').length === 1, 'Backdrop dismissal removed the image or left its preview open.');
    trigger.click(); composer.update({ ...thread, id: 'another-preview' }, { ...runtime, id: 'another-preview' });
    verify(!dialog() && !composer.node.querySelector('.composer-image'), 'Switching threads leaked the attachment preview.');
    composer.update(thread, runtime); thumbnail().click();
    composer.node.querySelector<HTMLButtonElement>('.image-remove')?.click();
    verify(!dialog() && !composer.node.querySelector('.composer-image'), 'Removing the previewed attachment left a modal behind.');
    return 'Pasted composer image opens at full resolution in a fitted modal; focus, Close/Escape/backdrop, thread isolation, removal, and draft retention work.';
  } finally { dialog()?.dispatchEvent(new Event('cancel', { cancelable: true })); composer.node.remove(); }
}

export async function checkLoadingBehavior(): Promise<string[]> {
  const outcomes: string[] = [];
  const host = document.createElement('main'); host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--canvas);z-index:100'; document.body.append(host);
  const view = new Conversation(); host.append(view.node);
  try {
    outcomes.push(...checkNotices(view));
    outcomes.push(await checkAdvisorDisclosure(view));
    outcomes.push(checkTodoActivity(view));
    outcomes.push(checkActivityPresentation(view));
    outcomes.push(await checkShimmerSpeed(view, host));
    outcomes.push(await checkWorkFeedback(view));
    outcomes.push(checkResponseCopy(view));
    outcomes.push(await checkComposerSizing(view, host));
    outcomes.push(await checkSubmissionScroll(view, host));
    outcomes.push(await checkComposerImagePreview(host));
    outcomes.push(await checkSidebarTransitions());
    outcomes.push(...await checkMainFrameStates());
    const history = source('loading'); view.update(history, history.id);
    verify(view.content.querySelectorAll('.message').length < history.messages.length && view.content.querySelector('[data-message-id="loading-599"]'), 'Initial render did not prioritize recent history.');
    await frame();
    verify(view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop < 2, 'Recent history did not open at bottom.');
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); view.scroll.scrollTop -= 180; view.scroll.dispatchEvent(new Event('scroll'));
    const top = view.scroll.getBoundingClientRect().top;
    const anchor = Array.from(view.content.querySelectorAll<HTMLElement>('.message')).find(node => node.getBoundingClientRect().bottom > top + 2);
    if (!anchor) throw new Error('Missing viewport anchor.');
    const before = anchor.getBoundingClientRect().top;
    await complete(view);
    verify(Math.abs(anchor.getBoundingClientRect().top - before) < 2, 'Prepending history moved the reading position.');
    verify(Array.from(view.content.querySelectorAll<HTMLElement>('.message')).every((node, index) => node.dataset.messageId === `loading-${index}`), 'Loaded history is out of order.');
    outcomes.push('Recent history first; full chronological hydration preserves the reading anchor.');

    const find = source('find'); view.update(find, find.id); view.showFind(); view.findInput.value = 'History message 0.'; view.findInput.dispatchEvent(new Event('input'));
    verify(view.content.getAttribute('aria-busy') === 'false' && view.content.querySelectorAll('.find-match').length === 1 && view.content.querySelector('[data-message-id="find-0"]'), 'Find did not include deferred history.');
    outcomes.push('Find includes messages not yet mounted.');
    view.node.remove(); view.activate(); host.append(view.node); view.update(find, find.id); await frame();
    verify(view.find.hidden && !view.findInput.value && !view.content.querySelector('.find-match'), 'Cached conversation retained Find highlighting after activation.');
    outcomes.push('Reactivating cached history clears Find controls and highlights.');

    const tools = source('tools');
    const activity: ToolActivity[] = [];
    tools.messages = tools.messages.map((message, index) => {
      if (index < 410 || index > 569) return message;
      const id = `tool-${index}`; activity.push({ id, name: 'read', target: `file-${index}.ts`, detail: '', output: `Tool result ${index}`, state: 'succeeded', startedAt: 1, endedAt: 2 });
      return { ...message, text: '', toolIDs: [id] };
    });
    const older = tools.messages[5];
    if (!older) throw new Error('Missing historical tool owner.');
    tools.messages[5] = { ...older, toolIDs: ['old-tool'] };
    tools.tools = [...activity, { id: 'old-tool', name: 'read', target: 'old.ts', detail: '', output: 'Old tool', state: 'succeeded', startedAt: 1, endedAt: 2 }];
    tools.subagents = [{ id: 'historical-agent', title: 'Historical agent', status: 'completed', detail: 'Finished', messageID: 'tools-515' }];
    view.update(tools, tools.id);
    verify(!view.content.querySelector('[data-tool-id="old-tool"]') && !view.content.querySelector('.inline-subagent'), 'Deferred history leaked unanchored tools or agents.');
    const group = view.content.querySelector<HTMLDetailsElement>('[data-tool-id="tool-550"]')?.closest<HTMLDetailsElement>('.activity-group');
    if (!group) throw new Error('Missing initial activity group.'); group.open = true;
    await complete(view);
    verify(group.isConnected && group.open, 'Activity disclosure was recreated during older-history loading.');
    verify(view.content.querySelectorAll('.tool').length === tools.tools.length && tools.tools.every(tool => view.content.querySelectorAll(`[data-tool-id="${tool.id}"]`).length === 1), 'History lost or duplicated tools.');
    verify(!view.content.querySelector('.inline-subagent'), 'Agent progress leaked into the transcript.');
    outcomes.push('Activity boundaries, disclosure state, and tool ownership survive incremental loading without inline agents.');

    const node = view.content.querySelector('[data-message-id="tools-599"]'); view.node.remove(); view.activate(); host.append(view.node); view.update(tools, tools.id); await frame();
    verify(node === view.content.querySelector('[data-message-id="tools-599"]') && view.scroll.scrollHeight - view.scroll.clientHeight - view.scroll.scrollTop < 2, 'Cached conversation did not retain its DOM and restore bottom.');
    outcomes.push('Cached conversation retains DOM and reopens at the latest message.');
    view.activate(); view.update({ ...tools, status: { kind: 'connecting' }, messages: [], tools: [] }, tools.id);
    verify(node === view.content.querySelector('[data-message-id="tools-599"]'), 'Reconnection blanked cached history while loading.');
    view.update({ ...tools, messages: [], tools: [], subagents: [] }, tools.id);
    verify(!view.content.querySelector('.message'), 'Authoritative empty history did not clear cached content.');
    view.update(tools, tools.id); await complete(view);
    outcomes.push('Cached history remains visible during reconnect and yields to authoritative empty history.');
    let streaming = { ...tools, messages: tools.messages.map((message, index) => index === 599 ? { ...message, isStreaming: true, text: `${message.text} Initialstreamword` } : message) };
    view.update(streaming, streaming.id);
    view.node.remove(); view.activate(); host.append(view.node);
    streaming = { ...streaming, messages: streaming.messages.map((message, index) => index === 599 ? { ...message, text: `${message.text} Missedwhilehidden` } : message) };
    view.update(streaming, streaming.id);
    verify(!view.content.querySelector('span.stream-word'), 'Cached activation replayed history or missed streaming words.');
    streaming = { ...streaming, messages: streaming.messages.map((message, index) => index === 599 ? { ...message, text: `${message.text} Freshwordverified` } : message) };
    view.update(streaming, streaming.id);
    verify(Array.from(view.content.querySelectorAll('span.stream-word')).some(word => word.textContent === 'Freshwordverified'), 'Fresh streaming text stopped animating after activation.');
    outcomes.push('Cached history does not replay reveal animations; fresh streaming words still animate.');
    return outcomes;
  } finally { view.dispose(); host.remove(); }
}

declare global { interface Window { checkPerformance: typeof checkLoadingBehavior } }
window.checkPerformance = checkLoadingBehavior;
