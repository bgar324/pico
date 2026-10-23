import { animate, motionValue, type AnimationPlaybackControlsWithThen } from 'motion';

/** Logical visibility is immediate; only the visual exit waits for motion. */
export class SurfacePresence {
  private target: boolean | null = null;
  private animation: AnimationPlaybackControlsWithThen | undefined;
  private readonly progress = motionValue(0);
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly snap = (): void => this.setVisible(this.visible, true);
  private readonly render = (value: number): void => {
    this.node.style.opacity = String(value);
    this.node.style.translate = `0px ${4 * (1 - value)}px`;
  };

  constructor(private readonly node: HTMLElement) {
    node.hidden = true; node.inert = true; node.setAttribute('aria-hidden', 'true');
    this.progress.on('change', this.render);
    this.render(0);
    this.reduced.addEventListener('change', this.snap);
    document.addEventListener('visibilitychange', this.snap);
  }

  get visible(): boolean { return this.target === true; }

  setVisible(visible: boolean, instant = false): void {
    if (this.target === visible && (!instant || !this.animation)) return;
    const initial = this.target === null;
    this.target = visible;
    this.animation?.stop(); this.animation = undefined;
    this.node.inert = !visible;
    this.node.setAttribute('aria-hidden', String(!visible));
    if (initial || instant || this.reduced.matches || document.hidden) {
      this.progress.jump(Number(visible));
      this.node.hidden = !visible;
      return;
    }
    if (visible) this.node.hidden = false;
    const animation = animate(this.progress, Number(visible), {
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
    this.progress.destroy();
    this.reduced.removeEventListener('change', this.snap);
    document.removeEventListener('visibilitychange', this.snap);
  }
}
