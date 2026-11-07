/**
 * The OK-sign loupe: a round window through the thumb–index ring that shows the treated
 * picture magnified. One per hand, at most two.
 *
 * Switching is by results, not by one frame: on after two consecutive OK results, off after
 * two results with the pinch opened, 250 ms without an OK, or the track gone. The centre is
 * the ring centroid through a OneEuro filter and then a PointGlide follower, so it moves
 * every render frame; the radius follows the hand size (the ring's own radius is too noisy)
 * through a slow low-pass.
 *
 * Pure: per tracking result and per render frame, plain data in and out.
 */
import type { Vec2 } from "../geometry/vec";
import { POSE_T } from "../gestures/poses";
import { PointGlide } from "../tracking/glide";
import { LM } from "../tracking/landmarks";
import { OneEuro2D, type OneEuroParams } from "../tracking/oneEuro";
import type { HandSample, LoupeSnapshot } from "./types";

export const LOUPE_T = {
  /** Consecutive OK results that switch a loupe on. */
  onResults: 2,
  /** Consecutive results with the pinch opened past `pinchOff` that switch it off… */
  offResults: 2,
  pinchOff: POSE_T.pinchStay,
  /** …or this long without an OK result, ms. */
  offMs: 250,
  /** Radius = clamp(radiusK × hand size, radiusMin, radiusMax), frame heights… */
  radiusK: 0.9,
  radiusMin: 0.08,
  radiusMax: 0.22,
  /** …low-passed with this time constant, ms. */
  radiusTauMs: 120,
  /** Opacity fades: time to reach about 95 % of the target, ms. */
  fadeInMs: 90,
  fadeOutMs: 140,
  /** Smoothing of the ring centre before the follower. */
  centre: { minCutoff: 1.5, beta: 8, dCutoff: 1 } as OneEuroParams,
  /** Default and bounds of the magnification. */
  zoom: 2,
  zoomMin: 1.5,
  zoomMax: 3,
  /** Loupes shown at once. */
  max: 2,
} as const;

/** Below this a fade has arrived. */
const SETTLED = 0.002;
/** Fades are exponential; the option gives the time to ~95 %, which is three time constants. */
const TAU_PER_FADE = 1 / 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Everything remembered about one hand. */
class Loupe {
  on = false;
  okStreak = 0;
  offStreak = 0;
  lastOkAt = -Infinity;
  present = true;
  /** The result the loupe switched on at: ties between loupes are broken by age. */
  onSince = -Infinity;
  visibility = 0;
  readonly filter = new OneEuro2D(LOUPE_T.centre);
  readonly glide = new PointGlide();
  /** Last filtered centre, fed back to the follower while the hand coasts. */
  centre: Vec2 | null = null;
  /** Radius target (frame heights) and the low-passed value shown. */
  radiusTarget = 0;
  radius = 0;

  constructor(readonly id: number) {}
}

export class LoupeController {
  private zoom: number = LOUPE_T.zoom;
  private readonly loupes = new Map<number, Loupe>();
  private lastSnapshotAt = -Infinity;

  constructor(options: { zoom?: number } = {}) {
    if (options.zoom !== undefined) this.setZoom(options.zoom);
  }

  /** Magnification inside the loupe; the setting's range is 1.5–3. */
  setZoom(zoom: number): void {
    if (Number.isFinite(zoom)) this.zoom = clamp(zoom, LOUPE_T.zoomMin, LOUPE_T.zoomMax);
  }

  /**
   * One tracking result: every hand the assigner tracks. `enabled` is false outside effect
   * "frame", where loupes do not exist (any shown fade out).
   */
  update(time: number, hands: HandSample[], enabled: boolean, _aspect: number): void {
    const T = LOUPE_T;
    for (const l of this.loupes.values()) l.present = false;

    for (const h of hands) {
      let l = this.loupes.get(h.id);
      if (!l) {
        l = new Loupe(h.id);
        this.loupes.set(h.id, l);
      }
      l.present = true;
      if (!enabled) {
        l.on = false;
        l.okStreak = l.offStreak = 0;
        continue;
      }
      if (!h.fresh || h.pose.uncertain) {
        // Nothing new was seen: hold the streaks, let the follower settle, and let the
        // 250 ms clock run (a hand that stays unseen is not holding an OK sign).
        if (l.centre !== null) l.glide.sample(l.centre, time, false);
        if (l.on && time - l.lastOkAt >= T.offMs) l.on = false;
        continue;
      }
      const pose = h.pose;
      if (pose.ok) {
        l.okStreak++;
        l.lastOkAt = time;
      } else l.okStreak = 0;
      l.offStreak = pose.pinchRatio > T.pinchOff ? l.offStreak + 1 : 0;

      if (!l.on && l.okStreak >= T.onResults) {
        l.on = true;
        l.onSince = time;
      } else if (l.on && (l.offStreak >= T.offResults || time - l.lastOkAt >= T.offMs)) {
        l.on = false;
      }

      // Geometry runs on every trusted result, so the loupe is settled when it switches on.
      const raw = pose.ring?.center ?? ringFallback(h);
      const centre = l.filter.filter(raw, time);
      l.centre = centre;
      l.glide.sample(centre, time, true);
      l.radiusTarget = clamp(T.radiusK * pose.s2, T.radiusMin, T.radiusMax);
      if (l.radius === 0) l.radius = l.radiusTarget;
    }

    // A hand the assigner no longer tracks takes its loupe with it (it fades out below).
    for (const l of this.loupes.values()) if (!l.present) l.on = false;
  }

  /** Once per render frame, with non-decreasing time. At most two loupes, the visible ones. */
  snapshot(time: number): LoupeSnapshot[] {
    const T = LOUPE_T;
    const dt = Number.isFinite(this.lastSnapshotAt) ? Math.max(0, time - this.lastSnapshotAt) : 0;
    this.lastSnapshotAt = time;

    const out: { l: Loupe; s: LoupeSnapshot }[] = [];
    for (const l of this.loupes.values()) {
      const target = l.on ? 1 : 0;
      const tau = (l.on ? T.fadeInMs : T.fadeOutMs) * TAU_PER_FADE;
      if (dt > 0) l.visibility += (target - l.visibility) * (1 - Math.exp(-dt / tau));
      if (Math.abs(target - l.visibility) < SETTLED) l.visibility = target;
      if (dt > 0) l.radius += (l.radiusTarget - l.radius) * (1 - Math.exp(-dt / T.radiusTauMs));

      if (!l.present && l.visibility === 0) {
        this.loupes.delete(l.id);
        continue;
      }
      const center = l.glide.at(time);
      if (l.visibility === 0 || center === null) continue;
      out.push({ l, s: { handId: l.id, center, radius: l.radius, zoom: this.zoom, visibility: l.visibility } });
    }
    // Live loupes first, then the ones still fading; the oldest of the live ones wins a tie.
    out.sort((a, b) => Number(b.l.on) - Number(a.l.on) || b.s.visibility - a.s.visibility || a.l.onSince - b.l.onSince);
    return out.slice(0, T.max).map((e) => e.s);
  }

  reset(): void {
    this.loupes.clear();
    this.lastSnapshotAt = -Infinity;
  }
}

/** When the pose carries no ring: the middle of the pinch point and the thumb–index web. */
function ringFallback(h: HandSample): Vec2 {
  const p = h.points;
  const a = p[LM.THUMB_TIP];
  const b = p[LM.INDEX_TIP];
  const c = p[LM.THUMB_MCP];
  const d = p[LM.INDEX_MCP];
  return { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 };
}
