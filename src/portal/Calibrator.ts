import { centroid, classifyQuad, signedArea } from "../geometry/quad";
import type { Quad, Vec2 } from "../geometry/vec";
import type { TrackingMode } from "../tracking/handAssignment";

export type CalibrationState = "idle" | "waiting" | "holding" | "done" | "failed";

export interface CalibrationResult {
  /** Where reset sends the portal: the pose you held. */
  home: Quad;
  /** Your pose has this hand's top and bottom fingers the other way round. */
  swapA: boolean;
  swapB: boolean;
  /** Fingertip jitter while holding still, stage units (RMS). */
  noise: number;
  /** One Euro min-cutoff tuned to that jitter. */
  suggestedMinCutoff: number;
  at: number;
}

const HOLD_MS = 1600;
const TIMEOUT_MS = 25_000;
/** Max centroid speed (stage units/s) that still counts as "holding still". */
const MAX_DRIFT_SPEED = 0.35;
const MIN_AREA = 0.01;

/** Maps measured jitter to a smoothing cutoff: steady hands get a crisper filter. */
export function cutoffForNoise(noise: number): number {
  const lo = 0.0015;
  const hi = 0.006;
  const t = Math.min(1, Math.max(0, (noise - lo) / (hi - lo)));
  return +(1.6 + (0.5 - 1.6) * t).toFixed(2);
}

/**
 * Guided calibration: hold your portal pose still for ~1.6 s. Learns which of
 * each hand's fingers sits on top in *your* pose, your neutral portal (the reset
 * target), and your tracking jitter (to tune smoothing).
 */
export class Calibrator {
  state: CalibrationState = "idle";
  progress = 0;
  message = "";
  result: CalibrationResult | null = null;

  private startedAt = 0;
  private holdStart = 0;
  private samples: { t: number; q: Quad; swapA: boolean; swapB: boolean }[] = [];
  private lastCentroid: { t: number; c: Vec2 } | null = null;

  start(t: number) {
    this.state = "waiting";
    this.progress = 0;
    this.samples = [];
    this.result = null;
    this.startedAt = t;
    this.lastCentroid = null;
    this.message = "Raise both hands in your portal pose";
  }

  cancel() {
    this.state = "idle";
    this.progress = 0;
  }

  /** @param raw unfiltered fingertip corners in mapping order (P1..P4), null when missing */
  update(t: number, raw: (Vec2 | null)[], mode: TrackingMode) {
    if (this.state !== "waiting" && this.state !== "holding") return;
    if (t - this.startedAt > TIMEOUT_MS) {
      this.state = "failed";
      this.message = "Couldn't see a steady portal pose. Try again with good light.";
      return;
    }
    if (!raw.every(Boolean)) {
      this.toWaiting(mode === "two-hand" ? "Raise both hands in your portal pose" : "Raise one spread hand");
      return;
    }
    let q = raw.map((p) => ({ ...p! })) as Quad;

    // Which way up is each hand? Top corners should be above their bottom partners.
    let swapA = false;
    let swapB = false;
    if (mode === "two-hand") {
      swapA = q[0].y > q[3].y;
      swapB = q[1].y > q[2].y;
      if (swapA) q = [q[3], q[1], q[2], q[0]];
      if (swapB) q = [q[0], q[2], q[1], q[3]];
    }
    if (classifyQuad(q, MIN_AREA) !== "valid" || signedArea(q) <= 0) {
      this.toWaiting("Spread your fingers into a clear four-cornered frame");
      return;
    }

    const c = centroid(q);
    if (this.lastCentroid) {
      const dt = Math.max((t - this.lastCentroid.t) / 1000, 1e-3);
      const speed = Math.hypot(c.x - this.lastCentroid.c.x, c.y - this.lastCentroid.c.y) / dt;
      if (speed > MAX_DRIFT_SPEED) {
        this.lastCentroid = { t, c };
        this.toWaiting("Hold still…");
        return;
      }
    }
    this.lastCentroid = { t, c };

    if (this.state === "waiting") {
      this.state = "holding";
      this.holdStart = t;
      this.samples = [];
    }
    this.message = "Hold still…";
    this.samples.push({ t, q, swapA, swapB });
    this.progress = Math.min(1, (t - this.holdStart) / HOLD_MS);
    if (this.progress >= 1 && this.samples.length >= 8) this.finish(t);
  }

  private toWaiting(message: string) {
    if (this.state === "holding") this.samples = [];
    this.state = "waiting";
    this.progress = 0;
    this.message = message;
  }

  private finish(t: number) {
    const n = this.samples.length;
    const home = [0, 1, 2, 3].map((i) => ({
      x: this.samples.reduce((s, x) => s + x.q[i].x, 0) / n,
      y: this.samples.reduce((s, x) => s + x.q[i].y, 0) / n,
    })) as Quad;
    let sq = 0;
    for (const s of this.samples)
      for (let i = 0; i < 4; i++) sq += (s.q[i].x - home[i].x) ** 2 + (s.q[i].y - home[i].y) ** 2;
    const noise = Math.sqrt(sq / (n * 4));
    const majority = (k: "swapA" | "swapB") => this.samples.filter((s) => s[k]).length > n / 2;

    this.result = {
      home,
      swapA: majority("swapA"),
      swapB: majority("swapB"),
      noise,
      suggestedMinCutoff: cutoffForNoise(noise),
      at: t,
    };
    this.state = "done";
    this.message = "Calibrated";
  }
}
