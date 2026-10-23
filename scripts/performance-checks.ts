import { Conversation } from '../src/renderer/conversation';
import type { ChatMessage, ImageContent, RetractedMessage, RuntimeSnapshot, ToolActivity } from '../src/shared/types';
import { MessageStore } from '../src/omp/MessageStore';
import { toolIcon } from '../src/renderer/icons';
import { Composer } from '../src/renderer/composer';
import { TodoPanel } from '../src/renderer/todo-panel';
import { checkSidebarTransitions } from './sidebar-checks';
import { checkMainFrameStates } from './main-frame-checks';
import { renderMarkdown } from '../src/renderer/markdown';
import { checkManualStreamingScroll } from './scroll-checks';
import { checkStreamingPresentation } from './streaming-checks';
import { checkCodeCopyReconciliation } from './code-copy-checks';

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
  verify(group.dataset.severity === 'blocker', 'Advisor summary did not reflect the highest rendered note severity.');
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
  const second = notes[1];
  if (!second || !restored) throw new Error('Missing Advisor severity transition fixture.');
  const previousLabel = restored.querySelector('.advisor-label')?.textContent;
  second.severity = 'nit';
  view.update({ ...source('advisor-restored'), revision: 2, messages: [...store.messages.values()].map(message => ({ ...message, details: { notes: [...notes] } })) }, 'advisor-restored'); await frame();
  verify(restored.dataset.severity === 'concern' && restored.querySelector('.advisor-label')?.textContent === previousLabel,
    'Changing severity without changing note count left a stale Advisor summary or changed its count.');
  view.update({ ...source('advisor-single'), messages: [{ id: 'single-review', role: 'custom', customType: 'advisor', text: '', thinking: '', error: null, isStreaming: false, toolIDs: [], details: { notes: [{ note: 'Keep this single note available.' }] } }] }, 'advisor-single'); await frame();
  const single = view.content.querySelector<HTMLDetailsElement>('.advisor-group');
  verify(single && single.checkVisibility() && !single.open && single.querySelectorAll('.advisor-notice').length === 1,
    'A single Advisor note was hidden or lost instead of remaining a compact disclosure.');
  verify(single?.dataset.severity === 'nit' && !/\d/u.test(single.querySelector('.advisor-label')?.textContent ?? ''),
    'A single Advisor note retained a numeric counter or lost the default nit severity.');
  const earlier: ChatMessage = { id: 'review-first', role: 'custom', customType: 'advisor', text: '', thinking: '', error: null, isStreaming: false, toolIDs: [], details: { notes: [{ note: 'First separate delivery.', severity: 'concern' }] } };
  const later: ChatMessage = { ...earlier, id: 'review-second', text: '<advisory severity="blocker">Second separate delivery.</advisory>', details: {} };
  const hidden: ChatMessage = { ...earlier, id: 'hidden-delivery', customType: 'async-result', details: { jobs: [{ type: 'bash' }] } };
  const publishBatch = (messages: ChatMessage[]): void => view.update({ ...source('advisor-deliveries'), messages }, 'advisor-deliveries');
  publishBatch([earlier]);
  const joined = view.content.querySelector<HTMLDetailsElement>('.advisor-group');
  const joinedSummary = joined?.querySelector('summary');
  if (!joined || !joinedSummary) throw new Error('Missing separate-delivery Advisor fixture.');
  joinedSummary.click(); joinedSummary.focus();
  publishBatch([earlier, hidden, later]); await frame();
  verify(view.content.querySelectorAll('.advisor-group').length === 1 && joined.isConnected && joined.open && document.activeElement === joinedSummary,
    'A later Advisor delivery created a second header or reset the existing disclosure/focus.');
  verify(joined.querySelectorAll('.advisor-notice').length === 2 && joined.dataset.severity === 'blocker' && joined.querySelector('.advisor-label')?.textContent === 'Advisor · 2 notes',
    'Joining metadata and XML Advisor deliveries lost notes, count, or highest severity.');
  const firstDelivery = joined.querySelector('.advisor-notice');
  const updatedLater = { ...later, text: '<advisory severity="nit">Updated second delivery.</advisory>' };
  publishBatch([earlier, hidden, updatedLater]);
  verify(joined.querySelector('.advisor-notice') === firstDelivery && joined.textContent?.includes('Updated second delivery.') && !joined.textContent?.includes('Second separate delivery.') && joined.dataset.severity === 'concern',
    'Updating a non-leading Advisor delivery left stale notes/severity or replaced unchanged prose.');
  joinedSummary.click();
  view.showFind(); view.findInput.value = 'Updated second delivery'; view.findInput.dispatchEvent(new Event('input')); await frame();
  verify(joined.open && view.content.querySelectorAll('.find-match').length === 1, 'Find did not reveal an exact note from a joined delivery.');
  view.findInput.value = ''; view.findInput.dispatchEvent(new Event('input'));
  publishBatch([earlier]);
  verify(view.content.querySelectorAll('.advisor-notice').length === 1 && joined.querySelector('.advisor-label')?.textContent === 'Advisor', 'Removing a joined delivery left its note or count behind.');
  const response: ChatMessage = { id: 'response-between', role: 'assistant', text: 'Actual conversation output.', thinking: '', error: null, isStreaming: false, toolIDs: [] };
  publishBatch([earlier, response, later]);
  verify(view.content.querySelectorAll('.advisor-group').length === 2, 'Advisor grouping moved feedback across actual conversation output.');
  view.update({ ...source('advisor-deliveries-restored'), messages: structuredClone([earlier, hidden, later]) }, 'advisor-deliveries-restored');
  verify(view.content.querySelectorAll('.advisor-group').length === 1 && view.content.querySelectorAll('.advisor-notice').length === 2 && !view.content.querySelector<HTMLDetailsElement>('.advisor-group')?.open,
    'Restored separate Advisor deliveries did not form one collapsed disclosure.');
  const history: ChatMessage[] = Array.from({ length: 65 }, (_, index) => ({ ...response, id: `advisor-history-${index}` }));
  history.splice(4, 2, earlier, later);
  view.update({ ...source('advisor-history-boundary'), messages: history }, 'advisor-history-boundary');
  verify(view.content.querySelectorAll('.advisor-notice').length === 2, 'Initial history pagination split a joined Advisor batch.');
  await complete(view);
  verify(view.content.querySelectorAll('.advisor-group').length === 1 && view.content.querySelectorAll('.advisor-notice').length === 2,
    'Incremental history loading duplicated a joined Advisor disclosure.');
  return 'Advisor deliveries join into one compact disclosure across hidden notices, preserve notes/severity/focus through updates and restoration, respect conversation boundaries, and expand exact Find matches without pagination splits.';
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
  if (!group) throw new Error('Missing owned Activity disclosure.');
  verify(group && view.content.querySelectorAll('.activity-group').length === 1 && group.open && evalNode.open && evalNode.isConnected, 'Resolving tool ownership lost or duplicated its Activity disclosure.');
  verify(!view.content.querySelector('.message .tool,:scope > .tool') && view.content.querySelector('[data-message-id="owner"]')?.textContent?.includes('I am checking the project.'), 'Tools escaped Activity or hid assistant prose/reasoning.');
  verify(group.querySelector('.activity-current.work-shimmer') && !group.querySelector('.activity-state') && group.querySelector('.activity-summary')?.getAttribute('aria-description')?.startsWith('Running'), 'Activity lost its current running status or retained a right-hand spinner.');
  store.consume({ type: 'tool_execution_end', toolCallId: 'bash', toolName: 'bash', result: { content: [{ type: 'text', text: 'Checks passed' }] } });
  view.update({ ...runtime, revision: 3, tools: structuredClone([...store.tools.values()]) }, runtime.id);
  verify(!group.querySelector<HTMLElement>('.activity-current')?.hidden && !group.querySelector('.activity-current.work-shimmer'), 'Finished tool work hid its latest action or kept shimmering.');
  verify(!group.querySelector('.activity-state') && !group.querySelector('.activity-summary')?.getAttribute('aria-description')?.includes('failed'), 'Completed activity retained a failure badge or collapsed failure announcement.');
  group.open = true; evalNode.open = true;
  verify(evalNode.querySelector<HTMLElement>('.tool-output')?.innerText.includes('Evaluation failed'), 'Quiet failure styling hid the inspectable tool output.');
  view.update({ ...runtime, revision: 4, tools: [...store.tools.values()].map<ToolActivity>(tool => tool.id === 'eval' ? { ...tool, state: 'interrupted' } : tool) }, runtime.id);
  verify(group.querySelector('.activity-summary')?.getAttribute('aria-description') === 'Interrupted' && evalNode.querySelector('summary')?.getAttribute('aria-description') === 'interrupted', 'Interrupted activity lost its accessible status.');
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
    verify(narrow.width < long.width, 'Narrow shimmer did not exercise a constrained command.');
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
  verify(view.content.querySelectorAll('.work-period').length === 1 && duration.textContent?.startsWith('Worked for ') && view.content.querySelectorAll('.response-actions').length === 1, 'Reviewed completion retained duplicate work or response controls.');
  return 'Immediate Thinking, ticking/frozen elapsed time, and late Advisor continuation appended under the original clock with one final response action.';
}

function checkResponseCopy(view: Conversation): string {
  const message = (id: string, role: string, text: string): ChatMessage => ({ id, role, text, thinking: '', error: null, isStreaming: false, toolIDs: [] });
  const copies = (): NodeListOf<Element> => view.node.querySelectorAll('.copy-message,.tool-copy,.queued button[aria-label="Copy message"],button[aria-label="Copy response"]');
  const user = message('copy-user', 'user', 'Inspect the project');
  const progress = { ...message('copy-progress', 'assistant', 'I am checking the files.\n\n```ts\nconst pending = true;\n```'), toolIDs: ['copy-read'] };
  const answer = message('copy-answer', 'assistant', 'The project is ready.');
  const advisor = { ...message('copy-advisor', 'custom', 'A review note after the answer.'), customType: 'advisor' };
  const period = { id: 'copy-work', startedAt: Date.now(), endedAt: null, messageID: user.id };
  let runtime: RuntimeSnapshot = { ...source('response-copy'), messages: [user, progress], tools: [{ id: 'copy-read', name: 'read', target: 'project.ts', detail: 'path: project.ts', output: 'Project source', state: 'succeeded', startedAt: 1, endedAt: 2 }], queuedFollowUps: [{ text: 'Check the next file', imageCount: 0, imageRef: null }], status: { kind: 'ready', activity: 'running' }, workPeriods: [period] };
  view.update(runtime, runtime.id);
  verify(copies().length === 0, 'Intermediate progress or queued messages exposed whole-response copy controls.');
  runtime = { ...runtime, revision: 2, messages: [user, progress, { ...answer, isStreaming: true }] };
  view.update(runtime, runtime.id);
  verify(!view.content.querySelector('.response-actions'), 'Streaming answer exposed a copy control.');
  runtime = { ...runtime, revision: 3, status: { kind: 'ready', activity: 'background' }, messages: [user, progress, answer, advisor] };
  view.update(runtime, runtime.id);
  verify(!view.content.querySelector('.response-actions'), 'Background work exposed copy before completion.');
  runtime = { ...runtime, revision: 4, status: { kind: 'ready', activity: 'idle' }, workPeriods: [{ ...period, endedAt: Date.now() }] };
  view.update(runtime, runtime.id);
  const footer = view.content.querySelector<HTMLElement>('.response-actions');
  verify(footer?.dataset.responseId === answer.id && footer.querySelector('button[aria-label="Copy response"]'), 'Completed answer did not expose its whole-response copy control.');
  verify(copies().length === 1, 'Completed response retained extra per-message or queued copy controls.');
  const followup = message('copy-followup', 'user', 'Now check the next file');
  runtime = { ...runtime, revision: 5, messages: [...runtime.messages, followup, message('copy-next-progress', 'assistant', 'Checking the next file.')], status: { kind: 'ready', activity: 'running' }, workPeriods: [...runtime.workPeriods ?? [], { ...period, id: 'copy-next-work', messageID: followup.id }] };
  view.update(runtime, runtime.id);
  verify(view.content.querySelectorAll('.response-actions').length === 1, 'A new run exposed an intermediate whole-response copy.');
  const steered = message('copy-steer', 'user', 'Also inspect the config');
  runtime = { ...runtime, revision: 6, messages: [...runtime.messages, steered] };
  view.update(runtime, runtime.id);
  verify(view.content.querySelectorAll('.response-actions').length === 1, 'A steer incorrectly marked the active response complete.');
  return 'One whole-response copy per completed answer, independent code-block copies, and no premature response copies during review, new runs, or steers.';
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

async function checkComposerImagePreview(view: Conversation, host: HTMLElement): Promise<string> {
  const composer = new Composer(text => { throw new Error(text); }, async () => null, () => { throw new Error('Unexpected submission from image-preview check.'); });
  const runtime = source('composer-preview');
  const thread = { id: runtime.id, projectPath: '/preview', displayTitle: 'Preview', ompSessionDirectory: '/preview/session', createdAt: '', updatedAt: '', draft: '', wasRunning: false };
  composer.update(thread, runtime); host.append(composer.node);
  const dialog = (): HTMLDialogElement | null => document.querySelector('.image-preview');
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
    verify(dialog()?.open && preview.naturalWidth === 1200 && preview.naturalHeight === 800 && preview.src === trigger.querySelector('img')?.src, 'Preview lost the original image content.');
    verify(bounds.width > 72 && bounds.height > 60 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, 'Preview was not enlarged and fitted to the viewport.');
    verify(!composer.node.innerText.includes(file.name) && !dialog()?.innerText.includes(file.name), 'Image filenames remained visible in the composer or magnifier.');
    const close = dialog()?.querySelector<HTMLButtonElement>('button');
    if (!close) throw new Error('Missing image preview close control.');
    const modalBounds = dialog()?.getBoundingClientRect(), closeBounds = close.getBoundingClientRect();
    verify(modalBounds && closeBounds.top < modalBounds.top + 24 && closeBounds.right > modalBounds.right - 24 && close.querySelector('svg') && !close.textContent?.trim(), 'Magnifier close control was not an icon at the top right.');
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
    const frameImage: ImageContent = { type: 'image', mimeType: 'image/png', data: canvas.toDataURL().split(',')[1] ?? '' };
    context.fillStyle = '#ab4938'; context.fillRect(0, 0, canvas.width, canvas.height);
    const secondImage: ImageContent = { ...frameImage, data: canvas.toDataURL().split(',')[1] ?? '' };
    const sentMessage: ChatMessage = { id: 'sent-image', role: 'user', text: '', thinking: '', toolIDs: [], error: null, isStreaming: false, images: [frameImage, secondImage] };
    const sentRuntime = { ...runtime, messages: [sentMessage] };
    view.update(sentRuntime, runtime.id);
    const sentTriggers = view.content.querySelectorAll<HTMLButtonElement>('.message-image-open');
    const sentTrigger = sentTriggers[0], secondTrigger = sentTriggers[1];
    if (!sentTrigger || !secondTrigger) throw new Error('Sent image thumbnails were not interactive.');
    sentTrigger.focus(); sentTrigger.click(); await frame();
    const sentPreview = dialog()?.querySelector<HTMLImageElement>('.modal-body img');
    if (!sentPreview) throw new Error('Sent image did not open the shared magnifier.');
    await sentPreview.decode();
    verify(sentPreview.src === `data:${frameImage.mimeType};base64,${frameImage.data}` && sentPreview.naturalWidth === 1200 && sentPreview.naturalHeight === 800,
      'Sent image magnifier used a resized thumbnail instead of full-resolution bytes.');
    const openDialog = dialog();
    view.update({ ...sentRuntime, revision: 2, messages: [{ ...sentMessage, text: 'Sent image caption.' }] }, runtime.id);
    verify(dialog() === openDialog && dialog()?.open, 'A passive message update closed the sent image magnifier.');
    dialog()?.dispatchEvent(new Event('cancel', { cancelable: true }));
    verify(!dialog() && document.activeElement === sentTrigger, 'Closing a sent image magnifier lost thumbnail focus.');
    secondTrigger.focus(); secondTrigger.click(); await frame();
    verify(dialog()?.open && dialog()?.querySelector<HTMLImageElement>('.modal-body img')?.src === `data:${secondImage.mimeType};base64,${secondImage.data}`, 'A second sent attachment opened the wrong image.');
    view.node.remove(); await frame();
    verify(!dialog(), 'Switching away from a cached conversation left its image magnifier open.');
    host.prepend(view.node); sentTrigger.focus(); sentTrigger.click();
    view.update({ ...sentRuntime, revision: 3, messages: [{ ...sentMessage, images: [] }] }, runtime.id);
    verify(!dialog() && !view.content.querySelector('.message-image-open'), 'Removing a sent image left a stale magnifier or thumbnail.');
    return 'Composer filenames stay hidden; draft and sent images share a full-resolution, top-right icon-close magnifier with keyboard focus, Escape/backdrop dismissal, passive-update stability, and thread/removal cleanup.';
  } finally { dialog()?.dispatchEvent(new Event('cancel', { cancelable: true })); composer.node.remove(); }
}

async function checkComposerDrop(host: HTMLElement): Promise<string> {
  const bridge = window.pi, errors: string[] = [];
  window.pi = { ...bridge, pathsFromDrop: files => files.map(file => `/drop/${file.name}`) };
  const composer = new Composer(text => errors.push(text), async () => null, () => { throw new Error('Drop submitted a message.'); });
  const runtime = source('composer-drop');
  const thread = { id: runtime.id, projectPath: '/drop', displayTitle: 'Drop', ompSessionDirectory: '/drop/session', createdAt: '', updatedAt: '', draft: 'Existing draft', wasRunning: false };
  composer.update(thread, runtime); host.append(composer.node);
  const dispose = composer.bindDropTarget(host);
  const overlay = host.querySelector<HTMLElement>('.composer-drop-overlay');
  if (!overlay) throw new Error('Missing drop overlay.');
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
  if (!blob) throw new Error('Could not encode drop fixture.');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  transfer.items.add(new File(['PDF fixture'], 'report with spaces.pdf', { type: 'application/pdf' }));
  const drag = (node: HTMLElement, type: string): void => { node.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true })); };
  try {
    drag(host, 'dragenter'); drag(composer.editor, 'dragenter'); drag(composer.editor, 'dragleave');
    verify(!overlay.hidden, 'Moving between nested drop targets dismissed the overlay.');
    drag(host, 'dragleave'); verify(overlay.hidden, 'Leaving the chat left the drop overlay stuck.');
    drag(host, 'dragenter'); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    verify(overlay.hidden, 'Escape did not dismiss the drag overlay.');
    drag(host, 'dragenter'); drag(host, 'drop'); await frame();
    const deadline = performance.now() + 3000;
    while (!composer.node.querySelector('img')) { verify(performance.now() < deadline, 'Dropped image did not attach.'); await frame(); }
    verify(overlay.hidden && composer.editor.value === 'Existing draft\n\n"/drop/report with spaces.pdf"', 'Mixed file drop lost the existing draft or local file reference.');
    const image = composer.node.querySelector<HTMLImageElement>('img'); if (!image) throw new Error('Missing dropped image.');
    await image.decode(); verify(image.naturalWidth === 32 && image.naturalHeight === 24, 'Dropped image lost its actual content.');
    const before = composer.editor.value;
    composer.update(thread, { ...runtime, status: { kind: 'connecting' } });
    drag(host, 'dragenter'); drag(host, 'drop');
    verify(overlay.hidden && composer.editor.value === before && errors.length === 0, 'Unavailable composer accepted a drop or left its overlay visible.');
    return 'File drops dim the chat, survive nested drag transitions, dismiss on exit/Escape/drop, preserve drafts, attach image bytes, add local file references, and respect unavailable composer state.';
  } finally { dispose(); composer.node.remove(); window.pi = bridge; }
}

async function checkQueuedEditing(view: Conversation, host: HTMLElement): Promise<string> {
  const bridge = window.pi, errors: string[] = [];
  const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
  const image = { type: 'image', mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] ?? '' } satisfies ImageContent;
  let runtime: RuntimeSnapshot = { ...source('queued-edit'), messages: [], models: [{ id: 'vision', modelID: 'vision', provider: 'test', name: 'Vision', supportsImages: true }], selectedModelID: 'vision', status: { kind: 'ready', activity: 'running' }, queuedFollowUps: [{ text: 'Queued text', imageCount: 1, imageRef: 'queued-image' }] };
  const thread = { id: runtime.id, projectPath: '/edit', displayTitle: 'Edit', ompSessionDirectory: '/edit/session', createdAt: '', updatedAt: '', draft: 'Existing draft', wasRunning: false };
  const other = { ...thread, id: 'queued-edit-other', draft: 'Other draft' };
  const composer = new Composer(text => errors.push(text), async () => null, () => {});
  let removed = Promise.withResolvers<RetractedMessage | null>(), requests = 0, prompts = 0;
  let completed: Promise<void> = Promise.resolve();
  view.onEditQueued = value => { completed = composer.retractQueued(value); return completed; };
  window.pi = { ...bridge, async request(request) {
    if (request.kind === 'draft') return { ok: true, value: null };
    if (request.kind === 'queued-images') return { ok: true, value: [image] };
    if (request.kind === 'prompt') { prompts++; return { ok: true, value: true }; }
    if (request.kind === 'retract-queued') { requests++; return { ok: true, value: await removed.promise }; }
    return bridge.request(request);
  } };
  const publish = (): void => { view.update(runtime, runtime.id); composer.update(thread, runtime); };
  const type = (text: string): void => { composer.editor.value = text; composer.editor.dispatchEvent(new Event('input', { bubbles: true })); };
  const edit = (): HTMLButtonElement => {
    const control = view.pending.querySelector<HTMLButtonElement>('.queued-edit');
    if (!control) throw new Error('Missing queued Edit action.');
    return control;
  };
  host.append(composer.node);
  try {
    publish(); await frame();
    const clipboard = new DataTransfer(); clipboard.items.add(new File([await (await fetch(canvas.toDataURL())).blob()], 'existing.png', { type: 'image/png' }));
    composer.editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    const deadline = performance.now() + 3000;
    while (!composer.node.querySelector('.composer-image')) { verify(performance.now() < deadline, 'Existing image draft did not load.'); await frame(); }
    verify(view.pending.querySelector('.message-images img')?.getAttribute('src') === canvas.toDataURL(), 'Queued preview stopped using actual shared message images.');
    verify(!view.pending.querySelector('.queued-attachments,.queued-label'), 'Queued bubble exposed old count/status indicators.');
    edit().click(); edit().click();
    verify(requests === 1 && composer.node.querySelector<HTMLButtonElement>('.image-remove')?.disabled, 'Edit double-clicked or left source attachments removable.');
    type('Newer draft'); await composer.submit(false);
    verify(prompts === 0, 'Pending retraction allowed draft submission.');
    runtime = { ...runtime, revision: runtime.revision + 1, queuedFollowUps: [] }; view.update(runtime, runtime.id);
    composer.update(other, { ...runtime, id: other.id }); type('Other newer draft'); view.scroll.focus();
    removed.resolve({ text: 'Queued text', images: [image], imagesDropped: false }); await completed;
    verify(composer.editor.value === 'Other newer draft' && !composer.node.querySelector('.composer-image') && document.activeElement === view.scroll, 'Late retraction changed or focused the selected other thread.');
    composer.update(thread, runtime);
    verify(composer.editor.value === 'Queued text\n\nNewer draft' && composer.node.querySelectorAll('.composer-image').length === 2, 'Withdrawal lost newer source text or either image after the queue row disappeared.');

    runtime = { ...runtime, revision: runtime.revision + 1, queuedSteers: [{ text: 'Duplicate', imageCount: 0, imageRef: null }, { text: 'Duplicate', imageCount: 1, imageRef: 'duplicate-image' }] }; publish(); await frame();
    verify([...view.pending.querySelectorAll<HTMLButtonElement>('.queued-edit')].every(control => control.disabled && control.title.includes('same text')), 'Ambiguous steering image duplicates remained editable.');
    verify([...view.pending.querySelectorAll<HTMLButtonElement>('.queued-send')].every(control => control.hidden), 'Steering queue exposed Send now.');
    runtime = { ...runtime, revision: runtime.revision + 1, queuedSteers: [{ text: 'Delivered already', imageCount: 0, imageRef: null }] }; publish();
    removed = Promise.withResolvers<RetractedMessage | null>(); edit().click(); removed.resolve(null); await completed;
    verify(composer.editor.value === 'Queued text\n\nNewer draft' && composer.node.querySelectorAll('.composer-image').length === 2, 'Already-delivered result replayed a queued message.');

    runtime = { ...runtime, revision: runtime.revision + 1, queuedSteers: [], queuedFollowUps: [{ text: 'Held text', imageCount: 1, imageRef: 'held-image' }] }; publish(); await frame();
    removed = Promise.withResolvers<RetractedMessage | null>(); edit().click();
    removed.resolve({ text: 'Held text', images: Array.from({ length: 20 }, () => image), imagesDropped: false }); await completed;
    const recover = composer.node.querySelector<HTMLButtonElement>('.composer-recover');
    verify(recover && !recover.hidden && composer.node.querySelectorAll('.composer-image').length === 2 && !composer.editor.value.includes('Held text'), 'Unexpected merge overflow discarded withdrawn data or changed the existing draft.');
    for (const remove of composer.node.querySelectorAll<HTMLButtonElement>('.image-remove')) remove.click();
    recover?.click(); await frame();
    verify(composer.editor.value === 'Held text\n\nQueued text\n\nNewer draft' && composer.node.querySelectorAll('.composer-image').length === 20 && recover?.hidden, 'Recoverable overflow did not restore all withdrawn text/images after freeing capacity.');
    const before = requests;
    runtime = { ...runtime, revision: runtime.revision + 1, queuedFollowUps: [{ text: 'Over capacity', imageCount: 1, imageRef: 'capacity-image' }] }; publish(); await frame(); edit().click(); await completed;
    verify(requests === before && composer.node.querySelectorAll('.composer-image').length === 20, 'Known attachment overflow destructively removed a queued message.');
    for (const remove of composer.node.querySelectorAll<HTMLButtonElement>('.image-remove')) remove.click();
    removed = Promise.withResolvers<RetractedMessage | null>(); edit().click();
    removed.resolve({ text: 'Missing native image', images: [], imagesDropped: true }); await completed;
    verify(composer.editor.value.startsWith('Missing native image\n\n') && composer.node.querySelector('.composer-message')?.textContent?.includes('could not return all'), 'Native image loss was hidden or discarded recoverable text.');
    verify(errors.length === 2, 'Queued editing reported unexpected errors.');
    return 'Queue Edit survives canonical removal and thread switches, preserves newer drafts/images, locks submission/attachment edits, rejects ambiguous image duplicates and preflight overflow, retains unexpected overflow for explicit recovery, and surfaces native image loss.';
  } finally {
    removed.resolve(null); view.onEditQueued = null; composer.node.remove(); window.pi = bridge;
  }
}

function checkMathRendering(view: Conversation): string {
  const body = document.createElement('div'); body.className = 'markdown'; view.content.append(body);
  const text = String.raw`A* chooses $f(n)=g(n)+h(n)$.

| Node | $g$ | $h$ | $f=g+h$ |
| --- | --- | --- | --- |
| A | 2 | 7 | 9 |

1. Compute $$g(\text{child})=g(B)+\text{edge cost},\qquad f(\text{child})=g(\text{child})+h(\text{child}).$$

$$
\begin{aligned}
x_1 &= \frac{1}{2} \\
x_2 &= \sqrt{4}
\end{aligned}
$$

Also \(a_i^2+b_i^2=c_i^2\) and \[\sum_{i=1}^n i\].

Code: ` + '`$literal$`' + String.raw`. Prices are $5 and $10. Escaped \$x\$ stays literal.

` + '```tex\n$not_math$\n```\n';
  renderMarkdown(body, text);
  const annotations = [...body.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent);
  verify(annotations.includes('f(n)=g(n)+h(n)') && annotations.includes('a_i^2+b_i^2=c_i^2') && annotations.includes('\\sum_{i=1}^n i'),
    'Inline, bracket-delimited, or display math lost its original TeX.');
  verify(body.querySelectorAll('th .katex').length === 3 && body.querySelector('li .math-display .katex') && body.querySelector('.katex .mfrac'),
    'Math failed in table headings, list items, or multiline fractions.');
  verify(!body.querySelector('.katex-error') && body.textContent?.includes('$5 and $10') && body.textContent.includes('$x$') && body.querySelector('pre code')?.textContent === '$not_math$\n' && !body.querySelector('code .katex'),
    'Math parsing consumed currency, escaped dollars, or code, or failed valid expressions.');
  renderMarkdown(body, 'A partial $f(n)=', true);
  verify(!body.querySelector('.katex'), 'An incomplete streamed equation rendered before its closing delimiter.');
  renderMarkdown(body, 'A partial $f(n)=g(n)$', true);
  const math = body.querySelector('.math-inline');
  verify(math?.querySelector('math') && !math.querySelector('.stream-word'), 'Completed streaming math lost its accessible output or animated its individual symbols.');
  renderMarkdown(body, 'A partial $f(n)=g(n)$ and new prose', true);
  verify(body.querySelector('.math-inline') === math, 'Appending prose rebuilt an unchanged equation.');
  renderMarkdown(body, String.raw`$\href{javascript:alert(1)}{unsafe}$ $\htmlStyle{position:fixed}{unsafe}$ <img src=x onerror="alert(1)"><script>alert(1)</script>`);
  verify(!body.querySelector('script,img,iframe,a,[onerror],[onclick],[style*="position:fixed"]'), 'Markdown or TeX introduced executable markup, navigation, or trusted styling.');
  renderMarkdown(body, String.raw`Broken $\frac{$ then readable prose.`);
  verify(body.querySelector('.katex-error') && body.textContent?.includes('then readable prose.'), 'Invalid TeX broke surrounding conversation content.');
  body.remove();
  return 'Inline/display/bracket math renders in prose, tables and lists; code/currency/escaped dollars stay literal, streamed equations reconcile atomically, and untrusted commands remain inert.';
}

export async function checkLoadingBehavior(): Promise<string[]> {
  const outcomes: string[] = [];
  const host = document.createElement('main'); host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--canvas);z-index:100'; document.body.append(host);
  const view = new Conversation(); host.append(view.node);
  try {
    outcomes.push(...checkNotices(view));
    outcomes.push(checkMathRendering(view));
    outcomes.push(checkCodeCopyReconciliation(host));
    outcomes.push(await checkStreamingPresentation(view, source('adaptive-streaming')));
    outcomes.push(await checkAdvisorDisclosure(view));
    outcomes.push(checkTodoActivity(view));
    outcomes.push(checkActivityPresentation(view));
    outcomes.push(await checkShimmerSpeed(view, host));
    outcomes.push(await checkWorkFeedback(view));
    outcomes.push(checkResponseCopy(view));
    outcomes.push(await checkComposerSizing(view, host));
    outcomes.push(await checkManualStreamingScroll(view, source('manual-stream-scroll')));
    outcomes.push(await checkSubmissionScroll(view, host));
    outcomes.push(await checkComposerImagePreview(view, host));
    outcomes.push(await checkComposerDrop(host));
    outcomes.push(await checkQueuedEditing(view, host));
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
    const fadeDeadline = performance.now() + 3000;
    while (!view.content.textContent?.includes('Freshwordverified')) {
      verify(performance.now() < fadeDeadline, 'Fresh streaming text stopped advancing after activation.'); await frame();
    }
    verify(Array.from(view.content.querySelectorAll('span.stream-word')).some(word => word.textContent?.trim() === 'Freshwordverified'), 'Fresh streaming text stopped animating after activation.');
    outcomes.push('Cached history does not replay reveal animations; fresh streaming words still animate.');
    return outcomes;
  } finally { view.dispose(); host.remove(); }
}

declare global { interface Window { checkPerformance: typeof checkLoadingBehavior } }
window.checkPerformance = checkLoadingBehavior;
