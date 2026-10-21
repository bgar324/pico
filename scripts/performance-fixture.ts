import type { AppInfo, AppSnapshot, ChatMessage, PiBridge, RuntimeSnapshot, UiEvent } from '../src/shared/types';

const models = Array.from({ length: 80 }, (_, index) => ({ id: `provider/model-${index}`, provider: 'provider', modelID: `model-${index}`, name: `Model ${index}`, supportsImages: true }));
function history(id: string): RuntimeSnapshot {
  const messages: ChatMessage[] = Array.from({ length: 600 }, (_, index) => ({
    id: `${id}-${index}`, role: index % 2 ? 'assistant' : 'user',
    text: `Message ${index}: ${'A realistic paragraph with **emphasis**, [a project link](./README.md), and useful context. '.repeat(3)}${index % 10 === 1 ? '\n\n```ts\nconst result = await readProject();\n```' : ''}`,
    thinking: '', error: null, isStreaming: index === 599, toolIDs: [],
  }));
  return { id, revision: 1, status: { kind: 'ready', activity: 'running' }, models, selectedModelID: models[0]?.id ?? '', thinkingLevels: ['off', 'low', 'medium', 'high'], thinkingLevel: 'high', contextUsage: { tokens: 20000, contextWindow: 200000 }, messages, tools: [], dialogs: [], subagents: [], todoPhases: [], queuedFollowUps: [], queuedSteers: [], error: null, notice: null };
}
const states = new Map([['a', history('a')], ['b', history('b')]]);
let app: AppInfo = {
  revision: 1, manifest: { projects: [{ id: 'project', path: '/benchmark/project', expanded: true }], threads: ['a', 'b'].map(id => ({ id, projectPath: '/benchmark/project', displayTitle: `Conversation ${id}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', draft: '', wasRunning: true, ompSessionDirectory: `/benchmark/sessions/${id}` })), selectedThreadID: 'a', sidebarVisible: true },
  preferences: { executableOverride: '', appearance: 'dark', defaultProjectPath: '/benchmark/project', sidebarWidth: 244 }, executablePath: '/opt/homebrew/bin/omp', connectionStatus: 'Connected to OMP', error: null, theme: 'dark',
};
const listeners = new Set<(event: UiEvent) => void>();
const emit = (event: UiEvent): void => { for (const listener of listeners) listener(event); };
const bridge: PiBridge = {
  async request(request) {
    if (request.kind === 'snapshot') return { ok: true, value: structuredClone({ ...app, runtimes: [...states.values()] } satisfies AppSnapshot) };
    if (request.kind === 'select-thread') {
      const runtime = states.get(request.id);
      if (!runtime) return { ok: false, error: 'Unknown benchmark thread.' };
      app = { ...app, revision: app.revision + 1, manifest: { ...app.manifest, selectedThreadID: request.id } };
      emit({ kind: 'app', snapshot: structuredClone(app) });
      emit({ kind: 'runtime', event: { kind: 'snapshot', runtime: structuredClone(runtime) } });
      return { ok: true, value: null };
    }
    if (request.kind === 'preferences') {
      app = { ...app, revision: app.revision + 1, preferences: request.preferences };
      emit({ kind: 'app', snapshot: structuredClone(app) });
      return { ok: true, value: null };
    }
    if (request.kind === 'draft') return { ok: true, value: null };
    throw new Error(`Unsupported benchmark action: ${request.kind}`);
  },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  pathsFromDrop() { return []; },
};

async function paint(): Promise<void> {
  const frame = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()));
  await frame.promise;
}
function stream(id: string, index: number): void {
  const runtime = states.get(id), previous = runtime?.messages.at(-1);
  if (!runtime || !previous) throw new Error('Missing benchmark runtime.');
  const message = { ...previous, text: `${previous.text} token-${index}` };
  runtime.messages = [...runtime.messages.slice(0, -1), message]; runtime.revision++;
  emit({ kind: 'runtime', event: { kind: 'message', threadID: id, revision: runtime.revision, message: structuredClone(message) } });
}
function percentiles(samples: number[]): { medianMs: number; p95Ms: number } {
  const ordered = samples.slice().sort((a, b) => a - b);
  return { medianMs: Math.round((ordered[Math.floor(ordered.length / 2)] ?? 0) * 10) / 10, p95Ms: Math.round((ordered[Math.ceil(ordered.length * .95) - 1] ?? 0) * 10) / 10 };
}
async function updates(id: string): Promise<{ medianMs: number; p95Ms: number; transcriptMutations: number }> {
  let mutations = 0;
  const transcript = document.querySelector('.conversation-content');
  if (!transcript) throw new Error('Missing transcript.');
  const observer = new MutationObserver(records => { mutations += records.length; });
  observer.observe(transcript, { subtree: true, attributes: true, childList: true, characterData: true });
  const samples: number[] = [];
  for (let index = 0; index < 20; index++) { const start = performance.now(); stream(id, index); await paint(); samples.push(performance.now() - start); }
  observer.disconnect();
  return { ...percentiles(samples), transcriptMutations: mutations };
}

async function run(): Promise<Record<string, unknown>> {
  await paint();
  const initialRenderMs = Math.round(performance.now() - rendererStarted);
  const last = document.querySelector('[data-message-id="a-599"]');
  if (!last) throw new Error('Initial history did not render its latest message.');
  const initialRenderedMessages = document.querySelectorAll('.message').length;
  while (document.querySelector('.conversation-content[aria-busy="true"]')) await paint();
  const historyReadyMs = Math.round(performance.now() - rendererStarted);
  const background = await updates('b');
  const selectedStreaming = await updates('a');
  const switches: number[] = [];
  for (let index = 0; index < 8; index++) {
    const id = index % 2 ? 'a' : 'b', start = performance.now();
    const control = document.querySelector<HTMLButtonElement>(`.thread-title[data-thread-id="${id}"]`);
    if (!control) throw new Error('Missing sidebar target.');
    control.click(); await paint();
    const transcript = document.querySelector('.conversation-scroll');
    if (!transcript || transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop > 2) throw new Error('Chat switch did not restore the bottom.');
    switches.push(performance.now() - start);
  }
  document.querySelector<HTMLButtonElement>('.composer-settings-trigger')?.click();
  document.querySelector<HTMLButtonElement>('.composer-settings-menu [aria-label="Model"]')?.click();
  await paint();
  const results = document.querySelector('.model-picker .switcher-results');
  if (!results) throw new Error('Model search did not open.');
  let pickerMutations = 0;
  const pickerObserver = new MutationObserver(records => { pickerMutations += records.length; });
  pickerObserver.observe(results, { subtree: true, childList: true });
  await updates('b'); pickerObserver.disconnect();
  document.querySelector<HTMLButtonElement>('.model-picker .modal-footer button')?.click();
  return { scenario: 'Two running conversations, 600 Markdown messages each, 80 models', initialRenderMs, initialRenderedMessages, historyReadyMs, background, selectedStreaming, chatSwitches: percentiles(switches), pickerMutationsDuringBackground: pickerMutations, renderedMessages: document.querySelectorAll('.message').length };
}

declare global { interface Window { runPerformance: typeof run } }
const rendererStarted = performance.now();
window.pi = bridge;
window.runPerformance = run;
