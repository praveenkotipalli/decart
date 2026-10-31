/** Events per second over a sliding one-second window. */
export class RateMeter {
  private stamps: number[] = [];

  tick(t: number) {
    this.stamps.push(t);
    while (this.stamps.length && t - this.stamps[0] > 1000) this.stamps.shift();
  }

  rate(now = performance.now()): number {
    while (this.stamps.length && now - this.stamps[0] > 1000) this.stamps.shift();
    return this.stamps.length;
  }
}
