import type { Vec2 } from "../geometry/vec";

/**
 * One Euro filter (Casiez, Roussel, Vogel — CHI 2012): a low-pass filter whose
 * cutoff rises with speed. Slow hands get heavy smoothing (no jitter), fast hands
 * get little (no lag). This 2D variant uses the speed of the point, not of each
 * axis, so diagonal motion is treated the same as horizontal.
 */
export interface OneEuroParams {
  /** Cutoff at rest, Hz. Lower = smoother, laggier when still. */
  minCutoff: number;
  /** How quickly the cutoff rises with speed (per stage-unit/s). Higher = less lag on fast moves. */
  beta: number;
  /** Cutoff for the speed estimate itself, Hz. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.2, beta: 6, dCutoff: 1.0 };

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro2D {
  private x: Vec2 | null = null;
  private dx: Vec2 = { x: 0, y: 0 };
  private t = 0;

  constructor(public params: OneEuroParams = DEFAULT_ONE_EURO) {}

  /** @param tMs monotonic timestamp in milliseconds */
  filter(p: Vec2, tMs: number): Vec2 {
    if (!this.x) {
      this.x = { ...p };
      this.t = tMs;
      return { ...p };
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-4);
    this.t = tMs;
    const { minCutoff, beta, dCutoff } = this.params;

    const ad = alpha(dCutoff, dt);
    const rawDx = (p.x - this.x.x) / dt;
    const rawDy = (p.y - this.x.y) / dt;
    this.dx = { x: this.dx.x + ad * (rawDx - this.dx.x), y: this.dx.y + ad * (rawDy - this.dx.y) };

    const speed = Math.hypot(this.dx.x, this.dx.y);
    const a = alpha(minCutoff + beta * speed, dt);
    this.x = { x: this.x.x + a * (p.x - this.x.x), y: this.x.y + a * (p.y - this.x.y) };
    return { ...this.x };
  }

  /** Jumps to a value without smoothing (e.g. after re-acquiring a lost hand). */
  reset(p?: Vec2, tMs = 0) {
    this.x = p ? { ...p } : null;
    this.dx = { x: 0, y: 0 };
    this.t = tMs;
  }

  get value(): Vec2 | null {
    return this.x ? { ...this.x } : null;
  }
}
