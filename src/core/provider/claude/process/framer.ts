const NEWLINE = 0x0a;

/**
 * Splits a byte stream into lines. Lines are decoded as UTF-8 only once complete, so a multi-byte
 * character split across chunks is never broken. A line over the cap is discarded as it arrives
 * (never buffered) and counted.
 */
export class LineFramer {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private skipping = false;
  private dropped = 0;

  constructor(private readonly maxLineBytes = 32 * 1024 * 1024) {}

  get droppedLines(): number {
    return this.dropped;
  }

  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      if (nl === -1) {
        this.append(chunk.subarray(start));
        break;
      }
      this.append(chunk.subarray(start, nl));
      this.finishLine(out);
      start = nl + 1;
    }
    return out;
  }

  /** Returns the final unterminated line, if any. */
  flush(): string[] {
    const out: string[] = [];
    this.finishLine(out);
    return out;
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.skipping) return;
    if (this.pendingBytes + part.length > this.maxLineBytes) {
      this.skipping = true;
      this.pending = [];
      this.pendingBytes = 0;
      this.dropped += 1;
      return;
    }
    this.pending.push(part);
    this.pendingBytes += part.length;
  }

  private finishLine(out: string[]): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    if (this.pendingBytes === 0) return;
    let text = Buffer.concat(this.pending, this.pendingBytes).toString('utf8');
    this.pending = [];
    this.pendingBytes = 0;
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.length > 0) out.push(text);
  }
}
