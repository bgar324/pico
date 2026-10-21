const HOLD_SECONDS = 0.35;
const EM_PER_SECOND = 2;

interface Title {
  content: HTMLElement;
  clip: HTMLSpanElement;
  distance: number;
  speed: number;
}

// Hold before scrolling, then use the standard smoothstep curve for a gentle
// start and stop. Sample into CSS linear() so the hold stays duration-independent.
function scrollTiming(travelSeconds: number): string {
  const duration = HOLD_SECONDS + travelSeconds;
  const holdPercent = HOLD_SECONDS / duration * 100;
  const points = ['0 0%', `0 ${holdPercent}%`];
  for (let step = 1; step <= 16; step++) {
    const progress = step / 16;
    const position = progress * progress * (3 - 2 * progress);
    const timePercent = (HOLD_SECONDS + travelSeconds * progress) / duration * 100;
    points.push(`${position.toFixed(4)} ${timePercent.toFixed(4)}%`);
  }
  return `linear(${points.join(', ')})`;
}

/** Owns overflow measurements, not title text or row interaction. */
export class SidebarTitles {
  private readonly titles = new Map<HTMLElement, Title>();
  private readonly owners = new Map<Element, HTMLElement>();
  private readonly observer = new ResizeObserver(entries => {
    const changed = new Set<HTMLElement>();
    for (const entry of entries) {
      const viewport = this.owners.get(entry.target);
      if (viewport) changed.add(viewport);
    }
    // ResizeObserver also reports detached targets at zero size. Release both
    // observations together, including when a caller removes a whole subtree.
    for (const viewport of this.titles.keys()) {
      if (!viewport.isConnected) this.untrack(viewport);
    }
    const measurements: { viewport: HTMLElement; title: Title; distance: number; speed: number }[] = [];
    for (const viewport of changed) {
      const title = this.titles.get(viewport);
      if (!title) continue;
      const width = viewport.getBoundingClientRect().width;
      const contentWidth = title.content.getBoundingClientRect().width;
      const overflow = contentWidth - width;
      const distance = width > 0 && overflow >= 1 ? overflow : 0;
      const fontSize = Number.parseFloat(getComputedStyle(title.content).fontSize);
      const speed = (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 13) * EM_PER_SECOND;
      measurements.push({ viewport, title, distance, speed });
    }
    // Complete every layout read before applying animation variables.
    for (const { viewport, title, distance, speed } of measurements) {
      if (title.distance === distance && title.speed === speed) continue;
      title.distance = distance;
      title.speed = speed;
      viewport.toggleAttribute('data-marquee-overflowing', distance > 0);
      if (distance === 0) {
        this.removeVariables(viewport);
        continue;
      }
      const travelSeconds = distance / speed;
      viewport.style.setProperty('--marquee-scroll-distance', `${distance}px`);
      viewport.style.setProperty('--marquee-duration', `${(HOLD_SECONDS + travelSeconds).toFixed(3)}s`);
      viewport.style.setProperty('--marquee-scroll-timing', scrollTiming(travelSeconds));
    }
  });

  track(viewport: HTMLElement, content: HTMLElement): void {
    if (this.titles.get(viewport)?.content === content) return;
    this.untrack(viewport);
    const clip = document.createElement('span');
    clip.className = 'sidebar-title-clip';
    const track = document.createElement('span');
    track.className = 'sidebar-title-track';
    content.replaceWith(clip);
    clip.append(track);
    track.append(content);
    this.titles.set(viewport, { content, clip, distance: -1, speed: 0 });
    this.owners.set(viewport, viewport);
    this.owners.set(content, viewport);
    this.observer.observe(viewport);
    this.observer.observe(content);
  }

  untrack(viewport: HTMLElement): void {
    const title = this.titles.get(viewport);
    if (!title) return;
    this.observer.unobserve(viewport);
    this.observer.unobserve(title.content);
    this.owners.delete(viewport);
    this.owners.delete(title.content);
    this.titles.delete(viewport);
    viewport.removeAttribute('data-marquee-overflowing');
    this.removeVariables(viewport);
    title.clip.replaceWith(title.content);
  }

  clear(): void {
    for (const viewport of this.titles.keys()) this.untrack(viewport);
    this.observer.disconnect();
  }

  private removeVariables(viewport: HTMLElement): void {
    viewport.style.removeProperty('--marquee-scroll-distance');
    viewport.style.removeProperty('--marquee-duration');
    viewport.style.removeProperty('--marquee-scroll-timing');
  }
}
