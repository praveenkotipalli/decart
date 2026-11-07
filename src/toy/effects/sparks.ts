/**
 * Effect 3, "particles": fingertips shed sparks, a fist gathers them, opening it throws them.
 *
 * `SparkField` is the simulation: a few hundred points on the CPU with the look of the
 * portal's sparks (src/render/particles.ts: drag, upward drift, short lives, 2–6 px, a
 * blue↔violet hue), but in stage space, so the renderer can draw them with the existing
 * point shaders at any canvas size. `SparksEffect` turns hands into emitters, attractors
 * and kicks.
 *
 * Units. Positions and velocities are stage space (x 0..1 across, y 0..1 down) and stage
 * units per second; lengths that must look the same in both directions are frame heights,
 * so a horizontal frame-height quantity is divided by the aspect ratio. The design gives
 * speeds and sizes in pixels; they are converted assuming a 720 px high frame
 * (40 px/s = 40/720 frame heights per second), see `SPARK.pxPerFrameHeight`.
 *
 * Deterministic: time arrives as `dt`, every random number comes from a seeded PRNG.
 */
import type { HandKinematics, HandRole, HandSample } from "../types";

export const SPARK = {
  /** The design's pixel quantities are for a 720 px high frame: px / this = frame heights. */
  pxPerFrameHeight: 720,
  /** Sparks per second per fingertip: rateMin + ratePerPx × tip speed (px/s), capped at rateMax. */
  rateMin: 4,
  rateMax: 36,
  ratePerPx: 0.05,
  /** Share of the fingertip velocity a new spark starts with. */
  velocityShare: 0.35,
  /** Random start speed added in a random direction, px/s. */
  scatterPx: 40,
  /** Spawn jitter around the fingertip, px. */
  jitterPx: 1.5,
  /** Velocity decay, 1/s. */
  drag: 1.2,
  /** Upward drift, px/s². */
  driftPx: 18,
  /** Lifetime bounds, s. */
  lifeMin: 0.7,
  lifeMax: 1.6,
  /** Size bounds, px. */
  sizeMinPx: 2,
  sizeMaxPx: 6,
  /** Most sparks alive at once, and the cap while rendering is slow (or motion is reduced). */
  cap: 640,
  lowCap: 320,
  /** A fist pulls sparks within this radius (frame heights) with this acceleration (frame heights/s²). */
  attractRadius: 0.35,
  attractStrength: 2.2,
  /** A fist that opens within this long of its last fist result throws its sparks outward at this speed (frame heights/s). */
  releaseMs: 400,
  kickSpeed: 0.9,
  /** Longest simulated step, s: a stalled tab does not fling everything off screen. */
  maxDt: 0.05,
  /** Hue centre per hand (the point shader mixes blue→violet over 0..1) and the random spread around it. */
  hueA: 0.15,
  hueB: 0.85,
  hueSpread: 0.15,
  /** Layout of `SparkField.data`: x, y (stage), size (frame heights), life 0..1, hue 0..1. */
  stride: 5,
} as const;

/** A point that sheds sparks: position (stage), velocity (stage units/s), rate (sparks/s), hue centre 0..1 (random when absent). */
export interface Emitter {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rate: number;
  hue?: number;
}

/** A point that pulls sparks in: position (stage), strength (frame heights/s²), radius (frame heights). */
export interface Attractor {
  x: number;
  y: number;
  strength: number;
  radius: number;
}

/** mulberry32: small, fast, good enough for sparks, and the same sequence for the same seed everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRIDE = SPARK.stride;

export class SparkField {
  /** Per spark: x, y (stage), size (frame heights), life 0..1, hue 0..1. Only the first `count` × 5 entries are live. */
  readonly data: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly ttl: Float32Array;
  private readonly rand: () => number;
  private n = 0;
  private cap: number;
  /** Aspect of the latest step(): kick() needs one and has no parameter for it. */
  private aspect = 16 / 9;
  /** Sparks ever emitted (diagnostics and tests). */
  spawned = 0;

  constructor(
    readonly max = SPARK.cap,
    seed = 1,
  ) {
    this.data = new Float32Array(max * STRIDE);
    this.vel = new Float32Array(max * 2);
    this.age = new Float32Array(max);
    this.ttl = new Float32Array(max);
    this.rand = mulberry32(seed);
    this.cap = max;
  }

  get count(): number {
    return this.n;
  }

  /** Live sparks allowed; over it the oldest go first on the next step. */
  setCap(n: number): void {
    this.cap = Math.max(0, Math.min(this.max, Math.floor(n)));
  }

  clear(): void {
    this.n = 0;
  }

  /**
   * Advance by `dt` seconds (clamped to `maxDt`): age, drag, drift, attraction, then emission.
   * Emission is stochastic (floor plus a Bernoulli remainder), so the expected count is exactly
   * rate × dt without per-emitter bookkeeping, and the same seed gives the same sparks.
   */
  step(dt: number, aspect: number, emitters: readonly Emitter[], attractors: readonly Attractor[]): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, SPARK.maxDt);
    if (aspect > 0) this.aspect = aspect;
    aspect = this.aspect;
    const d = this.data;
    const v = this.vel;
    const k = Math.exp(-SPARK.drag * dt);
    const drift = (SPARK.driftPx / SPARK.pxPerFrameHeight) * dt;
    // Over the cap the oldest sparks (they come first: compaction keeps order) are dropped.
    let drop = Math.max(0, this.n - this.cap);
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i] + dt;
      if (age >= this.ttl[i]) continue;
      if (drop > 0) {
        drop--;
        continue;
      }
      const o = i * STRIDE;
      let x = d[o];
      let y = d[o + 1];
      let vx = v[i * 2] * k;
      let vy = v[i * 2 + 1] * k - drift;
      for (let a = 0; a < attractors.length; a++) {
        const at = attractors[a];
        const dx = (at.x - x) * aspect;
        const dy = at.y - y;
        const dist = Math.hypot(dx, dy);
        if (dist >= at.radius || dist < 1e-6) continue;
        const g = (at.strength * dt) / dist;
        vx += (dx * g) / aspect;
        vy += dy * g;
      }
      x += vx * dt;
      y += vy * dt;
      const no = w * STRIDE;
      d[no] = x;
      d[no + 1] = y;
      d[no + 2] = d[o + 2];
      d[no + 3] = age / this.ttl[i];
      d[no + 4] = d[o + 4];
      v[w * 2] = vx;
      v[w * 2 + 1] = vy;
      this.age[w] = age;
      this.ttl[w] = this.ttl[i];
      w++;
    }
    this.n = w;

    for (let e = 0; e < emitters.length && this.n < this.cap; e++) {
      const em = emitters[e];
      const expected = em.rate * dt;
      let count = Math.floor(expected);
      if (this.rand() < expected - count) count++;
      for (; count > 0 && this.n < this.cap; count--) this.spawn(em, aspect);
    }
  }

  /** Throw every spark within `radius` (frame heights) of (x, y) outward by `speed` (frame heights/s). */
  kick(x: number, y: number, radius: number, speed: number): void {
    const aspect = this.aspect;
    const d = this.data;
    const v = this.vel;
    for (let i = 0; i < this.n; i++) {
      const o = i * STRIDE;
      let dx = (d[o] - x) * aspect;
      let dy = d[o + 1] - y;
      const dist = Math.hypot(dx, dy);
      if (dist >= radius) continue;
      if (dist < 1e-6) {
        // Right at the centre there is no "outward": pick a direction.
        const ang = this.rand() * Math.PI * 2;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
      } else {
        dx /= dist;
        dy /= dist;
      }
      v[i * 2] += (dx * speed) / aspect;
      v[i * 2 + 1] += dy * speed;
    }
  }

  private spawn(em: Emitter, aspect: number): void {
    const i = this.n++;
    const o = i * STRIDE;
    const r = this.rand;
    const px = 1 / SPARK.pxPerFrameHeight;
    const ang = r() * Math.PI * 2;
    const scatter = SPARK.scatterPx * px;
    const jitter = (r() * 2 - 1) * SPARK.jitterPx * px;
    const jang = r() * Math.PI * 2;
    this.data[o] = em.x + (Math.cos(jang) * jitter) / aspect;
    this.data[o + 1] = em.y + Math.sin(jang) * jitter;
    this.data[o + 2] = (SPARK.sizeMinPx + r() * (SPARK.sizeMaxPx - SPARK.sizeMinPx)) * px;
    this.data[o + 3] = 0;
    const hue = em.hue === undefined ? r() : em.hue + (r() * 2 - 1) * SPARK.hueSpread;
    this.data[o + 4] = Math.min(1, Math.max(0, hue));
    this.vel[i * 2] = em.vx * SPARK.velocityShare + (Math.cos(ang) * scatter) / aspect;
    this.vel[i * 2 + 1] = em.vy * SPARK.velocityShare + Math.sin(ang) * scatter;
    this.age[i] = 0;
    this.ttl[i] = SPARK.lifeMin + r() * (SPARK.lifeMax - SPARK.lifeMin);
    this.spawned++;
  }
}

/** What is remembered about one hand between tracking results. */
interface HandState {
  /** The latest fresh result was a fist: the hand attracts. */
  fist: boolean;
  /** Result time of the last fist, ms; -Infinity when there was none. */
  lastFistAt: number;
  /** This fist has already thrown its sparks. */
  kicked: boolean;
  stamp: number;
}

const TIPS = 5;
export const hueFor = (role: HandRole): number => (role === "B" ? SPARK.hueB : SPARK.hueA);

export class SparksEffect {
  readonly field: SparkField;
  private readonly hands = new Map<number, HandState>();
  // Reused per frame: ten emitters and two attractors at most, no allocation while the hand count is steady.
  private readonly emitters: Emitter[] = [];
  private readonly attractors: Attractor[] = [];
  private stamp = 0;

  constructor(seed = 1) {
    this.field = new SparkField(SPARK.cap, seed);
  }

  /** One tracking result: fists and the moment they open. */
  update(time: number, hands: HandSample[]): void {
    const stamp = ++this.stamp;
    for (const hand of hands) {
      let s = this.hands.get(hand.id);
      if (!s) {
        s = { fist: false, lastFistAt: -Infinity, kicked: false, stamp };
        this.hands.set(hand.id, s);
      }
      s.stamp = stamp;
      if (!hand.fresh) continue; // a coasting hand keeps its pose: nothing changed
      if (hand.pose.fist) {
        s.fist = true;
        s.lastFistAt = time;
        s.kicked = false;
      } else {
        s.fist = false;
        // Fist → open hand quickly enough is a throw; a slow release just lets the sparks drift.
        if (hand.pose.palm && !s.kicked && time - s.lastFistAt <= SPARK.releaseMs) {
          this.field.kick(hand.palm.x, hand.palm.y, SPARK.attractRadius, SPARK.kickSpeed);
          s.kicked = true;
        }
      }
    }
    for (const [id, s] of this.hands) if (s.stamp !== stamp) this.hands.delete(id);
  }

  /** One render frame: fresh fingertips emit, fists attract, the field steps by `dt` seconds. */
  advance(_time: number, dt: number, aspect: number, hands: HandKinematics[], lowFps: boolean): void {
    this.field.setCap(lowFps ? SPARK.lowCap : SPARK.cap);
    const emitters = this.emitters;
    const attractors = this.attractors;
    let ne = 0;
    let na = 0;
    const pxPerStage = SPARK.pxPerFrameHeight;
    for (const hand of hands) {
      const s = this.hands.get(hand.id);
      if (s?.fist) {
        const at = attractors[na] ?? (attractors[na] = { x: 0, y: 0, strength: 0, radius: 0 });
        at.x = hand.palm.x;
        at.y = hand.palm.y;
        at.strength = SPARK.attractStrength;
        at.radius = SPARK.attractRadius;
        na++;
      }
      if (!hand.fresh) continue;
      const hue = hueFor(hand.role);
      for (let t = 0; t < TIPS && t < hand.tipVel.length; t++) {
        const p = hand.points[4 + t * 4]; // thumb, index, middle, ring, pinky tips: landmarks 4, 8, 12, 16, 20
        const vel = hand.tipVel[t];
        const speedPx = Math.hypot(vel.x * aspect, vel.y) * pxPerStage;
        const em = emitters[ne] ?? (emitters[ne] = { x: 0, y: 0, vx: 0, vy: 0, rate: 0, hue: 0 });
        em.x = p.x;
        em.y = p.y;
        em.vx = vel.x;
        em.vy = vel.y;
        em.rate = Math.min(SPARK.rateMax, Math.max(SPARK.rateMin, SPARK.rateMin + SPARK.ratePerPx * speedPx));
        em.hue = hue;
        ne++;
      }
    }
    emitters.length = ne;
    attractors.length = na;
    this.field.step(dt, aspect, emitters, attractors);
  }

  /** The `c` key: every spark goes. */
  clear(): void {
    this.field.clear();
  }

  /** Forget the hands (effect switched, tracking restarted); the sparks already in the air stay. */
  reset(): void {
    this.hands.clear();
  }
}
