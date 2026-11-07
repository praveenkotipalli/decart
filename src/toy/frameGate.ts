/**
 * The two-L gate: decides when the hand frame exists.
 *
 * The frame exists only while BOTH hands hold an L. The gate turns a stream of per-result
 * hand poses (5–17 Hz, with dropped results and hands wandering out of the picture) into a
 * phase that does not flicker: two agreeing results to open, a few hundred milliseconds of
 * disagreement to close, floors on both states, and a one-result warm re-entry so a frame
 * that just closed for a non-deliberate reason comes straight back.
 *
 * Pure: plain data and a timestamp in, a phase out. `update` runs once per tracking result,
 * `tick` once per render frame (it only watches for a stalled tracker).
 */
import type { Vec2 } from "../geometry/vec";
import { POSE_T } from "../gestures/poses";
import type { HandPose } from "./types";

export type GatePhase = "idle" | "arming" | "open";
/** Why the frame last closed; null until it has closed once (or after reset). */
export type CloseReason = "release" | "pose" | "lost" | "stall" | null;

/** One role's hand for one tracking result, as the gate sees it. */
export interface GateHand {
  /** The assigner still tracks this role (its 450 ms grace included). */
  present: boolean;
  /** Observed in this result (false while coasting through a dropout). */
  fresh: boolean;
  pose: HandPose | null;
  /** Palm centre, stage space. */
  palm: Vec2 | null;
}

export interface GateOptions {
  /** Consecutive good results that open the frame from cold. */
  onResults: number;
  /** A close less than this long ago (for a reason other than release) re-opens on one good result, ms. */
  warmMs: number;
  /** Closes after this long without an L on either hand, ms… */
  offMs: number;
  /** …or this long when that hand has been edge-on (|cPalm| < facingMin) the whole time, ms. */
  edgeOnMs: number;
  /** Consecutive palm / fist / OK results that close the frame deliberately. */
  releaseResults: number;
  /** No tracking result for this long closes the frame (checked by tick), ms. */
  stallMs: number;
  /** The frame never closes sooner than this after opening, ms. */
  minOpenMs: number;
  /** The frame never re-opens sooner than this after closing, ms. */
  minClosedMs: number;
  /** Palm centres closer than this (frame heights) are one hand seen twice, not a frame: do not arm. */
  minSeparation: number;
}

export const DEFAULT_GATE: GateOptions = {
  onResults: 2,
  warmMs: 1500,
  offMs: 350,
  edgeOnMs: 900,
  releaseResults: 2,
  stallMs: 1200,
  minOpenMs: 250,
  minClosedMs: 150,
  minSeparation: 0.12,
};

/** What the gate remembers about one role between results. */
interface RoleState {
  /** When the current run of trusted results without an L began; null while the hand holds its L. */
  notLSince: number | null;
  /** Every result of that run so far was edge-on (the hand is being turned, not opened). */
  edgeOnRun: boolean;
  /** Consecutive trusted results in a release pose (palm, fist, OK). */
  releaseStreak: number;
  /** Which side of the hand faced the camera while it last held an L (sign of cPalm); 0 = not seen flat yet. */
  lFacing: 1 | -1 | 0;
}

const freshRole = (): RoleState => ({ notLSince: null, edgeOnRun: false, releaseStreak: 0, lFacing: 0 });
const sign = (v: number): 1 | -1 | 0 => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** A result the gate can act on: the hand was seen in it and the classifier trusted what it saw. */
const trusted = (h: GateHand): h is GateHand & { pose: HandPose } => h.present && h.fresh && h.pose !== null && !h.pose.uncertain;

/** An L seen in this result (not held over from an earlier one). */
const good = (h: GateHand) => trusted(h) && h.pose.l;

export class FrameGate {
  phase: GatePhase = "idle";
  lastCloseReason: CloseReason = null;
  /** Time of the last opening; -Infinity before the first. */
  openedAt = -Infinity;
  /** Time of the last closing; -Infinity before the first. */
  closedAt = -Infinity;
  readonly options: GateOptions;

  /** Consecutive results in which both hands were good and far enough apart. */
  private goodStreak = 0;
  private lastResultAt = -Infinity;
  private readonly roles: [RoleState, RoleState] = [freshRole(), freshRole()];

  constructor(options: Partial<GateOptions> = {}) {
    this.options = { ...DEFAULT_GATE, ...options };
  }

  /**
   * One tracking result. `a` is the screen-left role, `b` the screen-right one; `aspect` is
   * camera width / height, so palm separation can be measured in frame heights.
   */
  update(time: number, a: GateHand, b: GateHand, aspect: number): GatePhase {
    const o = this.options;
    this.lastResultAt = time;

    const apart =
      a.palm !== null && b.palm !== null && Math.hypot((a.palm.x - b.palm.x) * aspect, a.palm.y - b.palm.y) >= o.minSeparation;
    const both = good(a) && good(b) && apart;
    this.goodStreak = both ? this.goodStreak + 1 : 0;

    this.track(this.roles[0], a, time);
    this.track(this.roles[1], b, time);

    if (this.phase === "open") {
      const reason = this.closeReason(a, b, time);
      // The floor delays a close rather than cancelling it: the condition is re-read every result.
      if (reason !== null && time - this.openedAt >= o.minOpenMs) this.close(time, reason);
      return this.phase;
    }

    if (!both) {
      this.phase = "idle";
      return this.phase;
    }
    // A frame that closed a moment ago because a hand wavered (not because it was opened on
    // purpose) is still wanted: one good result brings it back.
    const warm = this.lastCloseReason !== null && this.lastCloseReason !== "release" && time - this.closedAt < o.warmMs;
    const needed = warm ? 1 : o.onResults;
    if (this.goodStreak >= needed && time - this.closedAt >= o.minClosedMs) {
      this.phase = "open";
      this.openedAt = time;
    } else {
      this.phase = "arming";
    }
    return this.phase;
  }

  /** Once per render frame: a tracker that has gone quiet lets the frame go. */
  tick(time: number): GatePhase {
    if (this.phase !== "idle" && time - this.lastResultAt >= this.options.stallMs) {
      if (this.phase === "open") this.close(time, "stall");
      else {
        this.phase = "idle";
        this.goodStreak = 0;
      }
    }
    return this.phase;
  }

  reset(): void {
    this.phase = "idle";
    this.lastCloseReason = null;
    this.openedAt = -Infinity;
    this.closedAt = -Infinity;
    this.goodStreak = 0;
    this.lastResultAt = -Infinity;
    this.roles[0] = freshRole();
    this.roles[1] = freshRole();
  }

  /** Advance one role's timers with this result. Coasting and untrusted results change nothing. */
  private track(r: RoleState, h: GateHand, time: number): void {
    if (!h.present) {
      // Whatever the next track of this role does starts from a clean slate.
      r.notLSince = null;
      r.edgeOnRun = false;
      r.releaseStreak = 0;
      r.lFacing = 0;
      return;
    }
    if (!h.fresh) return;
    const p = h.pose;
    if (p !== null && p.uncertain) return;
    const flat = p !== null && Math.abs(p.cPalm) >= POSE_T.facingMin;
    if (p !== null && p.l) {
      r.notLSince = null;
      r.edgeOnRun = false;
      r.releaseStreak = 0;
      if (flat) r.lFacing = sign(p.cPalm);
      return;
    }
    // Edge-on, the fingers project onto almost nothing and the L cannot be read: a hand being
    // turned over looks like this for a few hundred milliseconds, so it gets longer.
    if (r.notLSince === null) {
      r.notLSince = time;
      r.edgeOnRun = !flat;
    } else r.edgeOnRun = r.edgeOnRun && !flat;
    // A release is the hand opening (or closing, or making an OK) towards the camera, the way
    // it faced as an L. A "palm" read off a hand that is edge-on or turned over is what a loosely
    // curled L looks like from a steep angle (real hands: 5–14 % of results at extreme views),
    // so it does not count; such a hand still closes the frame through the no-L rule.
    const deliberate = flat && (r.lFacing === 0 || sign(p.cPalm) === r.lFacing);
    r.releaseStreak = deliberate && (p.palm || p.fist || p.ok) ? r.releaseStreak + 1 : 0;
  }

  private closeReason(a: GateHand, b: GateHand, time: number): CloseReason {
    const o = this.options;
    if (!a.present || !b.present) return "lost";
    for (const r of this.roles) if (r.releaseStreak >= o.releaseResults) return "release";
    for (const r of this.roles) {
      if (r.notLSince !== null && time - r.notLSince >= (r.edgeOnRun ? o.edgeOnMs : o.offMs)) return "pose";
    }
    return null;
  }

  private close(time: number, reason: CloseReason): void {
    this.phase = "idle";
    this.closedAt = time;
    this.lastCloseReason = reason;
    this.goodStreak = 0;
  }
}
