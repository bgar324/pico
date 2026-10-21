// Sanitize complete records before truncating: credentials may span read batches.
export function sanitizeDiagnostic(input: string, limit = 8192): string {
  return input
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1B\\))/g, '')
    .replace(/(bearer\s+)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|(?:client[_-]?)?secret|credential|private[_-]?key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;}&]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[query redacted]')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, limit);
}

export class DiagnosticBuffer {
  private partial: number[] = [];
  private discarding = false;
  private retained = '';
  constructor(private readonly capacity = 32768) {}
  append(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (byte === 10) this.finishLine();
      else if (!this.discarding) {
        if (this.partial.length < 8192) this.partial.push(byte);
        else { this.partial = []; this.discarding = true; }
      }
    }
  }
  finish(): void { if (this.partial.length || this.discarding) this.finishLine(); }
  get text(): string { return this.retained; }
  private finishLine(): void {
    this.retained += (this.discarding ? '[Oversized diagnostic line omitted]' : sanitizeDiagnostic(Buffer.from(this.partial).toString('utf8'))) + '\n';
    if (this.retained.length > this.capacity) this.retained = this.retained.slice(-this.capacity);
    this.partial = []; this.discarding = false;
  }
}
