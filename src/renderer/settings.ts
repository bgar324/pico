import type { AppInfo, Preferences } from '../shared/types';
import { element, errorText, iconButton, labeled, Modal, request } from './dom';
import { SelectControl } from './controls';

export class Settings {
  private modal: Modal | null = null;
  private status: HTMLElement | null = null;
  private path: HTMLElement | null = null;
  private latest: AppInfo | null = null;
  private executableInput: HTMLInputElement | null = null;
  update(app: AppInfo): void {
    if (this.latest && app.preferences.executableOverride !== this.latest.preferences.executableOverride && this.executableInput) this.executableInput.value = app.preferences.executableOverride;
    this.latest = app;
    if (this.status && !this.status.dataset.local) this.status.textContent = app.connectionStatus;
    if (this.path) this.path.textContent = app.executablePath ?? 'No executable detected';
  }
  show(app: AppInfo): void {
    if (this.modal) { this.modal.node.focus(); return; }
    this.latest = app;
    const modal = new Modal('Settings', () => modal.close()); this.modal = modal;
    modal.onClose = () => { this.modal = null; this.status = null; this.path = null; this.executableInput = null; };
    const executable = element('input'); executable.value = app.preferences.executableOverride; executable.placeholder = 'Auto-detect'; executable.spellcheck = false;
    this.executableInput = executable;
    const appearance = new SelectControl('Appearance');
    appearance.setOptions([{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]); appearance.value = app.preferences.appearance;
    const project = new SelectControl('Default project');
    const projects = [{ label: 'Last opened project', value: '' }, ...app.manifest.projects.map(entry => ({ label: entry.path, value: entry.path }))];
    if (app.preferences.defaultProjectPath && !app.manifest.projects.some(entry => entry.path === app.preferences.defaultProjectPath)) projects.push({ label: app.preferences.defaultProjectPath, value: app.preferences.defaultProjectPath });
    project.setOptions(projects);
    project.value = app.preferences.defaultProjectPath;
    this.path = element('p', 'settings-path muted', app.executablePath ?? 'No executable detected'); this.status = element('p', 'settings-status muted', app.connectionStatus); this.status.setAttribute('role', 'status');
    const error = element('p', 'error-text'); error.setAttribute('role', 'alert');
    let preferences: Preferences = { ...app.preferences };
    const save = async (): Promise<void> => {
      preferences = { ...preferences, executableOverride: executable.value.trim(), appearance: appearance.value === 'light' ? 'light' : appearance.value === 'dark' ? 'dark' : 'system', defaultProjectPath: project.value };
      await request({ kind: 'preferences', preferences });
    };
    const choose = iconButton('folder-open', 'Choose executable…', async () => { choose.disabled = true; try { await request({ kind: 'choose-executable' }); } catch (failure) { error.textContent = errorText(failure); } finally { choose.disabled = false; } });
    const test = iconButton('play', 'Test connection', async () => {
      test.disabled = true; error.textContent = ''; if (this.status) { this.status.dataset.local = 'true'; this.status.textContent = 'Testing OMP RPC connection…'; }
      try { await save(); await request({ kind: 'test-connection' }); if (this.status) this.status.textContent = this.latest?.connectionStatus ?? 'Connection test finished. See diagnostics for details.'; }
      catch (failure) { error.textContent = errorText(failure); }
      finally { test.disabled = false; if (this.status) delete this.status.dataset.local; }
    });
    const connectionActions = element('div', 'settings-actions'); connectionActions.append(choose, test);
    modal.body.append(labeled('OMP executable override', executable), this.path, connectionActions, this.status, labeled('Appearance', appearance.node), labeled('Default project', project.node), element('p', 'security-note', 'OMP runs commands and edits files on this Mac using your normal user privileges. Provider credentials and tool policies remain managed by OMP.'), error);
    const diagnosticActions = element('div', 'settings-actions'); diagnosticActions.append(iconButton('code', 'Reveal diagnostics', async () => { try { await request({ kind: 'diagnostics' }); } catch (failure) { error.textContent = errorText(failure); } }));
    if (app.manifest.selectedThreadID) { const id = app.manifest.selectedThreadID; diagnosticActions.append(iconButton('folder', 'Reveal session storage', async () => { try { await request({ kind: 'reveal-session', id }); } catch (failure) { error.textContent = errorText(failure); } })); }
    modal.body.append(diagnosticActions);
    const apply = iconButton('save', 'Save', async () => { apply.disabled = true; try { await save(); modal.close(); } catch (failure) { error.textContent = errorText(failure); apply.disabled = false; } }, 'primary');
    modal.footer.append(iconButton('close', 'Cancel', () => modal.close()), apply);
    appearance.node.addEventListener('change', () => { void save().catch(failure => { error.textContent = errorText(failure); }); });
  }
}
