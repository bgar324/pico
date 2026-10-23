import type { AppInfo, Preferences } from '../shared/types';
import { button, element, errorText, Modal, request } from './dom';
import { SelectControl } from './controls';
import { Connections } from './connections';
import { icon } from './icons';

type SettingsSection = 'general' | 'connections' | 'advanced';
type SettingsOperation = 'appearance' | 'save' | 'choose' | 'test';

export class Settings {
  private modal: Modal | null = null;
  private latest: AppInfo | null = null;
  private refresh: (() => void) | null = null;

  update(app: AppInfo): void {
    this.latest = app;
    this.refresh?.();
  }

  show(app: AppInfo): void {
    if (this.modal) { this.modal.node.focus(); return; }
    this.latest = app;
    const modal = new Modal('Settings', () => modal.close());
    this.modal = modal;
    modal.node.classList.add('settings-dialog');
    const active = (): boolean => this.modal === modal;
    const current = (): AppInfo => this.latest ?? app;
    let section: SettingsSection = 'general';
    let operation: SettingsOperation | null = null;
    let pendingAppearance: Preferences['appearance'] | null = null;
    let executableDirty = false;
    let projectDirty = false;

    const sidebar = element('aside', 'settings-sidebar');
    const title = modal.node.querySelector('h2');
    if (title) {
      title.classList.add('settings-title');
      sidebar.append(title);
    }
    const navigation = element('div', 'settings-navigation');
    navigation.setAttribute('role', 'tablist');
    navigation.setAttribute('aria-label', 'Settings sections');
    navigation.setAttribute('aria-orientation', 'vertical');
    sidebar.append(navigation);
    const content = element('div', 'settings-content');
    const sectionOrder: SettingsSection[] = ['general', 'connections', 'advanced'];
    const sectionIcons = { general: 'settings', connections: 'agents', advanced: 'sliders' } satisfies Record<SettingsSection, Parameters<typeof icon>[0]>;
    const addSection = (key: SettingsSection, title: string, description: string): { tab: HTMLButtonElement; panel: HTMLElement } => {
      const tab = button('', () => selectSection(key), 'settings-tab');
      tab.append(icon(sectionIcons[key]), element('span', '', title));
      tab.id = `settings-tab-${key}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `settings-panel-${key}`);
      const panel = element('section', 'settings-section');
      panel.id = `settings-panel-${key}`;
      panel.dataset.section = key;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = 0;
      const heading = element('header', 'settings-section-header');
      heading.append(element('h3', '', title), element('p', 'settings-description muted', description));
      panel.append(heading);
      navigation.append(tab);
      content.append(panel);
      return { tab, panel };
    };
    const sections: Record<SettingsSection, { tab: HTMLButtonElement; panel: HTMLElement }> = {
      general: addSection('general', 'General', 'Choose your appearance and starting project.'),
      connections: addSection('connections', 'Connections', 'Connect provider accounts to use their models through OMP.'),
      advanced: addSection('advanced', 'Advanced', 'Configure the local OMP executable and inspect connection details.'),
    };
    const general = sections.general.panel;
    const accounts = sections.connections.panel;
    const advanced = sections.advanced.panel;
    modal.body.append(sidebar, content);
    const group = (panel: HTMLElement, title: string): HTMLElement => {
      const section = element('section', 'settings-group');
      const heading = element('h4', 'settings-group-title', title);
      heading.id = `settings-group-${crypto.randomUUID()}`;
      section.setAttribute('aria-labelledby', heading.id);
      const rows = element('div', 'settings-group-rows');
      section.append(heading, rows);
      panel.append(section);
      return rows;
    };
    const preference = (owner: HTMLElement, label: string, help: string, control: HTMLElement): HTMLElement => {
      const row = element('div', 'settings-preference');
      const copy = element('div', 'settings-preference-copy');
      const labelNode = element('label', 'settings-preference-label', label);
      labelNode.id = `settings-label-${crypto.randomUUID()}`;
      control.id ||= `settings-control-${crypto.randomUUID()}`;
      labelNode.htmlFor = control.id;
      const description = element('p', 'settings-help muted', help);
      description.id = `settings-help-${crypto.randomUUID()}`;
      copy.append(labelNode, description);
      control.setAttribute('aria-labelledby', labelNode.id);
      control.setAttribute('aria-describedby', description.id);
      const value = element('div', 'settings-preference-control');
      value.append(control);
      row.append(copy, value);
      owner.append(row);
      return copy;
    };

    const appearance = element('div', 'settings-appearance');
    appearance.setAttribute('role', 'group');
    appearance.setAttribute('aria-label', 'Appearance');
    const appearanceButtons: { value: Preferences['appearance']; control: HTMLButtonElement }[] = [];
    for (const option of [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ] satisfies { value: Preferences['appearance']; label: string }[]) {
      const control = button('', () => changeAppearance(option.value), 'settings-appearance-option');
      const preview = element('span', 'settings-appearance-preview');
      preview.setAttribute('aria-hidden', 'true');
      preview.append(element('span', 'settings-preview-sidebar'), element('span', 'settings-preview-content'));
      control.append(preview, element('span', 'settings-appearance-label', option.label));
      control.dataset.appearance = option.value;
      appearanceButtons.push({ value: option.value, control });
      appearance.append(control);
    }
    const visualStyle = group(general, 'Visual style');
    const appearanceStatus = element('p', 'settings-help muted', 'Appearance saves immediately.');
    appearanceStatus.setAttribute('role', 'status');
    const appearanceCopy = preference(visualStyle, 'Mode', 'Use your system appearance or choose a light or dark mode.', appearance);
    appearanceCopy.append(appearanceStatus);
    const project = new SelectControl('Default project');
    project.value = app.preferences.defaultProjectPath;
    const workspace = group(general, 'Workspace');
    preference(workspace, 'Default project', 'Choose the starting project for a new conversation. Save changes to apply.', project.node);

    const connections = new Connections(app);
    accounts.append(connections.node);

    const executable = element('input', 'settings-executable');
    executable.value = app.preferences.executableOverride;
    executable.placeholder = 'Auto-detect OMP';
    executable.spellcheck = false;
    executable.autocomplete = 'off';
    const runtime = group(advanced, 'OMP runtime');
    preference(runtime, 'Executable override', 'Leave blank to auto-detect OMP. Save text edits before using the new path.', executable);
    executable.addEventListener('input', () => {
      executableDirty = executable.value !== current().preferences.executableOverride;
      refreshControls();
    });
    project.node.addEventListener('change', () => {
      projectDirty = project.value !== current().preferences.defaultProjectPath;
      refreshControls();
    });
    const detectedPath = element('p', 'settings-path muted');
    detectedPath.classList.add('settings-readonly');
    preference(runtime, 'Detected executable', 'The OMP executable available to Pico.', detectedPath);
    const connectionStatus = element('p', 'settings-status muted settings-readonly');
    connectionStatus.setAttribute('role', 'status');
    preference(runtime, 'Connection status', 'Check the local OMP RPC connection.', connectionStatus);
    const executableActions = element('div', 'settings-actions');
    const choose = button('Choose executable…', () => run('choose', async () => {
      const previous = current().preferences.executableOverride;
      await request({ kind: 'choose-executable' });
      if (!active()) return;
      if (current().preferences.executableOverride !== previous) {
        executable.value = current().preferences.executableOverride;
        executableDirty = false;
      }
    }));
    const test = button('Test connection', () => run('test', async () => {
      await saveDraft(false);
      if (active()) await request({ kind: 'test-connection' });
    }));
    executableActions.append(choose, test);
    preference(runtime, 'Connection tools', 'Choose an executable file or test the saved runtime configuration.', executableActions);
    const diagnosticActions = element('div', 'settings-actions');
    const reveal = async (kind: 'diagnostics' | 'reveal-session'): Promise<void> => {
      if (!active()) return;
      error.textContent = '';
      try {
        if (kind === 'diagnostics') await request({ kind });
        else {
          const id = current().manifest.selectedThreadID;
          if (id) await request({ kind, id });
        }
      } catch (failure) { if (active()) error.textContent = errorText(failure); }
    };
    const sessionStorage = button('Reveal session storage', () => reveal('reveal-session'));
    diagnosticActions.append(button('Reveal diagnostics', () => reveal('diagnostics')), sessionStorage);
    const diagnostics = group(advanced, 'Diagnostics');
    preference(diagnostics, 'Local files', 'Open diagnostics or the selected conversation’s session storage in Finder.', diagnosticActions);
    advanced.append(element('p', 'settings-security-note', 'OMP runs commands and edits files on this Mac using your normal user privileges. Provider accounts are managed in Connections.'));

    const error = element('p', 'settings-error error-text');
    error.setAttribute('role', 'alert');
    const saveHint = element('span', 'settings-save-hint muted', 'Appearance saves immediately. Other preferences use Save changes.');
    const close = button('Close', () => modal.close(), 'settings-close');
    const save = button('Save changes', () => run('save', async () => {
      await saveDraft(true);
      if (active()) modal.close();
    }), 'primary');
    const footerActions = element('div', 'settings-footer-actions');
    footerActions.append(saveHint, close, save);
    modal.footer.append(error, footerActions);

    const refreshControls = (): void => {
      const busy = operation !== null;
      for (const { value, control } of appearanceButtons) {
        control.setAttribute('aria-pressed', String(value === (pendingAppearance ?? current().preferences.appearance)));
        control.disabled = busy;
      }
      appearance.setAttribute('aria-busy', String(operation === 'appearance'));
      appearanceStatus.textContent = operation === 'appearance' ? 'Saving appearance…' : 'Appearance saves immediately.';
      executable.disabled = busy && operation !== 'appearance';
      project.disabled = busy || section !== 'general';
      choose.disabled = busy;
      test.disabled = busy;
      choose.textContent = operation === 'choose' ? 'Choosing…' : 'Choose executable…';
      test.textContent = operation === 'test' ? 'Testing…' : 'Test connection';
      save.textContent = operation === 'save' ? 'Saving…' : 'Save changes';
      save.disabled = busy || (!executableDirty && !projectDirty);
      sessionStorage.disabled = !current().manifest.selectedThreadID;
      connectionStatus.textContent = operation === 'test' ? 'Testing OMP RPC connection…' : current().connectionStatus;
      saveHint.textContent = executableDirty || projectDirty ? 'You have unsaved changes.' : 'Appearance saves immediately. Other preferences use Save changes.';
    };
    const refreshApp = (): void => {
      const latest = current();
      if (!executableDirty) executable.value = latest.preferences.executableOverride;
      executableDirty = executable.value !== latest.preferences.executableOverride;
      const projectValue = projectDirty ? project.value : latest.preferences.defaultProjectPath;
      const options = [{ label: 'Last opened project', value: '' }, ...latest.manifest.projects.map(entry => ({ label: entry.path, value: entry.path }))];
      if (projectValue && !options.some(option => option.value === projectValue)) options.push({ label: projectValue, value: projectValue });
      project.setOptions(options);
      project.value = projectValue;
      projectDirty = projectValue !== latest.preferences.defaultProjectPath;
      detectedPath.textContent = latest.executablePath ?? 'No executable detected';
      connections.update(latest);
      refreshControls();
    };
    const saveDraft = async (includeProject: boolean): Promise<void> => {
      if (!executableDirty && (!includeProject || !projectDirty)) return;
      const executableValue = executable.value;
      const preferences = {
        ...current().preferences,
        ...(executableDirty ? { executableOverride: executable.value.trim() } : {}),
        ...(includeProject && projectDirty ? { defaultProjectPath: project.value } : {}),
      };
      await request({ kind: 'preferences', preferences });
      if (active() && executable.value === executableValue) executable.value = preferences.executableOverride;
    };
    const run = async (kind: SettingsOperation, action: () => Promise<void>): Promise<void> => {
      if (!active() || operation !== null) return;
      operation = kind;
      error.textContent = '';
      refreshControls();
      try { await action(); }
      catch (failure) { if (active()) error.textContent = errorText(failure); }
      finally {
        if (active()) {
          operation = null;
          pendingAppearance = null;
          refreshApp();
        }
      }
    };
    const changeAppearance = async (value: Preferences['appearance']): Promise<void> => {
      if (operation !== null || value === current().preferences.appearance) return;
      pendingAppearance = value;
      await run('appearance', async () => {
        await request({ kind: 'preferences', preferences: { ...current().preferences, appearance: value } });
      });
    };
    const selectSection = (key: SettingsSection): void => {
      for (const menu of modal.node.querySelectorAll<HTMLElement>('[popover]:popover-open')) menu.hidePopover();
      section = key;
      for (const name of sectionOrder) {
        const entry = sections[name];
        const selected = name === key;
        entry.tab.setAttribute('aria-selected', String(selected));
        entry.tab.tabIndex = selected ? 0 : -1;
        entry.panel.hidden = !selected;
      }
      refreshControls();
    };
    navigation.addEventListener('keydown', event => {
      const keys = sectionOrder;
      const index = keys.indexOf(section);
      let next: SettingsSection | undefined;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = keys[(index + 1) % keys.length];
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = keys[(index + keys.length - 1) % keys.length];
      else if (event.key === 'Home') next = keys[0];
      else if (event.key === 'End') next = keys.at(-1);
      if (next) {
        event.preventDefault();
        selectSection(next);
        sections[next].tab.focus();
      }
    });
    modal.onClose = () => {
      project.disabled = true;
      connections.dispose();
      if (active()) { this.modal = null; this.refresh = null; }
    };
    this.refresh = refreshApp;
    selectSection('general');
    refreshApp();
  }
}
