/**
 * Effect 4, "fog": the picture is misted glass; hands wipe it clear and the mist creeps back.
 *
 * The renderer owns the wipe mask (a small target where 1 = wiped clear, kept with MAX
 * blending) and recovers it by subtracting a constant on every "decay step". This class
 * decides what to wipe and how many steps are due: one per elapsed 110 ms, so a frame rate
 * that wavers or stalls changes nothing about how long the glass takes to mist over
 * again (about 7 s), only how many steps a single frame has to catch up on.
 *
 * Pure: time is an argument, nothing is random.
 */
import { LM } from "../../tracking/landmarks";
import type { HandKinematics, PoseName, StampBuffer } from "../types";
import { pushWipe } from "./stamps";

export const FOG = {
  /** One recovery step (4/255 subtracted from the mask) every this many ms. */
  decayStepMs: 110,
  /** What one step subtracts from the mask: 64 steps take a wiped pixel back to full fog. */
  decayPerStep: 4 / 255,
  /**
   * Steps reported for a single frame at most. 64 steps already restore the mist completely;
   * stamping more after a long pause would cost full-screen passes for nothing.
   */
  maxStepsPerFrame: Math.ceil(255 / 4),
  /** The fog fades in over this long after the effect is selected, ms. */
  fadeInMs: 800,
  /** Radius of an open hand's wipe as a multiple of the hand scale s2 (frame heights). */
  palmRadius: 0.5,
  /** Radius of a pointing finger's wipe, frame heights (about 14 px at 720p). */
  tipRadius: 0.02,
  /** A hand that moved further than this in one frame was re-acquired elsewhere: dot there, no smear across the picture, frame heights. */
  jumpBreak: 0.25,
  /** Camera aspect assumed until the caller says otherwise (the app's cameras are 16:9). */
  defaultAspect: 16 / 9,
} as const;

type WipeKind = "palm" | "tip";

/** Where a hand's wipe ended last frame. */
interface Trail {
  kind: WipeKind;
  x: number;
  y: number;
  stamp: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep01 = (v: number) => {
  const s = clamp01(v);
  return s * s * (3 - 2 * s);
};

export class FogEffect {
  /** When the effect was selected, ms; -Infinity = never (then the fog is simply there). */
  private enteredAt = -Infinity;
  /** Time the recovery clock has been settled up to, ms; null until the first advance. */
  private decayedTo: number | null = null;
  private pendingReset = false;
  private readonly trails = new Map<number, Trail>();
  private aspect: number = FOG.defaultAspect;
  private stamp = 0;

  /** The effect was selected: the glass starts fully fogged and the fog fades in. */
  enter(time: number): void {
    this.enteredAt = time;
    this.decayedTo = time;
    this.pendingReset = true;
    this.trails.clear();
  }

  /** Re-fog at once (the `c` key). Reported through the next advance's `reset` flag. */
  reset(): void {
    this.pendingReset = true;
  }

  /**
   * One render frame. Stamps the wipes of every fresh hand along its glided path into `out`
   * (palm centre, radius 0.5 × s2, unless the pose is point: then the index tip at 0.02 frame
   * heights) and reports the recovery steps due, whether to re-fog first, and the fog amount.
   * Call with non-decreasing time. `aspect` (camera width / height) makes the jump test isotropic.
   */
  advance(
    time: number,
    hands: HandKinematics[],
    poses: ReadonlyMap<number, PoseName | null>,
    out: StampBuffer,
    aspect = this.aspect,
  ): { decaySteps: number; reset: boolean; density: number } {
    if (aspect > 0) this.aspect = aspect;

    // Recovery clock: whole steps since the last settlement; the remainder carries over.
    if (this.decayedTo === null || time < this.decayedTo) this.decayedTo = time;
    let decaySteps = Math.floor((time - this.decayedTo) / FOG.decayStepMs);
    if (decaySteps >= FOG.maxStepsPerFrame) {
      decaySteps = FOG.maxStepsPerFrame;
      this.decayedTo = time; // the backlog is pointless past full recovery: drop it
    } else {
      this.decayedTo += decaySteps * FOG.decayStepMs;
    }

    const reset = this.pendingReset;
    this.pendingReset = false;
    if (reset) {
      decaySteps = 0; // a freshly fogged mask has nothing to recover
      this.decayedTo = time;
    }

    const density = Number.isFinite(this.enteredAt) ? smoothstep01((time - this.enteredAt) / FOG.fadeInMs) : 1;

    const stamp = ++this.stamp;
    for (const hand of hands) {
      if (!hand.fresh) continue;
      const point = poses.get(hand.id) === "point";
      const kind: WipeKind = point ? "tip" : "palm";
      const p = point ? hand.points[LM.INDEX_TIP] : hand.palm;
      const radius = point ? FOG.tipRadius : FOG.palmRadius * hand.s2;
      let trail = this.trails.get(hand.id);
      // A new hand, a changed kind of wipe or a jump starts with a dot; otherwise the wipe joins last frame's end.
      const joined = trail !== undefined && trail.kind === kind && Math.hypot((p.x - trail.x) * this.aspect, p.y - trail.y) <= FOG.jumpBreak;
      if (joined && trail) pushWipe(out, trail.x, trail.y, p.x, p.y, radius);
      else pushWipe(out, p.x, p.y, p.x, p.y, radius);
      if (!trail) {
        trail = { kind, x: p.x, y: p.y, stamp };
        this.trails.set(hand.id, trail);
      } else {
        trail.kind = kind;
        trail.x = p.x;
        trail.y = p.y;
        trail.stamp = stamp;
      }
    }
    for (const [id, trail] of this.trails) if (trail.stamp !== stamp) this.trails.delete(id);

    return { decaySteps, reset, density };
  }
}
