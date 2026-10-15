/**
 * Rate limits as token buckets, refilled every tick and starting with one
 * second's worth. Uploads take tokens before a block is sent; downloads
 * spend each block as it arrives and pause the sockets while the bucket is
 * empty, so the sender's TCP backs off. Engine and torrent limits are
 * separate buckets: a byte must fit both.
 */

/** A limit in bytes per second; 0 is unlimited. */
export class RateLimit {
  private tokens: number;

  constructor(public bytesPerSecond = 0) {
    this.tokens = this.burst;
  }

  /** Most tokens held: one second's worth, and always room for a few blocks. */
  private get burst(): number {
    return Math.max(this.bytesPerSecond, 64 * 1024);
  }

  public get unlimited(): boolean {
    return this.bytesPerSecond <= 0;
  }

  /** Adds `ms` worth of tokens. */
  public refill(ms: number): void {
    if (!this.unlimited) this.tokens = Math.min(this.tokens + (this.bytesPerSecond * ms) / 1000, this.burst);
  }

  /** Whether `bytes` may go now. */
  public allows(bytes: number): boolean {
    return this.unlimited || this.tokens >= bytes;
  }

  /** Spends tokens; downloads may overdraw, which keeps the sockets paused longer. */
  public spend(bytes: number): void {
    if (!this.unlimited) this.tokens -= bytes;
  }

  /** Whether the bucket is empty (or overdrawn). */
  public get exhausted(): boolean {
    return !this.unlimited && this.tokens <= 0;
  }
}

/** Takes `bytes` from every limit at once, or from none. */
export function takeAll(limits: RateLimit[], bytes: number): boolean {
  for (const limit of limits) if (!limit.allows(bytes)) return false;
  for (const limit of limits) limit.spend(bytes);
  return true;
}
