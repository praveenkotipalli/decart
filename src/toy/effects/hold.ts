/**
 * A press-and-hold: something has to stay true for a while before it counts. Used for
 * "hold a fist to wipe the drawing", where a fist that merely passes through must not
 * wipe anything and the user has to see the wipe coming (the hold ring).
 *
 * Pure: the clock is whatever the caller passes in, as long as it is always the same one.
 */
export class HoldGesture {
  /** When the current hold began; null while released. */
  private since: number | null = null;
  /** This hold has already fired. It has to be released before it can fire again. */
  private spent = false;

  constructor(readonly holdMs: number) {}

  /**
   * Feed the current state. `progress` runs 0 → 1 while held and is what a hold ring shows.
   * `fired` is true on exactly one call per hold: the first one at which the time is up.
   * After firing, progress reads 0 until the hold is released: the ring has done its job,
   * and a ring that stayed full would promise a second wipe that never comes.
   */
  update(time: number, active: boolean): { progress: number; fired: boolean } {
    if (!active) {
      this.reset();
      return { progress: 0, fired: false };
    }
    // A clock that ran backwards (the caller restarted its timeline) starts the hold again.
    if (this.since === null || time < this.since) this.since = time;
    if (this.spent) return { progress: 0, fired: false };
    const progress = this.holdMs > 0 ? Math.min(1, (time - this.since) / this.holdMs) : 1;
    if (progress < 1) return { progress, fired: false };
    this.spent = true;
    return { progress: 1, fired: true };
  }

  /** Let go: the next hold starts from zero and may fire again. */
  reset(): void {
    this.since = null;
    this.spent = false;
  }
}
