import { animate, motionValue, type AnimationPlaybackControlsWithThen } from 'motion';

interface FolderMotion {
  viewport: HTMLElement;
  content: HTMLElement;
  open: boolean;
  height: number | null;
  animation: AnimationPlaybackControlsWithThen | undefined;
}

/** Codex's shell progress spring and independently measured folder transitions. */
export class SidebarMotion {
  private readonly progress = motionValue(1);
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private visible: boolean | null = null;
  private shellAnimation: AnimationPlaybackControlsWithThen | undefined;
  private readonly folders = new Map<HTMLElement, FolderMotion>();
  private readonly contents = new Map<Element, FolderMotion>();
  private readonly observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const folder = this.contents.get(entry.target);
      if (!folder) continue;
      const height = folder.content.getBoundingClientRect().height;
      if (folder.height === height) continue;
      const initial = folder.height === null;
      folder.height = height;
      if (folder.open) this.animateFolder(folder, initial);
    }
  });
  private readonly snap = (): void => {
    this.shellAnimation?.stop(); this.shellAnimation = undefined;
    this.progress.jump(this.visible === false ? 0 : 1);
    this.node.removeAttribute('data-animating');
    for (const folder of this.folders.values()) this.animateFolder(folder, true);
  };

  constructor(private readonly node: HTMLElement) {
    this.progress.on('change', value => node.style.setProperty('--sidebar-progress', String(value)));
    this.reduced.addEventListener('change', this.snap);
  }

  setVisible(visible: boolean, animated = true): void {
    if (this.visible === visible && (animated || !this.shellAnimation)) return;
    const initial = this.visible === null;
    this.visible = visible;
    this.shellAnimation?.stop(); this.shellAnimation = undefined;
    if (initial || !animated || this.reduced.matches) {
      this.progress.jump(Number(visible));
      this.node.style.setProperty('--sidebar-progress', String(Number(visible)));
      this.node.removeAttribute('data-animating');
      return;
    }
    this.node.setAttribute('data-animating', '');
    const animation = animate(this.progress, Number(visible), {
      type: 'spring', duration: 0.3, bounce: 0.1,
      onComplete: () => {
        if (this.shellAnimation !== animation) return;
        this.shellAnimation = undefined; this.node.removeAttribute('data-animating');
      },
    });
    this.shellAnimation = animation;
  }

  setFolder(viewport: HTMLElement, content: HTMLElement, open: boolean): void {
    let folder = this.folders.get(viewport);
    if (!folder) {
      folder = { viewport, content, open, height: null, animation: undefined };
      this.folders.set(viewport, folder); this.contents.set(content, folder);
      this.observer.observe(content);
      viewport.style.height = open ? 'auto' : '0px';
      viewport.style.opacity = open ? '1' : '0';
    } else if (folder.open !== open) {
      folder.open = open;
      folder.height = content.getBoundingClientRect().height;
      this.animateFolder(folder, false);
    }
    viewport.inert = !open;
    viewport.setAttribute('aria-hidden', String(!open));
  }

  removeFolder(viewport: HTMLElement): void {
    const folder = this.folders.get(viewport);
    if (!folder) return;
    folder.animation?.stop();
    this.observer.unobserve(folder.content);
    this.contents.delete(folder.content); this.folders.delete(viewport);
  }

  clear(): void {
    this.shellAnimation?.stop(); this.shellAnimation = undefined;
    this.progress.destroy();
    this.reduced.removeEventListener('change', this.snap);
    for (const viewport of this.folders.keys()) this.removeFolder(viewport);
    this.observer.disconnect();
  }

  private animateFolder(folder: FolderMotion, instant: boolean): void {
    folder.animation?.stop(); folder.animation = undefined;
    const height = folder.open ? folder.height ?? folder.content.getBoundingClientRect().height : 0;
    const opacity = Number(folder.open);
    if (instant || this.reduced.matches || !folder.viewport.isConnected) {
      folder.viewport.style.height = `${height}px`; folder.viewport.style.opacity = String(opacity);
      return;
    }
    const animation = animate(folder.viewport, { height, opacity }, {
      duration: 0.3, ease: [0.19, 1, 0.22, 1],
      onComplete: () => { if (folder.animation === animation) folder.animation = undefined; },
    });
    folder.animation = animation;
  }
}
