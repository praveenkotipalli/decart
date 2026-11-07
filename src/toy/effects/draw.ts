/**
 * Effect 2, "draw": a pointing finger is a pen that leaves light ribbons on the picture.
 *
 * Two clocks feed this class. Tracking results (5–17 Hz) decide the pen state per hand:
 * down while the pose is point or L, confirmed on the second consecutive result, up after
 * a while without or at once on an open hand or a fist. Render frames (60 Hz) move the
 * pen along the glided index tip and stamp one capsule per frame, so a stroke is one
 * continuous line at any tracking rate. What was drawn between the first qualifying result
 * and the confirming one is withheld in the ribbon and back-filled on confirmation, so
 * the start of a stroke is not lost to the confirmation delay.
 *
 * No GL here: `advance` fills a StampBuffer that the renderer paints into the ink layer.
 * Pure: times come in as arguments; there is no randomness.
 */
import { OneEuro2D, type OneEuroParams } from "../../tracking/oneEuro";
import { LM } from "../../tracking/landmarks";
import type { HandKinematics, HandPose, HandRole, HandSample, StampBuffer } from "../types";
import { HoldGesture } from "./hold";
import { InkRibbon, inkColor } from "./stamps";

export const PEN = {
  /** Consecutive qualifying fresh results that put the pen down (the first one is back-filled). */
  downResults: 2,
  /** The pen lifts this long after the last qualifying result: classification flicker is bridged, ms. */
  upMs: 250,
  /**
   * Two qualifying results further apart than this (the tracker stalled or lost the hand for a
   * while) do not continue a stroke: the pen lifts and starts over, ms. Same bound as the glide's
   * own stall limit, so the ink never follows a follower that has given up on continuity.
   */
  gapMaxMs: 500,
  /** The tip moving further than this in one step is a jump (re-acquired elsewhere), not a stroke, frame heights. */
  jumpBreak: 0.25,
  /** After a jump the glided tip has to come this close to the newest observation before ink restarts, frame heights ... */
  settleDist: 0.04,
  /** ... or this long has to pass, ms (a hand that keeps moving fast never "settles" by distance). */
  settleMaxMs: 300,
  /** Holding a fist this long wipes the picture, ms. */
  clearHoldMs: 700,
  /** One Euro smoothing of the index tip (design: 1.8 Hz, beta 8): jitter off slow strokes, little lag on fast ones. */
  smoothing: { minCutoff: 1.8, beta: 8, dCutoff: 1 } as OneEuroParams,
  /** Camera aspect assumed until the caller says otherwise (the app's cameras are 16:9). */
  defaultAspect: 16 / 9,
} as const;

/** Point or L: index out, at least two of the other three curled, no pinch (poses.ts applies the hysteresis). */
export const penPose = (pose: HandPose): boolean => (pose.point || pose.l) && !pose.ok;

/** An open hand or a fist lifts the pen at once. */
export const liftPose = (pose: HandPose): boolean => pose.palm || pose.fist;

type PenState = "up" | "pending" | "down";

/** Everything remembered about one hand id. */
class Pen {
  role: HandRole;
  state: PenState = "up";
  /** Result time of the last qualifying fresh result, ms. */
  lastQualAt = -Infinity;
  /** Qualifying fresh results in a row in the current attempt. */
  qualRun = 0;
  /** Index tip of the last fresh observation (raw, stage space): jumps are spotted here. */
  hasObs = false;
  obsX = 0;
  obsY = 0;
  /** Glided tip of the previous render frame (before smoothing). */
  hasGlide = false;
  glideX = 0;
  glideY = 0;
  /** Set after a jump: no ink until the glide has caught up with the new observation. */
  relocating = false;
  settleUntil = 0;
  /** The latest fresh result is a fist; the hold runs while it stays one. */
  fist = false;
  holdProgress = 0;
  /** The id has left the tracking results; the pen only drains what it still owes. */
  gone = false;
  /** Stamp of the last update() that contained this id. */
  stamp = 0;
  readonly filter = new OneEuro2D(PEN.smoothing);
  readonly ribbon = new InkRibbon();
  readonly hold = new HoldGesture(PEN.clearHoldMs);

  constructor(role: HandRole) {
    this.role = role;
  }
}

/** Isotropic length of a stage delta, frame heights. */
const fh = (dx: number, dy: number, aspect: number) => Math.hypot(dx * aspect, dy);

export class DrawEffect {
  private readonly pens = new Map<number, Pen>();
  private aspect: number = PEN.defaultAspect;
  private stamp = 0;
  private pendingClear = false;
  private strokeCount = 0;

  /** Strokes stamped so far (a cleared picture does not reset the count). */
  get strokes(): number {
    return this.strokeCount;
  }

  /**
   * One tracking result: every hand the assigner tracks, coasting ones included. `aspect`
   * (camera width / height) makes the jump test isotropic; it is remembered for `advance`.
   */
  update(time: number, hands: HandSample[], aspect = this.aspect): void {
    if (aspect > 0) this.aspect = aspect;
    const stamp = ++this.stamp;
    for (const hand of hands) {
      let pen = this.pens.get(hand.id);
      if (!pen) {
        pen = new Pen(hand.role);
        this.pens.set(hand.id, pen);
      } else if (pen.stamp === stamp) {
        continue; // the same id twice in one result: keep the first
      }
      pen.stamp = stamp;
      pen.gone = false;
      pen.role = hand.role;

      if (!hand.fresh) {
        // A coasting hand repeats its last observation: nothing new to decide on, but the
        // pen-up clock keeps running, so a hand that left the picture lifts the pen.
        if (pen.state !== "up" && time - pen.lastQualAt > PEN.upMs) this.lift(pen);
        this.tickHold(pen, time);
        continue;
      }

      const tip = hand.points[LM.INDEX_TIP];
      if (pen.hasObs && fh(tip.x - pen.obsX, tip.y - pen.obsY, this.aspect) > PEN.jumpBreak) this.jump(pen, time);
      pen.hasObs = true;
      pen.obsX = tip.x;
      pen.obsY = tip.y;

      const pose = hand.pose;
      if (penPose(pose)) {
        if (pen.state === "down" && time - pen.lastQualAt > PEN.gapMaxMs) this.lift(pen);
        pen.lastQualAt = time;
        if (pen.state === "up") {
          pen.state = "pending";
          pen.qualRun = 1;
        } else if (pen.state === "pending" && ++pen.qualRun >= PEN.downResults) {
          pen.state = "down";
          pen.ribbon.commit(); // back-fill: what was drawn since the first qualifying result is ink
        }
      } else if (pen.state === "pending") {
        this.lift(pen); // not consecutive: the attempt is over
      } else if (pen.state === "down" && (liftPose(pose) || time - pen.lastQualAt > PEN.upMs)) {
        this.lift(pen);
      }

      pen.fist = pose.fist;
      this.tickHold(pen, time);
    }

    // Ids that are no longer tracked: the stroke ends now; the pen stays only to drain its backlog.
    for (const pen of this.pens.values()) {
      if (pen.stamp === stamp || pen.gone) continue;
      this.lift(pen);
      pen.gone = true;
      pen.hasObs = false;
      pen.hasGlide = false;
      pen.relocating = false;
      pen.fist = false;
      pen.hold.reset();
      pen.holdProgress = 0;
    }
  }

  /**
   * One render frame: moves every pen along its glided index tip (`hands[i].points[8]`) and
   * stamps the ink due this frame into `out`. Call with non-decreasing time.
   */
  advance(time: number, hands: HandKinematics[], out: StampBuffer): void {
    const aspect = this.aspect;
    for (const [id, pen] of this.pens) {
      let kin: HandKinematics | null = null;
      for (let i = 0; i < hands.length; i++) {
        if (hands[i].id === id) {
          kin = hands[i];
          break;
        }
      }
      if (!kin) {
        // Nothing to follow; stamp what is still owed and let a departed hand go.
        this.strokeCount += pen.ribbon.drain(out, inkColor(pen.role), aspect);
        if (pen.gone && pen.ribbon.backlog === 0) this.pens.delete(id);
        continue;
      }
      pen.role = kin.role;
      this.tickHold(pen, time);

      const raw = kin.points[LM.INDEX_TIP];
      // A step of a quarter of the picture between two frames is never a hand drawing (a snapped
      // follower, a very long frame): the stroke breaks here too.
      if (pen.hasGlide && fh(raw.x - pen.glideX, raw.y - pen.glideY, aspect) > PEN.jumpBreak) this.jump(pen, time);
      pen.hasGlide = true;
      pen.glideX = raw.x;
      pen.glideY = raw.y;

      // The smoothing runs whether the pen is down or not, so the first point of a stroke is not a cold start.
      let p = pen.filter.filter(raw, time);
      if (pen.relocating) {
        const settled = time >= pen.settleUntil || (pen.hasObs && fh(raw.x - pen.obsX, raw.y - pen.obsY, aspect) < PEN.settleDist);
        if (!settled) {
          this.strokeCount += pen.ribbon.drain(out, inkColor(pen.role), aspect);
          continue;
        }
        pen.relocating = false;
        pen.filter.reset(raw, time);
        p = raw;
      }
      if (pen.state !== "up") pen.ribbon.add(p.x, p.y, pen.state === "down", aspect);
      this.strokeCount += pen.ribbon.drain(out, inkColor(pen.role), aspect);
    }
  }

  /** Wipe the picture (the `c` key, or a fist held long enough). Pens keep drawing afterwards. */
  clear(): void {
    this.pendingClear = true;
    for (const pen of this.pens.values()) pen.ribbon.clear();
  }

  /** True once after each clear(): the scene's `ink.clear` flag. */
  consumeClear(): boolean {
    const c = this.pendingClear;
    this.pendingClear = false;
    return c;
  }

  /** 0..1 progress of the fist hold of hand `handId` (the hold ring), 0 when there is none. */
  holdProgress(handId: number): number {
    return this.pens.get(handId)?.holdProgress ?? 0;
  }

  /** Forget every pen (effect switched, tracking restarted). Ink already on the picture stays. */
  reset(): void {
    this.pens.clear();
  }

  private lift(pen: Pen): void {
    if (pen.state === "pending") pen.ribbon.discard();
    else if (pen.state === "down") pen.ribbon.breakStroke();
    pen.state = "up";
    pen.qualRun = 0;
  }

  /** The tip was re-acquired somewhere else: end the stroke here and wait for the glide to arrive there. */
  private jump(pen: Pen, time: number): void {
    if (pen.state === "pending") {
      // The withheld points are from before the jump; the attempt continues from the new place.
      pen.ribbon.discard();
    } else {
      pen.ribbon.breakStroke();
    }
    pen.relocating = true;
    pen.settleUntil = time + PEN.settleMaxMs;
  }

  /** Both clocks feed the same hold, so it fires within a frame of the time and releases on the next result. */
  private tickHold(pen: Pen, time: number): void {
    const r = pen.hold.update(time, pen.fist);
    pen.holdProgress = r.progress;
    if (r.fired) this.clear();
  }
}
