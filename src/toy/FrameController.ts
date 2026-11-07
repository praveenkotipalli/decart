/**
 * The corners of the hand frame, and how they are shown.
 *
 * The frame is bound to four fingertips in a fixed order, [A index, B index, B thumb, A thumb],
 * and drawn exactly as the hands make it: crossed, concave and sliver quads are passed through.
 * Per tracking result each tip goes through a OneEuro filter (the Stability / Responsiveness
 * settings), per render frame through a PointGlide follower, so the corners move every frame
 * instead of stepping at the tracker's 5–17 Hz. The filters run whenever all four corners are
 * present, so the quad is already settled when the gate opens.
 *
 * Visibility is opacity only (no scale pop); the corner brackets grow in. A lock freezes the
 * displayed quad and ignores the gate; unlocking glides back to the fingertips.
 *
 * Pure: plain data and timestamps in, a snapshot out. Nothing here knows about pixels.
 */
import { cloneQuad, type Quad, type Vec2 } from "../geometry/vec";
import { DEFAULT_GLIDE, PointGlide, type GlideOptions } from "../tracking/glide";
import { DEFAULT_ONE_EURO, OneEuro2D, type OneEuroParams } from "../tracking/oneEuro";
import { FLIP_T } from "./FlipDetector";
import { boundsDiagonal, crossing } from "./frameMath";

/** One fingertip for one tracking result. */
export interface CornerSample {
  /** Stage space. */
  point: Vec2;
  /** The track driving this corner; a change snaps the corner instead of gliding it. */
  handId: number;
  /** Observed in this result (false while its hand coasts through a dropout). */
  fresh: boolean;
  /** False when the caller does not trust this result (an uncertain pose): the corner stays put. */
  accept: boolean;
}

export interface FrameOptions {
  smoothing: OneEuroParams;
  glide: GlideOptions;
  /** Opacity fades: time to reach about 95 % of the target, ms. */
  fadeInMs: number;
  fadeOutMs: number;
  /** The bracket arms grow from nothing to their full length over this long, ms. */
  armMs: number;
  /** A quad whose bounding-box diagonal (frame heights) is under this is not shown. */
  minDiag: number;
}

export const DEFAULT_FRAME: FrameOptions = {
  smoothing: DEFAULT_ONE_EURO,
  glide: DEFAULT_GLIDE,
  fadeInMs: 80,
  fadeOutMs: 130,
  armMs: 180,
  minDiag: 0.035,
};

export interface FrameSnapshot {
  /** Stage space, [A index, B index, B thumb, A thumb]; null when nothing is there to draw. */
  quad: Quad | null;
  /** 0..1 opacity, eased. */
  visibility: number;
  /** Bracket arm as a fraction of its edge: 0..1/6, 0.5 when locked (a full outline). */
  arm: number;
  /** The gate's state as last given to update(). */
  open: boolean;
  locked: boolean;
  /** The displayed quad's top and bottom edges cross (a bow-tie). */
  crossed: boolean;
  /** The live fingertip quad is twisted enough to count for the flip gesture (see FLIP_T). */
  twistValid: boolean;
  /** Some corner is holding its last position through a dropout. */
  coasting: boolean;
}

/** Fingertips may sit a little outside the picture; MediaPipe extrapolates them that far quite well. */
const CLAMP_LO = -0.02;
const CLAMP_HI = 1.02;
/** Bracket arm lengths as fractions of an edge. */
const ARM_OPEN = 1 / 6;
const ARM_LOCKED = 0.5;
/** Below this a fade has arrived. */
const SETTLED = 0.002;
/** Fades are exponential; the option gives the time to ~95 %, which is three time constants. */
const TAU_PER_FADE = 1 / 3;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const clampPoint = (p: Vec2): Vec2 => ({ x: clamp(p.x, CLAMP_LO, CLAMP_HI), y: clamp(p.y, CLAMP_LO, CLAMP_HI) });

/** The quad in frame heights (isotropic), where lengths can be compared. */
const isotropic = (q: Quad, aspect: number): Quad => [
  { x: q[0].x * aspect, y: q[0].y },
  { x: q[1].x * aspect, y: q[1].y },
  { x: q[2].x * aspect, y: q[2].y },
  { x: q[3].x * aspect, y: q[3].y },
];

/**
 * The twist of a frame quad for the flip gesture: `crossed` is plain geometry (top edge 0→1
 * meets bottom edge 3→2); `valid` additionally wants the crossing well inside both edges and
 * both hands' index–thumb chords long enough to mean anything. `q` is in stage space.
 */
export function quadTwist(q: Quad, aspect: number): { crossed: boolean; valid: boolean } {
  const T = FLIP_T;
  const iso = isotropic(q, aspect);
  const c = crossing(iso);
  if (!c.crossed) return { crossed: false, valid: false };
  const inside = c.t >= T.twistMin && c.t <= T.twistMax && c.s >= T.twistMin && c.s <= T.twistMax;
  const chordA = Math.hypot(iso[0].x - iso[3].x, iso[0].y - iso[3].y);
  const chordB = Math.hypot(iso[1].x - iso[2].x, iso[1].y - iso[2].y);
  return { crossed: true, valid: inside && chordA >= T.minChord && chordB >= T.minChord };
}

export class FrameController {
  private options: FrameOptions;
  private readonly filters: OneEuro2D[];
  private glides: PointGlide[];
  /** Per corner: the track driving it, its filtered position, and whether its last sample was fresh. */
  private readonly sources: (number | null)[] = [null, null, null, null];
  private readonly filtered: (Vec2 | null)[] = [null, null, null, null];
  private readonly freshCorner = [true, true, true, true];

  private open = false;
  private locked = false;
  /** The quad a lock froze. */
  private frozen: Quad | null = null;
  /** The last quad shown, kept while it fades out. */
  private lastQuad: Quad | null = null;
  private aspect = 16 / 9;
  private twistValid = false;

  private visibility = 0;
  private wasShown = false;
  private armFrom = 0;
  private armTo = 0;
  private armStart = -Infinity;
  private lastUpdateAt = -Infinity;
  private lastSnapshotAt = -Infinity;

  constructor(options: Partial<FrameOptions> = {}) {
    this.options = { ...DEFAULT_FRAME, ...options };
    this.filters = [0, 1, 2, 3].map(() => new OneEuro2D(this.options.smoothing));
    this.glides = [0, 1, 2, 3].map(() => new PointGlide(this.options.glide));
  }

  setOptions(o: Partial<FrameOptions>): void {
    this.options = { ...this.options, ...o };
    if (o.smoothing) for (const f of this.filters) f.params = this.options.smoothing;
    if (o.glide) {
      // Followers take their options once: rebuild them where they stand.
      const now = this.now();
      this.glides = this.glides.map((g, i) => {
        const next = new PointGlide(this.options.glide);
        const p = g.at(now) ?? this.filtered[i];
        if (p) next.snap(p, now);
        return next;
      });
    }
  }

  /**
   * One tracking result. `corners` is [A index, B index, B thumb, A thumb] (null where the
   * hand is not tracked); `open` is the gate's phase; `aspect` camera width / height.
   */
  update(time: number, corners: (CornerSample | null)[], open: boolean, aspect: number): void {
    this.aspect = aspect;
    this.lastUpdateAt = time;
    for (let i = 0; i < 4; i++) {
      const c = corners[i] ?? null;
      if (c === null) {
        this.sources[i] = null;
        this.filtered[i] = null;
        this.freshCorner[i] = true;
        this.filters[i].reset();
        this.glides[i].reset();
        continue;
      }
      this.freshCorner[i] = c.fresh;
      if (!c.accept) continue; // the corner stays where it was
      const prev = this.filtered[i];
      if (!c.fresh) {
        // Coasting: the follower settles on the last position, without lead.
        if (prev) this.glides[i].sample(prev, time, false);
        continue;
      }
      const p = clampPoint(c.point);
      if (prev === null || this.sources[i] !== c.handId) {
        this.filters[i].reset(p, time);
        this.glides[i].snap(p, time);
        this.filtered[i] = p;
        this.sources[i] = c.handId;
      } else {
        const f = this.filters[i].filter(p, time);
        this.filtered[i] = f;
        this.glides[i].sample(f, time, true);
      }
    }
    this.open = open;
    // The twist is judged on the live fingertips at tracking rate, locked or not: a flip
    // while the frame is locked still steps the filter.
    const live = this.filteredQuad();
    this.twistValid = live !== null && quadTwist(live, aspect).valid;
  }

  /** Once per render frame, with non-decreasing time. */
  snapshot(time: number): FrameSnapshot {
    const o = this.options;
    const dt = Number.isFinite(this.lastSnapshotAt) ? Math.max(0, time - this.lastSnapshotAt) : 0;
    this.lastSnapshotAt = time;

    const live = this.glidedQuad(time);
    if (this.locked && this.frozen === null && live !== null) this.frozen = cloneQuad(live);
    const quad = this.locked ? this.frozen : live;
    if (quad !== null) this.lastQuad = quad;

    const shown = this.locked
      ? this.frozen !== null
      : this.open && live !== null && boundsDiagonal(isotropic(live, this.aspect)) >= o.minDiag;

    // Opacity: an exponential approach to 0 or 1, so a change of mind mid-fade just bends the curve.
    const target = shown ? 1 : 0;
    const tau = (shown ? o.fadeInMs : o.fadeOutMs) * TAU_PER_FADE;
    if (dt > 0) this.visibility += (target - this.visibility) * (1 - Math.exp(-dt / tau));
    if (Math.abs(target - this.visibility) < SETTLED) this.visibility = target;

    // Bracket arms: grow in when the frame appears, ease between the open and locked lengths,
    // and keep their length while the frame fades out.
    const armTarget = this.locked ? ARM_LOCKED : ARM_OPEN;
    if (shown && (!this.wasShown || this.armTo !== armTarget)) {
      this.armFrom = this.wasShown || this.visibility > SETTLED ? this.armAt(time) : 0;
      this.armTo = armTarget;
      this.armStart = time;
    } else if (!shown && this.visibility === 0) {
      this.armFrom = this.armTo = 0;
    }
    this.wasShown = shown;

    const out = quad ?? (this.visibility > 0 ? this.lastQuad : null);
    const crossed = out !== null && crossing(isotropic(out, this.aspect)).crossed;
    return {
      quad: out !== null ? cloneQuad(out) : null,
      visibility: this.visibility,
      arm: this.armAt(time),
      open: this.open,
      locked: this.locked,
      crossed,
      twistValid: this.twistValid,
      coasting: this.filteredQuad() !== null && this.freshCorner.some((f) => !f),
    };
  }

  /** The `l` key. Returns the new state. Locking with nothing to freeze does nothing. */
  toggleLock(): boolean {
    if (this.locked) {
      this.locked = false;
      // Glide back from where the frozen frame was to wherever the fingertips are now. The
      // coasting sample makes that a plain glide: without it the jump from the frozen corner to
      // the live tip would read as a fast hand and the follower would lead past the tip.
      const now = this.now();
      if (this.frozen !== null) {
        for (let i = 0; i < 4; i++) {
          const live = this.filtered[i];
          if (live === null) continue;
          this.glides[i].snap(this.frozen[i], now);
          this.glides[i].sample(live, now, false);
        }
      }
      this.frozen = null;
      return false;
    }
    const q = this.lastQuad;
    if (q === null) return false;
    this.frozen = cloneQuad(q);
    this.locked = true;
    return true;
  }

  isLocked(): boolean {
    return this.locked;
  }

  reset(): void {
    for (let i = 0; i < 4; i++) {
      this.sources[i] = null;
      this.filtered[i] = null;
      this.freshCorner[i] = true;
      this.filters[i].reset();
      this.glides[i].reset();
    }
    this.open = false;
    this.locked = false;
    this.frozen = null;
    this.lastQuad = null;
    this.twistValid = false;
    this.visibility = 0;
    this.wasShown = false;
    this.armFrom = this.armTo = 0;
    this.armStart = -Infinity;
    this.lastUpdateAt = -Infinity;
    this.lastSnapshotAt = -Infinity;
  }

  /** The latest time this controller has heard of (tracking or render clock). */
  private now(): number {
    const t = Math.max(this.lastUpdateAt, this.lastSnapshotAt);
    return Number.isFinite(t) ? t : 0;
  }

  private armAt(time: number): number {
    const k = this.options.armMs > 0 ? clamp((time - this.armStart) / this.options.armMs, 0, 1) : 1;
    return this.armFrom + (this.armTo - this.armFrom) * easeOutCubic(k);
  }

  /** The filtered (tracking-rate) quad, or null while a corner is missing. */
  private filteredQuad(): Quad | null {
    const f = this.filtered;
    if (f[0] === null || f[1] === null || f[2] === null || f[3] === null) return null;
    return [f[0], f[1], f[2], f[3]];
  }

  /** The glided (render-rate) quad, or null while a corner is missing. */
  private glidedQuad(time: number): Quad | null {
    if (this.filteredQuad() === null) return null;
    const q: Vec2[] = [];
    for (const g of this.glides) {
      const p = g.at(time);
      if (p === null) return null;
      q.push(p);
    }
    return [q[0], q[1], q[2], q[3]];
  }
}
