import type { Vec2 } from "../geometry/vec";

/**
 * Render-rate follower for a point that is only measured at tracking rate.
 *
 * Hand tracking delivers a position every 60–200 ms (5–17 Hz, with jitter and the odd
 * dropped result) while the screen redraws every 7–33 ms. Drawing the latest result
 * steps; extrapolating it steps and overshoots. PointGlide chases the latest result
 * through two cascaded one-pole low-passes whose time constant follows the measured
 * tracking interval, so every new result is spread over roughly the time until the next
 * one: position and velocity are both continuous, and the follower cannot pass its target.
 *
 * A small lead buys back part of the lag by pushing the target ahead along the measured
 * velocity. The lead is added to the target, in front of the two poles, so it is smoothed
 * like everything else: a changed velocity estimate bends the path, it never steps it.
 */
export interface GlideOptions {
  /** Follower time constant as a multiple of the measured tracking interval. */
  tauFactor: number;
  /** Bounds of that time constant, ms. It is split evenly over the two poles. */
  tauMinMs: number;
  tauMaxMs: number;
  /** Fraction of the measured velocity the target is led by. 0 = no lead. */
  leadGain: number;
  /** Longest time the lead extrapolates over, ms (and never more than one tracking interval). */
  leadMaxMs: number;
  /**
   * Largest lead, stage units. The follower never passes its target, so this is also the
   * hard limit on how far the point can run past a hand that stops dead.
   */
  maxLead: number;
}

export const DEFAULT_GLIDE: GlideOptions = {
  tauFactor: 0.7,
  tauMinMs: 45,
  tauMaxMs: 140,
  leadGain: 0.5,
  leadMaxMs: 100,
  maxLead: 0.03,
};

/** Tuning shared by every follower. */
export const GLIDE_T = {
  /** Tracking interval assumed until two results have been seen, ms (10 Hz). */
  defaultIntervalMs: 100,
  /** Weight of a new interval measurement in the running estimate. */
  intervalBlend: 0.3,
  /** Results closer together than this are one result delivered twice: nothing is measured from them, ms. */
  minGapMs: 4,
  /** A longer gap is a stall or a re-acquisition, not a tracking interval: no velocity is measured across it, ms. */
  maxGapMs: 500,
  /**
   * Movement per result (stage units) below which the lead is off, and above which it is
   * fully on. Landmark jitter is a few thousandths of the stage per result; extrapolating
   * it would make a hand that is held still shimmer more than its raw landmarks do.
   */
  leadQuiet: 0.004,
  leadFull: 0.012,
} as const;

/** Below this a pole is treated as absent (the follower passes its target straight through), ms. */
const MIN_POLE_MS = 1e-3;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function smoothstep(from: number, to: number, v: number): number {
  const s = clamp((v - from) / (to - from), 0, 1);
  return s * s * (3 - 2 * s);
}

export class PointGlide {
  private readonly options: GlideOptions;

  private active = false;
  /** Time the follower state belongs to, ms. */
  private t = -Infinity;
  /** First pole. */
  private ax = 0;
  private ay = 0;
  /** Second pole: the output. */
  private bx = 0;
  private by = 0;

  /** Latest result, when it was taken, and whether the point was observed in it. */
  private px = 0;
  private py = 0;
  private tSample = 0;
  private wasFresh = false;
  /**
   * Lead: for `leadMs` after `tSample` the target runs ahead of the result at this rate
   * (stage units per ms = measured velocity × leadGain), then holds.
   */
  private rx = 0;
  private ry = 0;
  private leadMs = 0;

  /** Running estimate of the time between results, ms. */
  private interval: number = GLIDE_T.defaultIntervalMs;
  /** False until a gap has been measured since the last snap or reset: the next gap then replaces the guess outright. */
  private measured = false;
  /** Time constant of each of the two poles, ms. */
  private pole: number;

  constructor(options: Partial<GlideOptions> = {}) {
    this.options = { ...DEFAULT_GLIDE, ...options };
    this.pole = this.poleFor(this.interval);
  }

  /**
   * Feed one tracking result. `time` is the result's own timestamp (the camera frame's)
   * and normally lies behind the render clock by the inference latency: the result takes
   * effect from the later of the two.
   * `fresh: false` marks a result in which the point was not observed (its hand is
   * coasting through a dropout): the target moves to `p` and the lead is switched off.
   * The first result after construction or reset() snaps.
   */
  sample(p: Vec2, time: number, fresh = true): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(time)) return;
    if (!this.active) {
      this.snap(p, time);
      this.wasFresh = fresh;
      return;
    }
    // The old target stays in force up to the moment this result takes effect, so the
    // path does not depend on where render frames happen to fall around it.
    if (time > this.t) this.advance(time);

    const dt = time - this.tSample;
    if (dt < GLIDE_T.minGapMs) {
      // The same result twice, or one out of order: move the target, keep the timing.
      this.px = p.x;
      this.py = p.y;
      if (!fresh) {
        this.dropLead();
        this.wasFresh = false;
      }
      return;
    }

    const o = this.options;
    const gap = Math.min(dt, GLIDE_T.maxGapMs);
    this.interval = this.measured ? this.interval + (gap - this.interval) * GLIDE_T.intervalBlend : gap;
    this.measured = true;
    this.pole = this.poleFor(this.interval);

    let rx = 0;
    let ry = 0;
    let leadMs = 0;
    // A velocity needs two observations in a row: across a dropout the point took an
    // unknown path, and a coasting result is not an observation at all.
    if (fresh && this.wasFresh && dt <= GLIDE_T.maxGapMs) {
      const dx = p.x - this.px;
      const dy = p.y - this.py;
      const k = (smoothstep(GLIDE_T.leadQuiet, GLIDE_T.leadFull, Math.hypot(dx, dy)) * o.leadGain) / dt;
      rx = dx * k;
      ry = dy * k;
      const rate = Math.hypot(rx, ry);
      if (rate > 0) {
        leadMs = Math.max(0, Math.min(o.leadMaxMs, this.interval));
        if (rate * leadMs > o.maxLead) leadMs = Math.max(0, o.maxLead) / rate; // cap the distance, keep the direction
      }
    }
    const leading = leadMs > 0;
    this.px = p.x;
    this.py = p.y;
    this.tSample = time;
    this.wasFresh = fresh;
    this.rx = leading ? rx : 0;
    this.ry = leading ? ry : 0;
    this.leadMs = leadMs;
  }

  /** Jump to `p` with no glide and no velocity (first sight, or a different hand now drives this point). */
  snap(p: Vec2, time: number): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(time)) return;
    this.active = true;
    this.t = Math.max(this.t, time); // the render clock never runs backwards
    this.ax = this.bx = this.px = p.x;
    this.ay = this.by = this.py = p.y;
    this.tSample = time;
    this.wasFresh = true;
    this.dropLead();
    // A snap says nothing about the tracker's rate: keep the interval as a first guess
    // and let the next measured gap replace it.
    this.measured = false;
  }

  /**
   * The glided position at render time `time`, or null before the first result.
   * Call with non-decreasing time (an earlier time returns the latest position).
   * The follower is integrated in closed form between calls, so the path is the same
   * at any frame rate.
   */
  at(time: number): Vec2 | null {
    if (!this.active) return null;
    this.advance(time);
    return { x: this.bx, y: this.by };
  }

  /**
   * Velocity of the glided point (the slope of what `at` returns) at the last `at` time,
   * stage units per ms. Continuous, and zero once the point has come to rest.
   * Returns a new object on every read.
   */
  get velocity(): Vec2 {
    if (!this.active) return { x: 0, y: 0 };
    if (this.pole < MIN_POLE_MS) {
      const leading = this.t < this.tSample + this.leadMs;
      return { x: leading ? this.rx : 0, y: leading ? this.ry : 0 };
    }
    return { x: (this.ax - this.bx) / this.pole, y: (this.ay - this.by) / this.pole };
  }

  /** The time constant in use (both poles together), ms. */
  get tauMs(): number {
    return this.pole * 2;
  }

  /** Forget everything, including the measured tracking interval. */
  reset(): void {
    this.active = false;
    this.t = -Infinity;
    this.ax = this.ay = this.bx = this.by = 0;
    this.px = this.py = 0;
    this.tSample = 0;
    this.wasFresh = false;
    this.dropLead();
    this.interval = GLIDE_T.defaultIntervalMs;
    this.measured = false;
    this.pole = this.poleFor(this.interval);
  }

  private dropLead() {
    this.rx = 0;
    this.ry = 0;
    this.leadMs = 0;
  }

  private poleFor(interval: number): number {
    const o = this.options;
    return Math.max(0, clamp(o.tauFactor * interval, o.tauMinMs, o.tauMaxMs)) / 2;
  }

  /** Integrate the follower from its own time up to `to`. The target is a ramp while the lead grows, then constant. */
  private advance(to: number) {
    if (!Number.isFinite(to) || to <= this.t) return;
    const leadEnd = this.tSample + this.leadMs;
    if (this.t < leadEnd) {
      const end = Math.min(to, leadEnd);
      const led = this.t - this.tSample; // lead time already behind us; never negative, sample() brings `t` up to `tSample`
      this.step(end - this.t, this.px + this.rx * led, this.py + this.ry * led, this.rx, this.ry);
      this.t = end;
      if (!(to > end)) return;
    }
    this.step(to - this.t, this.px + this.rx * this.leadMs, this.py + this.ry * this.leadMs, 0, 0);
    this.t = to;
  }

  /**
   * Exact solution of the two cascaded poles over `dt` for a target that starts at
   * (tx, ty) and moves at (rx, ry) per ms. Because it is exact, two half steps equal one
   * whole step, which is what makes at() frame-rate independent.
   */
  private step(dt: number, tx: number, ty: number, rx: number, ry: number) {
    const tau = this.pole;
    if (tau < MIN_POLE_MS) {
      this.ax = this.bx = tx + rx * dt;
      this.ay = this.by = ty + ry * dt;
      return;
    }
    const n = dt / tau;
    const k = Math.exp(-n);
    const nk = n * k; // formed first so a very long step ends at 0, not at infinity × 0
    // Against a ramp the poles settle tau and 2·tau behind it. The distances from those
    // steady states decay like a critically damped pair: e1 = E1·k, e2 = (E2 + E1·n)·k.
    const e1x = this.ax - tx + rx * tau;
    const e2x = this.bx - tx + 2 * rx * tau;
    this.ax = tx + rx * (dt - tau) + e1x * k;
    this.bx = tx + rx * (dt - 2 * tau) + e2x * k + e1x * nk;
    const e1y = this.ay - ty + ry * tau;
    const e2y = this.by - ty + 2 * ry * tau;
    this.ay = ty + ry * (dt - tau) + e1y * k;
    this.by = ty + ry * (dt - 2 * tau) + e2y * k + e1y * nk;
  }
}
