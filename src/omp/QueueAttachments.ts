import type { ImageContent, QueuedMessage } from '../shared/types';

type Queue = 'steering' | 'followUp';
export interface QueueEntry extends QueuedMessage { chip: string; submission: string | null }
interface Submission { id: string; queue: Queue; text: string; chip: string; images: readonly ImageContent[]; bound: boolean; admittedAt: number | null }
interface Bucket<T> { values: T[]; next: number }
export interface QueueSnapshot { steering: QueuedMessage[]; followUp: QueuedMessage[] }
interface Promotion { text: string; entry: QueueEntry | null }
interface Retraction { queue: Queue; entry: QueueEntry; images: readonly ImageContent[] }

/** Native queues expose chip text only. Annotate attributable Pico submissions,
 * never infer attachments from a literal "[Image]" or from transcript history. */
export class QueueAttachments {
  private queues: Record<Queue, QueueEntry[]> = { steering: [], followUp: [] };
  private additions: Record<Queue, QueueEntry[]> = { steering: [], followUp: [] };
  private readonly submissions = new Map<string, Submission>();
  private promotion: Promotion | null = null;
  private retraction: Retraction | null = null;

  submitted(id: string, queue: Queue, text: string, images: readonly ImageContent[]): void {
    this.submissions.set(id, { id, queue, text, chip: text || (images.length ? '[Image]' : ''), images, bound: false, admittedAt: null });
    this.additions[queue] = [];
  }

  getImages(imageRef: string): readonly ImageContent[] {
    const submission = this.submissions.get(imageRef);
    if (!submission?.bound || !submission.images.length ||
        !this.queues[submission.queue].some(entry => entry.submission === imageRef && entry.imageRef === imageRef)) {
      throw new Error('Queued image preview has expired.');
    }
    return submission.images;
  }

  entries(queue: Queue): readonly QueueEntry[] { return this.queues[queue]; }
  hasUnbound(queue: Queue): boolean {
    for (const submission of this.submissions.values()) if (submission.queue === queue && !submission.bound) return true;
    return false;
  }

  prepareRetraction(queue: Queue, text: string, imageRef: string | null): Retraction | null {
    const entries = this.queues[queue];
    const entry = entries.find(item => item.text === text && item.imageRef === imageRef);
    if (!entry) return null;
    const matches = entries.filter(item => item.text === text);
    if (matches.length > 1 && matches.some(item => item.imageCount > 0)) {
      throw new Error('Identical queued messages with images cannot be retracted safely. Wait for an earlier copy to send.');
    }
    this.retraction = { queue, entry, images: imageRef ? this.getImages(imageRef) : [] };
    return this.retraction;
  }

  finishRetraction(retraction: Retraction): QueueSnapshot {
    this.cancelRetraction(retraction);
    const entries = this.queues[retraction.queue];
    const index = entries.indexOf(retraction.entry);
    if (index >= 0) {
      entries.splice(index, 1);
      if (retraction.entry.submission) this.submissions.delete(retraction.entry.submission);
    }
    return this.snapshot();
  }

  cancelRetraction(retraction: Retraction): void {
    if (this.retraction === retraction) this.retraction = null;
  }

  admitted(id: string, lifecycle: number): void {
    const submission = this.submissions.get(id);
    if (!submission) return;
    submission.admittedAt = lifecycle;
    if (submission.bound) return;
    const candidates = this.additions[submission.queue].filter(entry => entry.submission === null && this.queues[submission.queue].includes(entry));
    const entry = candidates.length === 1 ? candidates[0] : undefined;
    if (!entry) return;
    // A rewritten chip is attributable only at its correlated admission reply.
    submission.bound = true;
    entry.submission = id;
    entry.text = submission.text;
    entry.imageCount = submission.images.length;
    entry.imageRef = submission.images.length ? id : null;
  }

  rejected(id: string): void {
    this.submissions.delete(id);
    for (const queue of Object.values(this.queues)) for (let index = 0; index < queue.length; index++) {
      const entry = queue[index];
      if (entry?.submission === id) queue[index] = { chip: entry.chip, text: entry.chip, imageCount: 0, imageRef: null, submission: null };
    }
  }

  promote(text: string): Promotion | null {
    const entry = this.queues.followUp.find(item => item.text === text) ?? this.queues.followUp.find(item => item.chip === text);
    this.promotion = entry ? { text, entry } : null;
    return this.promotion;
  }

  finishPromotion(promotion: Promotion | null): void {
    if (this.promotion === promotion) this.promotion = null;
  }

  reconcile(steering: string[], followUp: string[], observedAt?: number): QueueSnapshot {
    const incoming = { steering, followUp };
    const retraction = this.retraction;
    if (retraction && this.queues[retraction.queue].includes(retraction.entry)) {
      const remaining = this.queues[retraction.queue].filter(entry => entry !== retraction.entry);
      // Distinct raw text can share a native chip, e.g. "" and "[Image]".
      // Confirm the selected removal before ordinary FIFO chip matching.
      if (remaining.length === incoming[retraction.queue].length &&
          remaining.every((entry, index) => entry.chip === incoming[retraction.queue][index])) {
        this.queues[retraction.queue] = remaining;
      }
    }
    if (this.promotion && (!this.promotion.entry || !this.queues.followUp.includes(this.promotion.entry))) {
      const text = this.promotion.text;
      this.promotion.entry = this.queues.followUp.find(entry => entry.text === text) ?? this.queues.followUp.find(entry => entry.chip === text) ?? null;
    }
    const promoted = this.promotion?.entry;
    if (promoted && this.queues.followUp.includes(promoted)) {
      const remaining = this.queues.followUp.filter(entry => entry !== promoted);
      // Delivery may consume earlier steers before the promotion's next snapshot.
      // Match the surviving FIFO suffix rather than requiring every steer to remain.
      const consumedSteers = this.queues.steering.length - (steering.length - 1);
      if (remaining.length === followUp.length && remaining.every((entry, index) => entry.chip === followUp[index]) &&
          steering.length > 0 && consumedSteers >= 0 && steering.at(-1) === promoted.chip &&
          this.queues.steering.every((entry, index) => index < consumedSteers || entry.chip === steering[index - consumedSteers])) {
        this.queues.followUp = remaining;
        if (consumedSteers) this.queues.steering.splice(0, consumedSteers);
        this.queues.steering.push(promoted);
        const submission = promoted.submission ? this.submissions.get(promoted.submission) : undefined;
        if (submission) submission.queue = 'steering';
        this.promotion = null;
      }
    }
    for (const kind of ['steering', 'followUp'] satisfies Queue[]) {
      const previous = new Map<string, Bucket<QueueEntry>>();
      for (const entry of this.queues[kind]) {
        const bucket = previous.get(entry.chip);
        if (bucket) bucket.values.push(entry); else previous.set(entry.chip, { values: [entry], next: 0 });
      }
      const counts = new Map<string, number>();
      for (const chip of incoming[kind]) counts.set(chip, (counts.get(chip) ?? 0) + 1);
      const pending = new Map<string, Bucket<Submission>>();
      for (const submission of this.submissions.values()) {
        if (submission.queue !== kind || submission.bound) continue;
        const bucket = pending.get(submission.chip);
        if (bucket) bucket.values.push(submission); else pending.set(submission.chip, { values: [submission], next: 0 });
      }
      for (const [chip, bucket] of previous) {
        // Native delivery/removal consumes the first matching occurrence, not
        // every equal-text entry. Keep later occurrences when a run shrinks.
        bucket.next = Math.max(0, bucket.values.length - (counts.get(chip) ?? 0));
        const replacements = pending.get(chip)?.values;
        if (observedAt !== undefined && replacements?.some(submission => submission.admittedAt !== null && submission.admittedAt <= observedAt) &&
            (counts.get(chip) ?? 0) <= bucket.values.length) {
          // Equal-text replacement can be coalesced into an unchanged native
          // snapshot. It has no stable identity, so do not reattach an old image.
          bucket.values = bucket.values.map(entry => ({ chip: entry.chip, text: entry.chip, imageCount: 0, imageRef: null, submission: null }));
        }
      }
      const unmatched: QueueEntry[] = [];
      this.queues[kind] = incoming[kind].map(chip => {
        const old = previous.get(chip);
        const retained = old ? old.values[old.next++] : undefined;
        if (retained) return retained;
        const candidates = pending.get(chip);
        const submitted = candidates ? candidates.values[candidates.next++] : undefined;
        if (submitted) {
          submitted.bound = true;
          return { chip, text: submitted.text, imageCount: submitted.images.length, imageRef: submitted.images.length ? submitted.id : null, submission: submitted.id };
        }
        const entry: QueueEntry = { chip, text: chip, imageCount: 0, imageRef: null, submission: null };
        unmatched.push(entry);
        return entry;
      });
      if (unmatched.length) this.additions[kind] = unmatched;
    }
    const bound = new Set([...this.queues.steering, ...this.queues.followUp].flatMap(entry => entry.submission ? [entry.submission] : []));
    for (const [id, submission] of this.submissions) {
      if (submission.bound ? !bound.has(id) : observedAt !== undefined && submission.admittedAt !== null && submission.admittedAt <= observedAt) this.submissions.delete(id);
    }
    return this.snapshot();
  }

  snapshot(): QueueSnapshot {
    return {
      steering: this.queues.steering.map(({ text, imageCount, imageRef }) => ({ text, imageCount, imageRef })),
      followUp: this.queues.followUp.map(({ text, imageCount, imageRef }) => ({ text, imageCount, imageRef })),
    };
  }

  reset(): void {
    this.queues = { steering: [], followUp: [] };
    this.additions = { steering: [], followUp: [] };
    this.submissions.clear();
    this.promotion = null;
    this.retraction = null;
  }
}
