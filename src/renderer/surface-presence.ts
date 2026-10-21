import { animate, type AnimationPlaybackControlsWithThen } from 'motion';

/** Logical visibility is immediate; only the visual exit waits for motion. */
export class SurfacePresence {
  private target: boolean | null = null;
  private animation: AnimationPlaybackControlsWithThen | undefined;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly snap = (): void => this.setVisible(this.visible, true);

  constructor(private readonly node: HTMLElement) {
    node.hidden = true; node.inert = true; node.setAttribute('aria-hidden', 'true');
    this.reduced.addEventListener('change', this.snap);
  }

  get visible(): boolean { return this.target === true; }

  setVisible(visible: boolean, instant = false): void {
    if (this.target === visible && (!instant || !this.animation)) return;
    const initial = this.target === null;
    this.target = visible;
    this.animation?.stop(); this.animation = undefined;
    this.node.inert = !visible;
    this.node.setAttribute('aria-hidden', String(!visible));
    if (initial || instant || this.reduced.matches) {
      this.node.hidden = !visible;
      this.node.style.opacity = String(Number(visible));
      this.node.style.translate = visible ? '0px 0px' : '0px 4px';
      return;
    }
    if (visible && this.node.hidden) {
      this.node.style.opacity = '0'; this.node.style.translate = '0px 4px';
      this.node.hidden = false;
    }
    const animation = animate(this.node, { opacity: Number(visible), translate: visible ? '0px 0px' : '0px 4px' }, {
      duration: 0.18, ease: [0.19, 1, 0.22, 1],
      onComplete: () => {
        if (this.animation !== animation) return;
        this.animation = undefined;
        if (!visible) this.node.hidden = true;
      },
    });
    this.animation = animation;
  }

  dispose(): void {
    this.animation?.stop(); this.animation = undefined;
    this.reduced.removeEventListener('change', this.snap);
  }
}
