const PIXELS_PER_SECOND = 80;

/** Keeps a single highlight moving at the same speed on short and long labels. */
export class TextShimmer {
  private readonly targets = new Set<HTMLElement>();
  private readonly observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const node = entry.target;
      if (!(node instanceof HTMLElement) || !this.targets.has(node) || !entry.contentRect.width) continue;
      const spread = parseFloat(getComputedStyle(node).getPropertyValue('--shimmer-spread'));
      // The oversized gradient travels the label width plus both highlight edges.
      const distance = entry.contentRect.width + spread * 2 + 2;
      node.style.setProperty('--shimmer-duration', `${distance / PIXELS_PER_SECOND}s`);
    }
  });

  set(node: HTMLElement, active: boolean): void {
    if (this.targets.has(node) === active) return;
    node.classList.toggle('work-shimmer', active);
    if (active) { this.targets.add(node); this.observer.observe(node); }
    else { this.targets.delete(node); this.observer.unobserve(node); node.style.removeProperty('--shimmer-duration'); }
  }

  clear(): void {
    for (const node of this.targets) this.set(node, false);
  }
}
