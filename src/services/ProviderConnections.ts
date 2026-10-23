import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient, RpcError } from '../omp/RpcClient';
import type { ConnectionAccount, ConnectionAuth, ConnectionsSnapshot, ProviderConnection } from '../shared/connections';
import type { JsonRecord } from '../shared/types';
import { record } from '../shared/validation';
import { toolEnvironment } from './executable';

interface NativeProvider { id: string; name: string; available: boolean; authenticated: boolean }
interface ManagementSession {
  executable: string;
  client: RpcClient;
  directory: string | null;
  stopped: boolean;
  starting: Promise<void>;
  closing: Promise<void> | null;
}
interface LoginFlow {
  id: string;
  methodId: string;
  providerId: string;
  cancelled: boolean;
  task: Promise<void>;
}
interface ImportProcess { child: ChildProcessWithoutNullStreams; closed: Promise<void> }
class ConnectionError extends Error {}

const UPGRADE = 'This OMP version does not support in-app account management. Update OMP to 18.11.2 or newer, then reopen Connections.';
// The native login roster also contains secret/pre-browser prompt flows. Only
// these browser methods have a compatible, inspected RPC login implementation.
const BROWSER_METHODS: Record<string, string | undefined> = {
  anthropic: 'Sign in with Claude',
  'openai-codex': 'Sign in with ChatGPT',
  'openai-codex-device': 'Use device code',
  openrouter: 'Sign in with OpenRouter',
};
// API-key import accepts any string; Pico deliberately exposes only known key
// providers, never treating an unknown extension's OAuth ID as a key capability.
const API_PROVIDERS: Record<string, string | undefined> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini',
  mistral: 'Mistral', openrouter: 'OpenRouter', deepseek: 'DeepSeek', groq: 'Groq', xai: 'xAI',
  cerebras: 'Cerebras', fireworks: 'Fireworks', huggingface: 'Hugging Face',
  moonshot: 'Moonshot', ollama: 'Ollama', 'ollama-cloud': 'Ollama Cloud',
};
const COMMON_API_PROVIDERS: Record<string, true | undefined> = { openai: true, google: true, mistral: true };
function storageProvider(id: string): string { return id === 'openai-codex-device' ? 'openai-codex' : id; }
function safeError(error: unknown, fallback: string): ConnectionError {
  if (error instanceof ConnectionError) return error;
  if (error instanceof RpcError && /unknown command|unsupported command|not supported/i.test(error.message)) return new ConnectionError(UPGRADE);
  return new ConnectionError(fallback);
}
function providersFrom(value: unknown): NativeProvider[] {
  if (!record(value) || !Array.isArray(value.providers)) throw new ConnectionError(UPGRADE);
  const ids = new Set<string>();
  return value.providers.map((provider: unknown) => {
    if (!record(provider) || typeof provider.id !== 'string' || !provider.id || ids.has(provider.id) ||
        typeof provider.name !== 'string' || typeof provider.available !== 'boolean' || typeof provider.authenticated !== 'boolean') {
      throw new ConnectionError(UPGRADE);
    }
    ids.add(provider.id);
    return { id: provider.id, name: provider.name, available: provider.available, authenticated: provider.authenticated };
  });
}
function accountsFrom(value: unknown): ConnectionAccount[] {
  if (!record(value) || !Array.isArray(value.accounts)) throw new ConnectionError(UPGRADE);
  const ids = new Set<number>();
  return value.accounts.map((account: unknown) => {
    if (!record(account) || !Number.isSafeInteger(account.credentialId) || typeof account.credentialId !== 'number' ||
        ids.has(account.credentialId) || typeof account.provider !== 'string' || !account.provider || typeof account.label !== 'string' ||
        typeof account.detail !== 'string' || typeof account.active !== 'boolean' || (account.type !== 'api_key' && account.type !== 'oauth')) {
      throw new ConnectionError(UPGRADE);
    }
    ids.add(account.credentialId);
    return { credentialId: account.credentialId, label: account.label, type: account.type };
  });
}
function browserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32768) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** OMP owns all credential persistence. This service retains display metadata only. */
export class ProviderConnections {
  private state: ConnectionsSnapshot = { revision: 0, providers: [], auth: { kind: 'idle' } };
  private session: ManagementSession | null = null;
  private flow: LoginFlow | null = null;
  private mutation: 'api-key' | 'disconnect' | null = null;
  private tail: Promise<void> = Promise.resolve();
  private importing: ImportProcess | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly executable: () => Promise<string | null>,
    private readonly emit: (snapshot: ConnectionsSnapshot) => void,
    private readonly changed: () => Promise<void>,
  ) {}

  private publish(auth: ConnectionAuth = this.state.auth, providers = this.state.providers): ConnectionsSnapshot {
    this.state = { revision: this.state.revision + 1, providers, auth };
    if (!this.stopped) this.emit(this.state);
    return this.state;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  private assertOpen(): void {
    if (this.stopped) throw new ConnectionError('Account management is closed. Reopen Pico to reconnect.');
  }
  private assertAvailable(): void {
    this.assertOpen();
    if (this.flow || this.mutation) throw new ConnectionError('Finish or cancel the current account change first.');
  }

  async snapshot(): Promise<ConnectionsSnapshot> {
    this.assertOpen();
    // login occupies OMP's serialized RPC queue until consent completes.
    if (this.flow || this.mutation) return this.state;
    return this.serial(async () => {
      try { return await this.list(await this.management()); }
      catch (error) { throw safeError(error, 'Could not load provider connections. Check the OMP executable in Advanced and retry.'); }
    });
  }

  async login(providerId: string, flowId: string): Promise<ConnectionsSnapshot> {
    this.assertAvailable();
    if (!flowId || flowId.length > 200 || !Object.hasOwn(BROWSER_METHODS, providerId)) throw new ConnectionError('Choose an available browser sign-in method.');
    const flow: LoginFlow = { id: flowId, methodId: providerId, providerId: storageProvider(providerId), cancelled: false, task: Promise.resolve() };
    // Reserve the identity before discovery/startup, so closing Settings cannot
    // miss a flow whose process has not been created yet.
    this.flow = flow;
    const snapshot = this.publish({ kind: 'pending', id: flow.id, providerId: flow.providerId, message: 'Preparing sign-in…', url: null, prompt: null });
    flow.task = this.serial(() => this.runLogin(flow));
    return snapshot;
  }

  private async runLogin(flow: LoginFlow): Promise<void> {
    try {
      if (flow.cancelled || this.stopped) return;
      const session = await this.management();
      if (flow.cancelled || this.stopped) return;
      await this.list(session);
      if (flow.cancelled || this.stopped) return;
      const provider = this.state.providers.find(item => item.id === flow.providerId);
      if (!provider?.loginMethods.some(method => method.id === flow.methodId)) throw new ConnectionError('This sign-in method is not available in the selected OMP installation.');
      this.publish({ kind: 'pending', id: flow.id, providerId: flow.providerId, message: 'Waiting for the sign-in page…', url: null, prompt: null });
      await session.client.request('login', { providerId: flow.methodId }, { timeout: 600000 });
      if (flow.cancelled || this.stopped) return;
      await this.persisted(session, { kind: 'complete', id: flow.id, providerId: flow.providerId, message: 'Account connected.' }, flow);
    } catch (error) {
      if (flow.cancelled || this.stopped) return;
      let message = safeError(error, 'Sign-in did not finish. Check the connection list before retrying; OMP may already have saved the account.').message;
      if (error instanceof RpcError && /EADDRINUSE|address already in use|port.*(?:busy|in use)/i.test(error.message)) {
        message = 'The sign-in callback port is busy. Close another login attempt, or use ChatGPT device sign-in, then retry.';
      }
      // A native login can save successfully and then fail catalog refresh.
      // Re-list even on failure; never blindly replay credential mutations.
      try {
        if (this.session) await this.closeSession(this.session);
        await this.list(await this.management());
      } catch { /* Keep the last truthful snapshot. */ }
      if (flow.cancelled || this.stopped) return;
      try { await this.changed(); } catch { /* Account persistence is separate from idle chat refresh. */ }
      if (!flow.cancelled && !this.stopped) this.publish({ kind: 'failed', id: flow.id, providerId: flow.providerId, message });
    } finally {
      if (this.flow === flow && !flow.cancelled) this.flow = null;
    }
  }

  async submit(flowId: string, promptId: string, value: string): Promise<void> {
    this.assertOpen();
    const flow = this.flow;
    const auth = this.state.auth;
    if (!flow || flow.cancelled || flow.id !== flowId || auth.kind !== 'pending' || auth.id !== flowId || auth.prompt?.id !== promptId || !this.session?.client.ready) {
      throw new ConnectionError('This sign-in prompt has expired. Start sign-in again.');
    }
    if (!value.trim() || value.length > 32768 || value.includes('\0')) throw new ConnectionError('Paste the sign-in code or redirect URL from the browser.');
    this.publish({ ...auth, prompt: null, message: 'Completing sign-in…' });
    try { await this.session.client.send({ type: 'extension_ui_response', id: promptId, value }); }
    catch { throw new ConnectionError('Could not deliver the sign-in response. Cancel this attempt and reconnect.'); }
  }

  async cancel(flowId: string): Promise<ConnectionsSnapshot> {
    this.assertOpen();
    const flow = this.flow;
    if (!flow || flow.id !== flowId) return this.state;
    flow.cancelled = true;
    this.publish({ kind: 'idle' });
    // Killing only our management client is the native whole-flow cancellation.
    // Await startup as well as close before allowing a fixed-port reattempt.
    if (this.session) await this.closeSession(this.session);
    await flow.task;
    if (this.session) await this.closeSession(this.session);
    try {
      return await this.serial(async () => {
        const snapshot = await this.list(await this.management());
        try { await this.changed(); } catch { /* A completed save must not become a failed cancellation. */ }
        return snapshot;
      });
    } catch (error) {
      throw safeError(error, 'Sign-in was stopped, but account status could not be refreshed. Reopen Connections before retrying.');
    } finally {
      if (this.flow === flow) this.flow = null;
    }
  }

  async setApiKey(providerId: string, key: string): Promise<ConnectionsSnapshot> {
    this.assertAvailable();
    if (!key.trim() || key.length > 32768 || /[\r\n\0]/.test(key)) throw new ConnectionError('Enter a nonempty API key without line breaks.');
    this.mutation = 'api-key';
    try {
      return await this.serial(async () => {
        const session = await this.management();
        await this.list(session);
        if (!this.state.providers.some(provider => provider.id === providerId && provider.apiKey)) throw new ConnectionError('Choose an available API-key provider.');
        await this.importKey(session, providerId, key.trim());
        return this.persisted(session, { kind: 'complete', id: randomUUID(), providerId, message: 'API key saved.' });
      });
    } catch (error) { throw safeError(error, 'The API key could not be saved. Check OMP configuration and retry.'); }
    finally { this.mutation = null; }
  }

  async disconnect(providerId: string, credentialId: number): Promise<ConnectionsSnapshot> {
    this.assertAvailable();
    if (!Number.isSafeInteger(credentialId)) throw new ConnectionError('Choose a stored account to disconnect.');
    this.mutation = 'disconnect';
    try {
      return await this.serial(async () => {
        const session = await this.management();
        await this.list(session);
        const provider = this.state.providers.find(item => item.id === providerId);
        if (!provider?.accounts.some(account => account.credentialId === credentialId)) throw new ConnectionError('This stored account is no longer available. Refresh Connections.');
        try { await session.client.request('logout', { providerId, credentialId }, { timeout: 60000 }); }
        catch (error) {
          // The native command may remove a row before a catalog refresh fails.
          await this.list(session);
          const remaining = this.state.providers.find(item => item.id === providerId);
          if (remaining?.accounts.some(account => account.credentialId === credentialId)) throw error;
        }
        return this.persisted(session, { kind: 'complete', id: randomUUID(), providerId, message: 'Stored account removed. Environment and configuration credentials are unchanged.' });
      });
    } catch (error) { throw safeError(error, 'Could not confirm account removal. Refresh Connections before retrying.'); }
    finally { this.mutation = null; }
  }

  private async persisted(session: ManagementSession, auth: Extract<ConnectionAuth, { kind: 'complete' | 'failed' }>, flow?: LoginFlow): Promise<ConnectionsSnapshot> {
    let message = auth.message;
    try { await this.list(session); }
    catch { message += ' Account status could not be refreshed. Reopen Connections.'; }
    if (flow?.cancelled || this.stopped) return this.state;
    try { await this.changed(); }
    catch { message += ' Existing chats could not refresh yet; credentials remain saved.'; }
    if (flow?.cancelled || this.stopped) return this.state;
    return this.publish({ ...auth, message });
  }

  private async management(): Promise<ManagementSession> {
    this.assertOpen();
    const executable = await this.executable();
    this.assertOpen();
    if (!executable) throw new ConnectionError('OMP was not found. Choose a working OMP executable in Advanced.');
    if (this.session && (this.session.executable !== executable || !this.session.client.ready)) await this.closeSession(this.session);
    this.assertOpen();
    if (this.session) return this.session;
    const session: ManagementSession = { executable, client: new RpcClient(), directory: null, stopped: false, starting: Promise.resolve(), closing: null };
    this.session = session;
    session.client.on('event', frame => this.receive(session, frame));
    session.starting = (async () => {
      session.directory = await mkdtemp(join(tmpdir(), 'pico-connections-'));
      if (session.stopped || this.stopped) return;
      // A credential-free OMP otherwise exits before RPC ready. Selecting a
      // built-in model bootstraps auth only; this client never sends a prompt.
      await session.client.start({ executable, projectPath: session.directory, sessionDirectory: join(session.directory, 'sessions'), resume: false, model: 'openai/gpt-5.2' });
    })();
    try {
      await session.starting;
      if (session.stopped || this.stopped) throw new ConnectionError('Account management was stopped.');
      return session;
    } catch (error) {
      await this.closeSession(session);
      throw safeError(error, 'OMP account management could not start. Check the executable and global OMP configuration.');
    }
  }

  private async closeSession(session: ManagementSession): Promise<void> {
    if (session.closing) return session.closing;
    session.stopped = true;
    if (this.session === session) this.session = null;
    session.closing = (async () => {
      await session.client.shutdown();
      await session.starting.catch(() => {});
      await session.client.shutdown();
      session.client.removeAllListeners();
      if (session.directory) await rm(session.directory, { recursive: true, force: true });
    })();
    return session.closing;
  }

  private receive(session: ManagementSession, frame: JsonRecord): void {
    const flow = this.flow;
    const auth = this.state.auth;
    if (this.session !== session || session.stopped || !flow || flow.cancelled || auth.kind !== 'pending' || auth.id !== flow.id || frame.type !== 'extension_ui_request') return;
    if (frame.method === 'open_url') {
      const url = browserUrl(frame.launchUrl) ?? browserUrl(frame.url);
      const deviceCode = flow.methodId === 'openai-codex-device' && typeof frame.instructions === 'string'
        ? /^Enter code: ([A-Z0-9-]{4,32})$/i.exec(frame.instructions)?.[1] : undefined;
      if (url) this.publish({ ...auth, url, prompt: null, message: deviceCode
        ? `Open the sign-in page and enter this device code: ${deviceCode}`
        : 'Open the sign-in page and approve access in your browser.' });
    } else if (frame.method === 'input' && typeof frame.id === 'string') {
      // Never retain echoed callback codes, secrets, or provider diagnostics in UI
      // state. Only the submitted pipe write contains the user's pasted value.
      this.publish({ ...auth, message: 'Complete sign-in with the code or redirect URL from your browser.', prompt: { id: frame.id, title: 'Sign-in code or redirect URL', placeholder: '' } });
    }
  }

  private async list(session: ManagementSession): Promise<ConnectionsSnapshot> {
    const roster = providersFrom(await session.client.request('get_login_providers'));
    const providers = new Map<string, ProviderConnection>();
    for (const native of roster) {
      const id = storageProvider(native.id);
      let provider = providers.get(id);
      if (!provider) {
        provider = { id, name: id === 'openai-codex' ? 'ChatGPT / Codex' : native.name, authenticated: false, accounts: [], loginMethods: [], apiKey: native.available && Object.hasOwn(API_PROVIDERS, id) };
        providers.set(id, provider);
      }
      provider.authenticated ||= native.authenticated;
      const label = Object.hasOwn(BROWSER_METHODS, native.id) ? BROWSER_METHODS[native.id] : undefined;
      if (native.available && label) provider.loginMethods.push({ id: native.id, label });
    }
    for (const id of Object.keys(COMMON_API_PROVIDERS)) {
      if (!providers.has(id)) providers.set(id, { id, name: API_PROVIDERS[id] ?? id, authenticated: false, accounts: [], loginMethods: [], apiKey: true });
    }
    // This command reloads OMP's native store before listing display-only rows.
    // No exports or direct SQLite reads are needed for external-store changes.
    for (const provider of providers.values()) provider.accounts = accountsFrom(await session.client.request('get_logout_accounts', { providerId: provider.id }));
    const freshRoster = providersFrom(await session.client.request('get_login_providers'));
    for (const provider of providers.values()) {
      const native = freshRoster.filter(item => storageProvider(item.id) === provider.id);
      provider.authenticated = native.length ? native.some(item => item.authenticated) : provider.accounts.length > 0;
    }
    // These cloud API providers have no entry in OMP's login roster. Its
    // auth-filtered model list also detects inherited env/config credentials.
    const models = await session.client.request('get_available_models', {}, { timeout: 60000 });
    if (!record(models) || !Array.isArray(models.models)) throw new ConnectionError(UPGRADE);
    for (const model of models.models) {
      if (record(model) && typeof model.provider === 'string' && Object.hasOwn(COMMON_API_PROVIDERS, model.provider)) {
        const provider = providers.get(model.provider);
        if (provider) provider.authenticated = true;
      }
    }
    this.assertOpen();
    if (session.stopped) throw new ConnectionError('Account management was stopped.');
    return this.publish(this.state.auth, [...providers.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }

  private async importKey(session: ManagementSession, providerId: string, key: string): Promise<void> {
    this.assertOpen();
    const directory = session.directory;
    if (!directory) throw new ConnectionError('Account management is not ready. Reopen Connections.');
    const child = spawn(session.executable, ['auth', 'import', '-'], { cwd: directory, env: toolEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const gate = Promise.withResolvers<void>();
    const importing: ImportProcess = { child, closed: gate.promise };
    this.importing = importing;
    let stderr = '';
    let failed = false;
    let timedOut = false;
    let status: number | null = null;
    // Discard stdout entirely. Only a bounded diagnostic is inspected locally;
    // raw output, including unexpected echoed credentials, never leaves here.
    child.stdout.on('data', () => {});
    child.stderr.on('data', (bytes: Buffer) => { if (stderr.length < 16384) stderr += bytes.toString('utf8').slice(0, 16384 - stderr.length); });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => { failed = true; });
    child.once('error', () => { failed = true; });
    child.once('close', code => { status = code; gate.resolve(); });
    const timer = setTimeout(() => { timedOut = true; void this.stopImport(importing); }, 30000);
    try {
      child.stdin.end(JSON.stringify({ version: 1, credentials: [{ provider: providerId, credential: { type: 'api_key', key, source: 'login' } }] }));
      await gate.promise;
      if (this.stopped) throw new ConnectionError('Account management was closed. Reopen Connections to check whether the key was saved.');
      if (timedOut) throw new ConnectionError('OMP did not confirm the key import. Refresh Connections before retrying; persistence is unknown.');
      if (failed || status !== 0) {
        if (/auth broker|credentials live there/i.test(stderr)) throw new ConnectionError('OMP uses an auth broker. Add the API key on the broker host; Pico has left your broker configuration unchanged.');
        if (/unknown command|unexpected argument|unrecognized|invalid.*(?:action|command)/i.test(stderr)) throw new ConnectionError(UPGRADE);
        throw new ConnectionError('OMP could not import the API key. Check credential-store access and global OMP configuration.');
      }
    } finally {
      clearTimeout(timer);
      stderr = '';
      if (this.importing === importing) this.importing = null;
    }
  }

  private async stopImport(importing: ImportProcess): Promise<void> {
    const { child } = importing;
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
    try { await importing.closed; } finally { clearTimeout(timer); }
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.flow) this.flow.cancelled = true;
    this.stopping = (async () => {
      await Promise.all([this.session ? this.closeSession(this.session) : Promise.resolve(), this.importing ? this.stopImport(this.importing) : Promise.resolve()]);
      await this.tail;
      if (this.session) await this.closeSession(this.session);
      this.flow = null;
    })();
    return this.stopping;
  }
}
