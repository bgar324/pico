import type { AppInfo, AppRequest } from '../shared/types';
import type { ConnectionsSnapshot, ProviderConnection } from '../shared/connections';
import { isConnectionsSnapshot } from '../shared/connections';
import { button, element, errorText, labeled, request } from './dom';

export class Connections {
  readonly node = element('div', 'connections');
  private readonly search = element('input', 'connections-search');
  private readonly list = element('div', 'connections-list');
  private readonly error = element('p', 'connections-error error-text');
  private readonly status = element('p', 'connections-status muted');
  private readonly refreshButton = button('Refresh', () => this.load());
  private readonly authPanel = element('section', 'connections-auth');
  private readonly authMessage = element('p', 'connections-auth-message');
  private readonly browser = button('Open sign-in page', () => this.openBrowser());
  private readonly cancel = button('Cancel sign-in', () => this.cancelLogin());
  private readonly promptForm = element('form', 'connections-code-form');
  private readonly code = element('input', 'connections-code');
  private readonly codeLabel = labeled('Authorization code', this.code);
  private readonly continueButton = element('button', 'primary', 'Continue');
  private readonly unsubscribe: () => void;
  private snapshot: ConnectionsSnapshot | null = null;
  private executable: string;
  private providerSignature = '';
  private expanded: string | null = null;
  private flowId: string | null = null;
  private promptId: string | null = null;
  private busy = false;
  private cancelling = false;
  private disposed = false;
  private loadEpoch = 0;

  constructor(app: AppInfo) {
    this.executable = app.preferences.executableOverride;
    this.search.type = 'search';
    this.search.placeholder = 'Search providers';
    this.search.setAttribute('aria-label', 'Search providers');
    this.search.addEventListener('input', () => this.filter());
    const toolbar = element('div', 'connections-toolbar');
    toolbar.append(this.search, this.refreshButton);
    this.status.setAttribute('role', 'status');
    this.error.setAttribute('role', 'alert');
    this.authPanel.setAttribute('aria-label', 'Provider sign-in');
    this.authMessage.setAttribute('role', 'status');
    const authActions = element('div', 'connections-actions');
    authActions.append(this.browser, this.cancel);
    this.code.type = 'password';
    this.code.autocomplete = 'off';
    this.code.spellcheck = false;
    this.continueButton.type = 'submit';
    this.promptForm.append(this.codeLabel, this.continueButton);
    this.promptForm.addEventListener('submit', event => { event.preventDefault(); void this.submitCode(); });
    this.authPanel.append(this.authMessage, authActions, this.promptForm);
    this.node.append(toolbar, this.status, this.error, this.authPanel, this.list,
      element('p', 'connections-note muted', 'Credentials are saved in OMP\'s local credential store. Idle chats update their models; running work is left alone.'));
    this.unsubscribe = window.pi.subscribe(event => {
      if (event.kind === 'connections') this.accept(event.snapshot);
    });
    this.paintAuth();
    void this.load();
  }

  update(app: AppInfo): void {
    if (app.preferences.executableOverride === this.executable) return;
    this.executable = app.preferences.executableOverride;
    void this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.loadEpoch++;
    this.unsubscribe();
    this.code.value = '';
    for (const input of this.node.querySelectorAll<HTMLInputElement>('.connections-key')) input.value = '';
    const flowId = this.flowId ?? (this.snapshot?.auth.kind === 'pending' ? this.snapshot.auth.id : null);
    if (flowId) void request({ kind: 'cancel-connection', flowId }).catch(() => undefined);
  }

  private accept(value: unknown): void {
    if (this.disposed) return;
    if (!isConnectionsSnapshot(value)) { this.error.textContent = 'OMP returned an invalid account summary.'; return; }
    if (this.snapshot && value.revision <= this.snapshot.revision) return;
    this.snapshot = value;
    const signature = JSON.stringify(value.providers);
    if (signature !== this.providerSignature) {
      this.providerSignature = signature;
      this.paintProviders();
    }
    if (value.auth.kind !== 'pending' && value.auth.kind !== 'idle' && value.auth.id === this.flowId) this.flowId = null;
    if (value.auth.kind === 'idle') this.flowId = null;
    this.paintAuth();
    this.setDisabled();
    this.filter();
  }

  private async load(): Promise<void> {
    if (this.disposed || this.busy || this.cancelling || this.snapshot?.auth.kind === 'pending') return;
    const epoch = ++this.loadEpoch;
    this.refreshButton.disabled = true;
    this.status.textContent = 'Loading provider accounts…';
    this.error.textContent = '';
    try {
      const value = await request({ kind: 'get-connections' });
      if (!this.disposed && epoch === this.loadEpoch) { this.accept(value); this.filter(); }
    } catch (failure) {
      if (!this.disposed && epoch === this.loadEpoch) { this.status.textContent = ''; this.error.textContent = errorText(failure); }
    } finally { if (!this.disposed && epoch === this.loadEpoch) this.setDisabled(); }
  }

  private paintProviders(): void {
    const providers = this.snapshot?.providers ?? [];
    this.list.replaceChildren();
    for (const provider of providers) {
      const row = element('section', 'connection-provider');
      row.dataset.provider = provider.id;
      const header = element('div', 'connection-provider-header');
      const copy = element('div', 'connection-provider-copy');
      const available = provider.apiKey || provider.loginMethods.length > 0;
      const action = provider.authenticated ? 'Manage' : available ? 'Connect' : 'Details';
      copy.append(element('h4', '', provider.name), element('p', 'muted', provider.authenticated ? 'Connected' : available ? 'Not connected' : 'No in-app setup'));
      const manage = button(action, () => {
        this.expanded = this.expanded === provider.id ? null : provider.id;
        for (const input of this.list.querySelectorAll<HTMLInputElement>('.connections-key')) input.value = '';
        for (const entry of this.list.querySelectorAll<HTMLElement>('.connection-provider')) {
          const open = entry.dataset.provider === this.expanded;
          const setup = entry.querySelector<HTMLElement>('.connection-provider-setup');
          if (setup) setup.hidden = !open;
          entry.querySelector('button')?.setAttribute('aria-expanded', String(open));
        }
      }, 'connection-manage');
      manage.setAttribute('aria-label', `${action} ${provider.name}`);
      manage.setAttribute('aria-expanded', String(this.expanded === provider.id));
      header.append(copy, manage);
      const setup = element('div', 'connection-provider-setup');
      setup.hidden = this.expanded !== provider.id;
      this.addAccounts(provider, setup);
      if (provider.loginMethods.length) {
        const methods = element('div', 'connections-actions');
        for (const method of provider.loginMethods) methods.append(button(method.label, () => this.login(method.id), 'connection-sign-in'));
        setup.append(methods);
      }
      if (provider.apiKey) this.addKeyForm(provider, setup);
      if (provider.authenticated && !provider.accounts.length) setup.append(element('p', 'connections-help muted', 'Authentication comes from OMP configuration or the environment. It cannot be removed here.'));
      if (!provider.apiKey && !provider.loginMethods.length && !provider.accounts.length) setup.append(element('p', 'connections-help muted', 'This provider does not expose an in-app connection method in the installed OMP version.'));
      row.append(header, setup);
      this.list.append(row);
    }
  }

  private addAccounts(provider: ProviderConnection, setup: HTMLElement): void {
    for (const account of provider.accounts) {
      const row = element('div', 'connection-account');
      const label = element('div', 'connection-account-label');
      label.append(element('span', '', account.label), element('small', 'muted', account.type === 'oauth' ? 'Signed-in account' : 'API key'));
      const remove = button('Disconnect', () => {
        if (remove.dataset.confirm !== 'true') {
          remove.dataset.confirm = 'true';
          remove.textContent = 'Confirm disconnect';
          remove.title = 'Remove this saved credential. Existing requests are not cancelled.';
          remove.setAttribute('aria-label', `Confirm disconnect ${provider.name} ${account.label}`);
          return;
        }
        void this.mutate({ kind: 'disconnect-provider', providerId: provider.id, credentialId: account.credentialId });
      });
      remove.classList.add('connection-disconnect');
      remove.setAttribute('aria-label', `Disconnect ${provider.name} ${account.label}`);
      row.append(label, remove);
      setup.append(row);
    }
  }

  private addKeyForm(provider: ProviderConnection, setup: HTMLElement): void {
    const form = element('form', 'connections-key-form');
    const input = element('input', 'connections-key');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Paste an API key';
    input.maxLength = 16384;
    input.required = true;
    input.setAttribute('aria-label', `${provider.name} API key`);
    const save = element('button', '', 'Save key');
    save.type = 'submit';
    form.append(input, save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key || this.busy || this.snapshot?.auth.kind === 'pending') return;
      input.value = '';
      void this.mutate({ kind: 'save-provider-key', providerId: provider.id, key });
    });
    setup.append(form);
  }

  private filter(): void {
    const query = this.search.value.toLocaleLowerCase().trim();
    let visible = 0;
    for (const row of this.list.querySelectorAll<HTMLElement>('.connection-provider')) {
      const provider = this.snapshot?.providers.find(entry => entry.id === row.dataset.provider);
      row.hidden = !provider || (query ? !`${provider.name} ${provider.id}`.toLocaleLowerCase().includes(query) :
        !provider.apiKey && !provider.loginMethods.length && !provider.authenticated && !provider.accounts.length);
      if (!row.hidden) visible++;
    }
    if (this.snapshot) this.status.textContent = visible ? `${this.snapshot.providers.filter(provider => provider.authenticated).length} connected · ${visible} ${query ? 'matching' : 'available'}` : 'No providers match your search.';
  }

  private paintAuth(): void {
    const auth = this.snapshot?.auth;
    this.authPanel.hidden = !auth || auth.kind === 'idle';
    const pending = auth?.kind === 'pending';
    this.authMessage.textContent = auth && auth.kind !== 'idle' ? auth.message : '';
    this.authMessage.classList.toggle('error-text', auth?.kind === 'failed');
    this.browser.hidden = !pending || !auth.url;
    this.cancel.hidden = !pending;
    this.promptForm.hidden = !pending || !auth.prompt;
    const prompt = pending ? auth.prompt : null;
    if (prompt?.id !== this.promptId) {
      this.promptId = prompt?.id ?? null;
      this.code.value = '';
      this.continueButton.disabled = false;
      if (prompt) {
        const text = this.codeLabel.querySelector('span');
        if (text) text.textContent = prompt.title;
        this.code.placeholder = prompt.placeholder;
        if (this.promptForm.getClientRects().length) this.code.focus();
      }
    }
  }

  private setDisabled(): void {
    const disabled = this.busy || this.cancelling || this.snapshot?.auth.kind === 'pending';
    this.refreshButton.disabled = Boolean(disabled);
    for (const control of this.list.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = Boolean(disabled);
  }

  private async login(providerId: string): Promise<void> {
    if (this.disposed || this.busy || this.cancelling || this.snapshot?.auth.kind === 'pending') return;
    const flowId = crypto.randomUUID();
    this.flowId = flowId;
    await this.mutate({ kind: 'connect-provider', providerId, flowId });
  }

  private async mutate(action: AppRequest): Promise<void> {
    if (this.disposed || this.busy || this.cancelling) return;
    this.busy = true;
    this.error.textContent = '';
    this.setDisabled();
    try { this.accept(await request(action)); }
    catch (failure) { if (!this.disposed) this.error.textContent = errorText(failure); }
    finally {
      this.busy = false;
      if (!this.disposed) this.setDisabled();
    }
  }

  private async openBrowser(): Promise<void> {
    const auth = this.snapshot?.auth;
    if (auth?.kind !== 'pending' || !auth.url) return;
    try { await request({ kind: 'open-url', url: auth.url }); }
    catch (failure) { if (!this.disposed) this.error.textContent = errorText(failure); }
  }

  private async submitCode(): Promise<void> {
    const auth = this.snapshot?.auth;
    if (auth?.kind !== 'pending' || !auth.prompt || !this.code.value.trim()) return;
    const value = this.code.value.trim();
    this.code.value = '';
    this.continueButton.disabled = true;
    try { await request({ kind: 'connection-input', flowId: auth.id, promptId: auth.prompt.id, value }); }
    catch (failure) { if (!this.disposed) { this.error.textContent = errorText(failure); this.continueButton.disabled = false; } }
  }

  private async cancelLogin(): Promise<void> {
    const flowId = this.flowId ?? (this.snapshot?.auth.kind === 'pending' ? this.snapshot.auth.id : null);
    if (!flowId || this.cancelling) return;
    this.cancelling = true;
    this.cancel.disabled = true;
    this.setDisabled();
    try { this.accept(await request({ kind: 'cancel-connection', flowId })); }
    catch (failure) { if (!this.disposed) this.error.textContent = errorText(failure); }
    finally {
      this.cancelling = false;
      if (!this.disposed) { this.cancel.disabled = false; this.setDisabled(); }
    }
  }
}
