import { animate, motionValue, type AnimationPlaybackControlsWithThen } from 'motion';
import type { GitDiff, GitFileChange, GitSnapshot } from '../shared/types';
import { button, element, errorText, iconButton, request } from './dom';
import { diffLines, isGitDiff, isGitSnapshot } from './helpers';
import { captureTextSelection, restoreTextSelection } from './selection';

interface FileView { node: HTMLButtonElement; status: HTMLElement; path: HTMLElement; counts: HTMLElement }
function setText(node: HTMLElement, value: string): void { if (node.textContent !== value) node.textContent = value; }

export class Changes {
  readonly node = element('aside', 'changes-pane');
  readonly backdrop = element('div', 'changes-backdrop');
  private readonly content = element('div', 'changes-content');
  private readonly context = element('p', 'changes-context muted');
  private readonly list = element('div', 'change-files');
  private readonly status = element('p', 'changes-status muted');
  private readonly detail = element('section', 'change-detail');
  private readonly fileTitle = element('div', 'change-file-title');
  private readonly sections = element('div', 'diff-sections');
  private readonly warning = element('p', 'muted');
  private readonly lines = element('div', 'diff-scroll');
  private readonly unstaged = button('Unstaged', () => this.selectSection('unstaged'));
  private readonly staged = button('Staged', () => this.selectSection('staged'));
  private readonly refreshButton = iconButton('refresh', 'Refresh', () => this.refresh());
  private readonly closeButton = iconButton('close', 'Close', () => this.onClose());
  private readonly openButton = iconButton('external-link', 'Open file', () => this.open(false));
  private readonly revealButton = iconButton('folder-open', 'Reveal', () => this.open(true));
  private readonly fileViews = new Map<string, FileView>();
  private readonly progress = motionValue(0);
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly events = new AbortController();
  private readonly stopProgress: () => void;
  private animation: AnimationPlaybackControlsWithThen | undefined;
  private motionTarget: boolean | null = null;
  private projectPath = '';
  private snapshot: GitSnapshot | null = null;
  private selected: GitFileChange | null = null;
  private diff: GitDiff | null = null;
  private portion: 'staged' | 'unstaged' = 'unstaged';
  private generation = 0;
  private diffGeneration = 0;
  private timer: number | undefined;
  private visible = false;
  private disposed = false;
  private focusBefore: Element | null = null;
  private readonly snap = (): void => this.transition(true);

  constructor(private readonly onClose: () => void) {
    const header = element('div', 'pane-header'); header.append(element('h2', '', 'Changes'), this.refreshButton, this.closeButton);
    const fileActions = element('div', 'file-actions'); fileActions.append(this.openButton, this.revealButton);
    this.sections.append(this.unstaged, this.staged); this.detail.append(this.fileTitle, fileActions, this.sections, this.warning, this.lines);
    this.content.append(header, this.context, this.status, this.list, this.detail); this.node.append(this.content);
    this.node.hidden = true; this.node.inert = true; this.node.setAttribute('aria-hidden', 'true');
    this.detail.hidden = true;
    this.backdrop.hidden = true; this.backdrop.setAttribute('aria-hidden', 'true');
    this.stopProgress = this.progress.on('change', value => {
      this.node.style.setProperty('--changes-progress', String(value));
      this.backdrop.style.setProperty('--changes-progress', String(value));
    });
    this.node.style.setProperty('--changes-progress', '0'); this.backdrop.style.setProperty('--changes-progress', '0');
    this.reduced.addEventListener('change', this.snap);
    this.backdrop.addEventListener('click', () => { if (this.visible && this.node.classList.contains('sheet')) this.onClose(); }, { signal: this.events.signal });
    this.node.addEventListener('keydown', event => {
      if (!this.visible) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab' && this.node.classList.contains('sheet')) {
        const controls = Array.from(this.node.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'))
          .filter(control => !control.closest('[hidden],[inert]') && control.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1), active = document.activeElement;
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (active === first || !this.node.contains(active)) && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (active === last || !this.node.contains(active))) { event.preventDefault(); first.focus(); }
      }
    }, { signal: this.events.signal });
  }

  update(projectPath: string, visible: boolean, focusOrigin: Element | null = document.activeElement): void {
    if (this.disposed) return;
    const changed = this.projectPath !== projectPath, opened = !this.visible && visible, closed = this.visible && !visible;
    if (opened) this.focusBefore = focusOrigin;
    this.visible = visible;
    if (changed) {
      window.clearTimeout(this.timer); this.generation++; this.diffGeneration++;
      this.projectPath = projectPath; this.selected = null; this.diff = null; this.snapshot = null;
      this.fileViews.clear(); this.list.replaceChildren(); this.lines.replaceChildren(); delete this.lines.dataset.value;
      this.context.textContent = ''; this.status.textContent = ''; this.status.classList.remove('error-text');
      this.fileTitle.textContent = ''; this.warning.textContent = ''; this.detail.hidden = true;
      this.refreshButton.disabled = false; this.unstaged.disabled = true; this.staged.disabled = true;
    }
    this.layout(opened, changed);
    if (visible && (changed || opened)) void this.refresh();
    if (closed) {
      window.clearTimeout(this.timer);
      const origin = this.focusBefore;
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.node.contains(active)) active.blur();
      if (origin instanceof HTMLElement && origin.isConnected && !origin.matches(':disabled') && !origin.closest('[hidden],[inert],[aria-hidden="true"]') && origin.getClientRects().length > 0 && getComputedStyle(origin).visibility !== 'hidden') origin.focus({ preventScroll: true });
      this.focusBefore = null;
    }
  }

  layout(opened = false, instant = false): void {
    if (this.disposed) return;
    const sheet = window.innerWidth < 1180, changed = this.node.classList.contains('sheet') !== sheet;
    this.node.classList.toggle('sheet', sheet);
    this.node.setAttribute('role', sheet ? 'dialog' : 'complementary'); this.node.setAttribute('aria-label', 'Working tree changes');
    if (sheet && this.visible) this.node.setAttribute('aria-modal', 'true'); else this.node.removeAttribute('aria-modal');
    this.transition(instant);
    if (!sheet) { this.backdrop.hidden = true; this.backdrop.removeAttribute('data-open'); }
    else if (this.visible || this.animation) this.backdrop.hidden = false;
    if (sheet && this.visible) this.backdrop.setAttribute('data-open', ''); else this.backdrop.removeAttribute('data-open');
    if (sheet && this.visible && (changed || opened)) this.closeButton.focus({ preventScroll: true });
  }

  private transition(instant = false): void {
    const initial = this.motionTarget === null;
    this.node.inert = !this.visible; this.node.setAttribute('aria-hidden', String(!this.visible));
    if (!this.visible) this.backdrop.removeAttribute('data-open');
    if (this.motionTarget === this.visible && !instant) return;
    this.motionTarget = this.visible;
    this.animation?.stop(); this.animation = undefined;
    if (this.visible) this.node.hidden = false;
    if (initial || instant || this.reduced.matches) {
      this.progress.jump(Number(this.visible)); this.node.hidden = !this.visible;
      this.backdrop.hidden = !this.visible || !this.node.classList.contains('sheet');
      return;
    }
    const animation = animate(this.progress, Number(this.visible), {
      duration: 0.2, ease: [0.19, 1, 0.22, 1],
      onComplete: () => {
        if (this.animation !== animation) return;
        this.animation = undefined;
        if (!this.visible) { this.node.hidden = true; this.backdrop.hidden = true; }
      },
    });
    this.animation = animation;
  }

  toolEnded(projectPath: string): void {
    if (this.disposed || !this.visible || projectPath !== this.projectPath) return;
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.refresh(); }, 350);
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const path = this.projectPath;
    if (!path) { this.refreshButton.disabled = false; this.status.textContent = 'Select a project to inspect its working tree.'; return; }
    const generation = ++this.generation; this.diffGeneration++; this.refreshButton.disabled = true; this.status.textContent = 'Refreshing…'; this.status.classList.remove('error-text');
    this.context.textContent = `${path}\nRepository working tree, including changes made outside this thread.`;
    try {
      const value = await request({ kind: 'git-status', projectPath: path }); if (generation !== this.generation || path !== this.projectPath) return;
      if (!isGitSnapshot(value)) throw new Error('Invalid working tree response.'); this.snapshot = value;
      this.status.textContent = `${value.branch || 'Detached HEAD'} · ${value.files.length} changed ${value.files.length === 1 ? 'file' : 'files'}`;
      const previous = this.selected?.path;
      this.selected = value.files.find(file => file.path === previous) ?? value.files.find(file => file.status !== '??') ?? value.files[0] ?? null;
      this.renderList(); this.detail.hidden = !this.selected;
      if (this.selected) await this.loadDiff(previous !== this.selected.path);
      else { this.diffGeneration++; this.diff = null; this.status.textContent += '\nNo changes.'; this.lines.replaceChildren(); delete this.lines.dataset.value; }
    } catch (error) { if (generation === this.generation) { this.status.textContent = errorText(error); this.status.classList.add('error-text'); } }
    finally { if (generation === this.generation) this.refreshButton.disabled = false; }
  }
  private renderList(): void {
    const scroll = this.list.scrollTop, files = this.snapshot?.files ?? [];
    const paths = new Set(files.map(file => file.path));
    for (const [path, view] of this.fileViews) if (!paths.has(path)) { view.node.remove(); this.fileViews.delete(path); }
    for (const [index, file] of files.entries()) {
      let view = this.fileViews.get(file.path);
      if (!view) {
        const path = file.path;
        const node = button('', async () => {
          const selected = this.snapshot?.files.find(value => value.path === path); if (!selected || !this.visible) return;
          const changed = this.selected?.path !== path;
          this.selected = selected; this.renderList(); this.detail.hidden = false; await this.loadDiff(changed);
        }, 'change-file');
        const status = element('span', 'file-status'), name = element('span', 'file-path'), counts = element('span', 'file-counts');
        node.append(status, name, counts); view = { node, status, path: name, counts }; this.fileViews.set(path, view);
      }
      const current = this.list.children[index]; if (current !== view.node) this.list.insertBefore(view.node, current ?? null);
      view.node.classList.toggle('selected', this.selected?.path === file.path); view.node.setAttribute('aria-pressed', String(this.selected?.path === file.path));
      view.node.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
      const counts = file.status.includes('?') ? 'Untracked' : file.additions === null || file.deletions === null ? 'Binary' : `+${file.additions} −${file.deletions}`;
      setText(view.status, file.status); setText(view.path, file.path); setText(view.counts, counts);
    }
    this.list.scrollTop = scroll;
  }
  private async loadDiff(reset: boolean): Promise<void> {
    const file = this.selected; if (!file) return;
    const generation = ++this.diffGeneration, path = this.projectPath;
    setText(this.fileTitle, file.originalPath ? `${file.originalPath} → ${file.path}` : file.path);
    if (reset) {
      this.diff = null; this.warning.textContent = ''; this.unstaged.disabled = true; this.staged.disabled = true;
      this.lines.replaceChildren(element('p', 'muted', 'Loading diff…')); delete this.lines.dataset.value; this.lines.scrollTop = 0; this.portion = 'unstaged';
    }
    try {
      const value = await request({ kind: 'git-diff', projectPath: path, file });
      if (generation !== this.diffGeneration || path !== this.projectPath || file.path !== this.selected?.path) return;
      if (!isGitDiff(value)) throw new Error('Invalid Git diff response.');
      this.diff = value;
      if (!value[this.portion]) this.portion = value.unstaged ? 'unstaged' : 'staged';
      this.renderDiff(reset);
    } catch (error) {
      if (generation === this.diffGeneration && path === this.projectPath && file.path === this.selected?.path) {
        this.warning.textContent = errorText(error);
        if (reset) this.lines.replaceChildren();
      }
    }
  }
  private selectSection(portion: 'staged' | 'unstaged'): void { if (portion === this.portion) return; this.portion = portion; this.renderDiff(true); }
  private renderDiff(reset: boolean): void {
    const diff = this.diff; if (!diff) return;
    this.unstaged.disabled = !diff.unstaged; this.staged.disabled = !diff.staged;
    this.unstaged.setAttribute('aria-pressed', String(this.portion === 'unstaged')); this.staged.setAttribute('aria-pressed', String(this.portion === 'staged'));
    this.warning.textContent = diff.truncated ? 'Diff capped at 512 KB per section. Open the file to inspect the rest.' : !diff.staged && !diff.unstaged ? this.selected?.status.includes('?') ? 'Untracked file. No Git patch is available; open the file to inspect it.' : 'No text patch is available. The file may be binary.' : '';
    const text = diff[this.portion], signature = `${this.selected?.path}\0${this.portion}\0${text}`;
    if (this.lines.dataset.value === signature) return;
    const scroll = reset ? 0 : this.lines.scrollTop, left = reset ? 0 : this.lines.scrollLeft;
    const selection = reset ? null : captureTextSelection(this.lines);
    const oldLines = Array.from(this.lines.children), parsed = diffLines(text);
    for (const [index, line] of parsed.entries()) {
      const value = `${line.old ?? ''}\0${line.next ?? ''}\0${line.text}`, old = oldLines[index];
      if (old instanceof HTMLElement && old.dataset.value === value && old.classList.contains(line.kind)) continue;
      const row = element('div', `diff-line ${line.kind}`); row.dataset.value = value;
      row.append(element('span', 'line-number', line.old === null ? '' : String(line.old)), element('span', 'line-number', line.next === null ? '' : String(line.next)), element('span', 'diff-text', line.text));
      if (old) old.replaceWith(row); else this.lines.append(row);
    }
    for (let index = parsed.length; index < oldLines.length; index++) oldLines[index]?.remove();
    restoreTextSelection(this.lines, selection);
    this.lines.dataset.value = signature; this.lines.scrollTop = scroll; this.lines.scrollLeft = left;
  }
  private async open(reveal: boolean): Promise<void> {
    const file = this.selected, projectPath = this.projectPath; if (!file) return;
    try { await request({ kind: 'open-file', projectPath, file, reveal }); }
    catch (error) { if (!this.disposed && projectPath === this.projectPath && file.path === this.selected?.path) this.warning.textContent = errorText(error); }
  }

  dispose(): void {
    this.disposed = true; this.generation++; this.diffGeneration++; window.clearTimeout(this.timer);
    this.animation?.stop(); this.animation = undefined; this.stopProgress(); this.progress.destroy();
    this.reduced.removeEventListener('change', this.snap); this.events.abort(); this.fileViews.clear();
    this.node.inert = true; this.node.hidden = true; this.backdrop.hidden = true; this.focusBefore = null;
  }
}
