import { classifyQuad, expandQuad, lerpQuad, untangle, type QuadValidity } from "../geometry/quad";
import { cloneQuad, type Quad, type Vec2 } from "../geometry/vec";
import type { GestureEvent } from "../gestures/GestureMachine";
import { DEFAULT_ONE_EURO, OneEuro2D, type OneEuroParams } from "../tracking/oneEuro";
import type { ResolvedCorner } from "./cornerMapping";

export type PortalPhase = "searching" | "tracking" | "coasting" | "locked" | "home";

/**
 * What to draw when the finger quad is not a valid (convex) quadrilateral:
 * - hold: keep the last valid portal; markers still follow the fingers
 * - untangle: re-order crossed corners into a valid outline
 * - allow: draw it anyway, clipped to where the projection is defined
 */
export type InvalidPolicy = "hold" | "untangle" | "allow";

export interface PortalOptions {
  smoothing: OneEuroParams;
  invalidPolicy: InvalidPolicy;
  /** How long the portal lingers after a corner is lost, ms. */
  lingerMs: number;
  /** Portal size relative to the fingertip quad. 1 = corners exactly at the fingertips. */
  scale: number;
  /** Smallest quad area treated as a portal, in stage units² (stage = 1x1). */
  minArea: number;
}

export const DEFAULT_PORTAL_OPTIONS: PortalOptions = {
  smoothing: DEFAULT_ONE_EURO,
  invalidPolicy: "hold",
  lingerMs: 1400,
  scale: 1,
  minArea: 0.0025,
};

export const DEFAULT_HOME: Quad = [
  { x: 0.32, y: 0.24 },
  { x: 0.68, y: 0.24 },
  { x: 0.68, y: 0.76 },
  { x: 0.32, y: 0.76 },
];

export interface PortalSnapshot {
  phase: PortalPhase;
  /** Geometry to render, stage space, after hold/untangle, transitions and scale. */
  corners: Quad | null;
  /** Filtered fingertip positions (null = not tracked). May differ from `corners` when invalid. */
  fingers: (Vec2 | null)[];
  validity: QuadValidity;
  locked: boolean;
  /** 0..1, eased: drives the open/close animation. */
  visibility: number;
  /** Per corner: driven by a fresh observation this frame. */
  fresh: boolean[];
}

const TRANSITION_MS = 320;
const HISTORY_MS = 1500;
/** Render-time prediction: how far ahead of the last tracking sample corners may be extrapolated. */
const PREDICT_MAX_MS = 60;
const PREDICT_GAIN = 0.8;
/** Interior angles below this make the projection a smear; treat as degenerate. */
const MIN_ANGLE_DEG = 10;
/** Lock restores the pose from this long before the lock gesture began. */
const PRE_GESTURE_MS = 120;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export class PortalController {
  options: PortalOptions;
  home: Quad = cloneQuad(DEFAULT_HOME);

  private filters = [0, 1, 2, 3].map(() => new OneEuro2D(DEFAULT_ONE_EURO));
  private sources: (number | null)[] = [null, null, null, null];
  private fingers: (Vec2 | null)[] = [null, null, null, null];
  private fresh = [false, false, false, false];
  private target: Quad | null = null;
  private lastValid: Quad | null = null;
  private validity: QuadValidity = "valid";
  private phase: PortalPhase = "searching";
  private locked = false;
  private lastCompleteAt = -Infinity;
  private transition: { from: Quad; start: number } | null = null;
  private history: { t: number; q: Quad }[] = [];
  private visibility = 0;
  private lastAdvance = 0;
  private now = 0;
  /** Per-corner velocity (stage units/ms) from consecutive filtered samples; drives prediction. */
  private velocity: Vec2[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  private live = false;

  constructor(options: Partial<PortalOptions> = {}) {
    this.options = { ...DEFAULT_PORTAL_OPTIONS, ...options };
    this.applySmoothing();
  }

  setOptions(options: Partial<PortalOptions>) {
    this.options = { ...this.options, ...options };
    this.applySmoothing();
  }

  private applySmoothing() {
    for (const f of this.filters) f.params = this.options.smoothing;
  }

  /** Validity for portal purposes: convex, big enough, and no sliver-thin corners. */
  private classify(q: Quad): QuadValidity {
    return classifyQuad(q, this.options.minArea, 0, MIN_ANGLE_DEG);
  }

  /** Feed one tracking frame. `corners` come from resolveCorners(); `t` is the frame time in ms. */
  update(t: number, corners: (ResolvedCorner | null)[], events: GestureEvent[] = []) {
    const dt = t - this.now;
    this.now = t;
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      if (!c) {
        this.fingers[i] = null;
        this.sources[i] = null;
        this.fresh[i] = false;
        this.velocity[i] = { x: 0, y: 0 };
        continue;
      }
      this.fresh[i] = c.fresh;
      if (!c.fresh) {
        this.velocity[i] = { x: 0, y: 0 }; // coasting: hold the last filtered position
        continue;
      }
      const prev = this.fingers[i];
      if (this.sources[i] !== c.handId || !prev) {
        this.filters[i].reset(c.point, t); // a different hand now drives this corner: snap
        this.sources[i] = c.handId;
        this.fingers[i] = { ...c.point };
        this.velocity[i] = { x: 0, y: 0 };
        continue;
      }
      const next = this.filters[i].filter(c.point, t);
      this.velocity[i] =
        dt > 4 && dt < 200 ? { x: (next.x - prev.x) / dt, y: (next.y - prev.y) / dt } : { x: 0, y: 0 };
      this.fingers[i] = next;
    }
    this.live = false;

    for (const e of events) {
      if (e.action === "reset") this.reset();
      else if (e.action === "lock") this.toggleLock(e.startedAt);
    }

    if (this.locked) {
      this.phase = "locked";
      this.record(t);
      return;
    }

    if (this.fingers.every(Boolean)) {
      const raw = this.fingers.map((p) => ({ ...p! })) as Quad;
      this.validity = this.classify(raw);
      let next: Quad | null = null;
      if (this.validity === "valid") next = raw;
      else if (this.options.invalidPolicy === "allow" && this.validity !== "degenerate") next = raw;
      else if (this.options.invalidPolicy === "untangle" && this.validity === "crossed") {
        const u = untangle(raw);
        next = this.classify(u) === "valid" ? u : this.lastValid;
      } else next = this.lastValid;

      if (this.validity === "valid") this.lastValid = raw;
      if (next) {
        if ((this.phase === "home" || this.phase === "searching") && this.target) this.beginTransition(t);
        this.target = next;
        this.phase = this.fresh.every(Boolean) ? "tracking" : "coasting";
        this.lastCompleteAt = t;
        this.live = next === raw && this.phase === "tracking";
      }
    } else if (this.phase !== "home" && t - this.lastCompleteAt > this.options.lingerMs) {
      this.phase = "searching";
    }
    this.record(t);
  }

  toggleLock(startedAt = this.now) {
    if (this.locked) this.unlock();
    else this.lock(startedAt);
  }

  /** Freezes the portal. Uses the pose from just before the gesture started, so the
   * finger movement that performs the gesture does not distort the locked portal. */
  lock(startedAt = this.now) {
    const before = this.history.filter((h) => h.t <= startedAt - PRE_GESTURE_MS).pop();
    const q = before?.q ?? this.displayQuad(this.now) ?? this.target;
    if (!q) return;
    this.transition = null;
    this.target = cloneQuad(q);
    this.locked = true;
    this.phase = "locked";
  }

  unlock() {
    if (!this.locked) return;
    this.locked = false;
    this.beginTransition(this.now);
    if (this.fingers.every(Boolean)) {
      const live = this.fingers.map((p) => ({ ...p! })) as Quad;
      if (this.classify(live) === "valid") this.target = live;
      this.phase = "tracking";
    } else this.phase = "home";
  }

  /** Back to the home pose (calibrated, or centred), unlocked. */
  reset() {
    this.beginTransition(this.now);
    this.locked = false;
    this.target = cloneQuad(this.home);
    this.lastValid = null;
    this.phase = "home";
  }

  isLocked() {
    return this.locked;
  }

  private beginTransition(t: number) {
    const from = this.displayQuad(t);
    if (from) this.transition = { from, start: t };
  }

  private displayQuad(t: number): Quad | null {
    if (!this.target) return null;
    if (!this.transition) return cloneQuad(this.target);
    const k = (t - this.transition.start) / TRANSITION_MS;
    if (k >= 1) {
      this.transition = null;
      return cloneQuad(this.target);
    }
    return lerpQuad(this.transition.from, this.target, easeOutCubic(Math.max(0, k)));
  }

  private record(t: number) {
    const q = this.displayQuad(t);
    if (q) this.history.push({ t, q });
    while (this.history.length && t - this.history[0].t > HISTORY_MS) this.history.shift();
  }

  /** Advance animation state to render time `t` (ms) and return what to draw. */
  snapshot(t: number): PortalSnapshot {
    const dt = this.lastAdvance ? Math.min(t - this.lastAdvance, 100) : 16;
    this.lastAdvance = t;
    const visible = this.phase !== "searching" && this.target !== null;
    const tau = visible ? 110 : 260;
    this.visibility += ((visible ? 1 : 0) - this.visibility) * (1 - Math.exp(-dt / tau));
    if (Math.abs(this.visibility - (visible ? 1 : 0)) < 0.002) this.visibility = visible ? 1 : 0;

    let q = this.displayQuad(Math.max(t, this.now));
    // Tracking arrives at 15–30 Hz but frames render at 60+: dead-reckon the corners
    // between samples so the portal glides instead of stepping.
    if (q && this.live && !this.locked && !this.transition) {
      const h = Math.min(Math.max(t - this.now, 0), PREDICT_MAX_MS) * PREDICT_GAIN;
      const p = q.map((c, i) => ({ x: c.x + this.velocity[i].x * h, y: c.y + this.velocity[i].y * h })) as Quad;
      if (this.classify(p) === "valid") q = p;
    }
    return {
      phase: this.phase,
      corners: q && this.options.scale !== 1 ? expandQuad(q, this.options.scale) : q,
      fingers: this.fingers.map((p) => (p ? { ...p } : null)),
      validity: this.validity,
      locked: this.locked,
      visibility: this.visibility,
      fresh: [...this.fresh],
    };
  }
}
