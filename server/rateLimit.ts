/** Fixed-window limiter keyed by client address. Enough to stop a runaway tab
 * or a casual script from burning credits through the token endpoint. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds until the caller may retry, or 0 when the request is allowed. */
  hit(key: string): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      this.prune(t);
      return 0;
    }
    if (w.count >= this.limit) return Math.ceil((w.start + this.windowMs - t) / 1000);
    w.count += 1;
    return 0;
  }

  private prune(t: number) {
    if (this.windows.size < 512) return;
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
