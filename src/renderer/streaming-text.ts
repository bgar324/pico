/** Presentation-only buffering. The runtime and clipboard keep the complete source. */
export class StreamingText {
  private source: string;
  private visibleLength: number;
  private lastTargetLength: number;
  private publishedLength: number;
  private rate = 1;
  private lastArrival: number | null = null;
  private lastDrain: number | null = null;
  private carry = 0;
  private frame: number | null = null;
  private timer: number | null = null;

  constructor(text: string, private readonly publish: (text: string) => void, private readonly enabled: () => boolean) {
    // Mounting or reactivating a stream must not replay its existing text.
    this.source = text;
    this.visibleLength = this.lastTargetLength = this.publishedLength = text.length;
  }

  update(text: string): void {
    if (!text.startsWith(this.source)) {
      this.destroy();
      this.source = text;
      this.visibleLength = this.lastTargetLength = this.publishedLength = text.length;
      this.rate = 1; this.lastArrival = this.lastDrain = null; this.carry = 0;
      this.publish(text);
      return;
    }
    this.source = text;
    if (this.visibleLength < text.length) this.drain();
  }

  flush(): void {
    this.destroy();
    this.visibleLength = this.publishedLength = this.source.length;
    this.lastDrain = null; this.carry = 0;
    this.publish(this.source);
  }

  destroy(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
  }

  private drain(): void {
    if (!this.enabled()) { this.flush(); return; }
    const now = performance.now() / 1000;
    const arrived = this.source.length - this.lastTargetLength;
    this.lastTargetLength = this.source.length;
    if (arrived > 0) {
      // The reference ships 10s and experimental .01s interval floors. Use
      // its default, not an assumed live experiment assignment.
      this.rate = this.lastArrival === null ? arrived : Math.max(1, .1 * arrived / Math.max(now - this.lastArrival, 10) + .9 * this.rate);
      this.lastArrival = now;
    }
    const elapsed = this.lastDrain === null ? 0 : now - this.lastDrain;
    this.lastDrain = now;
    const remaining = this.source.length - this.visibleLength;
    for (let step = 0; step < (elapsed + this.carry) / .05; step++) {
      if (remaining && remaining < this.rate * 1.5) this.rate = (remaining + this.rate * 1.5) / 2;
      if (remaining > this.rate / 1.2) this.rate = (remaining + this.rate / 1.2) / 2;
    }
    this.rate = Math.max(1, this.rate);
    const amount = elapsed * this.rate + this.carry;
    const count = Math.floor(amount);
    this.carry = amount - count;
    this.visibleLength = Math.min(this.visibleLength + count, this.source.length);
    if (this.visibleLength === this.source.length) { this.lastDrain = null; this.carry = 0; }
    if (this.visibleLength !== this.publishedLength && this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        // Never publish a dangling UTF-16 surrogate at a presentation boundary.
        let end = this.visibleLength;
        const previous = this.source.charCodeAt(end - 1), next = this.source.charCodeAt(end);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        if (end !== this.publishedLength) {
          this.publishedLength = end;
          this.publish(this.source.slice(0, end));
        }
      });
    }
    if (this.visibleLength < this.source.length && this.timer === null) {
      this.timer = window.setTimeout(() => { this.timer = null; this.drain(); }, 50);
    }
  }
}
