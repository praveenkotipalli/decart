/**
 * The scripted demo of the hand-frame toy: a 22-second loop of two synthetic hands that
 * walks through everything the toy does, so the app can be shown (and tested) without a
 * camera. The same idea as SimulatedHands for the classic portal, with a different story:
 *
 *    0.0  open palms rise                     trackers only
 *    2.0  two Ls                              the frame opens
 *    3.5  stretch and tilt
 *    7.0  hand B tips over and back           a flip: the look inside changes
 *   10.0  hand A comes near                   a skewed quad
 *   12.0  hand B drops out for 350 ms         the frame coasts
 *   13.5  open palms                          the frame lets go
 *   15.0  hand B makes an OK sign and sweeps  a loupe
 *   18.5  hand A points and draws an arc      visible in effect 2
 *   21.0  hands down
 *
 * Each hand is a list of keyframes (where it is, how big, how turned, which shape) with
 * smooth easing into every key. On top of that come the turn-over (a rigid 3D rotation of
 * the finished hand), the dropout, the sweep and the arc, and a small tremor from a seeded
 * hash so the hands never sit perfectly still. The choreography is laid out for landscape
 * and scaled down on narrow stages so both hands stay in the picture at any aspect ratio.
 *
 * Deterministic: `frame(t)` is a pure function of the time and the seed.
 */
import type { HandFrame, HandObservation } from "../tracking/landmarks";
import { syntheticHand, type SyntheticHandPose } from "../tracking/syntheticHand";
import { lPose, okPose, openPose, pointPose, turnHand } from "../tracking/syntheticPoses";

/** Length of the loop, seconds. */
export const TOY_LOOP_S = 22;

export interface ToyBeat {
  label: string;
  /** Loop time the beat starts, seconds. */
  from: number;
}

/** What the demo is doing, for the on-screen caption. */
export const TOY_BEATS: ToyBeat[] = [
  { label: "open palms · just the trackers", from: 0 },
  { label: "two l shapes · the frame opens", from: 2 },
  { label: "stretch and tilt", from: 3.5 },
  { label: "tip one hand over · the look changes", from: 7 },
  { label: "one hand comes near · a skewed frame", from: 10 },
  { label: "one hand drops out · the frame coasts", from: 12 },
  { label: "open palms · the frame lets go", from: 13.5 },
  { label: "ok sign · a loupe", from: 15 },
  { label: "point and draw an arc", from: 18.5 },
  { label: "hands down", from: 21 },
];

const loopTime = (seconds: number) => ((seconds % TOY_LOOP_S) + TOY_LOOP_S) % TOY_LOOP_S;

export function toyBeat(tSeconds: number): string {
  const T = loopTime(tSeconds);
  let label = TOY_BEATS[0].label;
  for (const b of TOY_BEATS) if (T >= b.from) label = b.label;
  return label;
}

// ── Choreography ──────────────────────────────────────────────────────────────────────────

type Side = "A" | "B";
type Curls = SyntheticHandPose["curls"];
type ThumbTo = SyntheticHandPose["thumbTo"];

/** The finger configuration of a hand, taken from the named synthetic poses. */
interface Shape {
  curls: Curls;
  thumbAngle: number;
  thumbTo: ThumbTo;
}

const shapeOf = (p: SyntheticHandPose): Shape => ({ curls: [...p.curls] as Curls, thumbAngle: p.thumbAngle, thumbTo: p.thumbTo ?? null });

const S = {
  open: shapeOf(openPose("A")),
  l: shapeOf(lPose("A")),
  /** An L with the thumb swung a little further across: the tilt of beat 3. */
  lTilt: { ...shapeOf(lPose("A")), thumbAngle: 165 },
  ok: shapeOf(okPose("A")),
  point: shapeOf(pointPose("A")),
};

/** One keyframe of one hand. Positions are relative to the stage centre, in frame heights. */
interface Key {
  /** Loop time this key is reached, s. */
  at: number;
  /** The move into this key takes this long and ends at `at`, s (0 = a cut). */
  blend: number;
  dx: number;
  dy: number;
  /** Wrist → middle knuckle, frame heights, before the narrow-stage scale. */
  size: number;
  /** In-plane rotation, radians, clockwise on screen. */
  rot: number;
  shape: Shape;
}

const CENTER = { x: 0.5, y: 0.53 };
const SIZE = 0.16;
/** Half the distance between the two palms in the frame pose, frame heights (0.36 / 0.64 on a 16:9 stage, as framePose). */
const SEP = 0.25;
/** dy of a hand below the picture (palm at y = 1.30). */
const DOWN = 0.77;
/** A hand whose palm centre is lower than this is not in the picture. */
const PALM_Y_MAX = 1.12;

/** The arc hand A draws in beat 9: centre and radii, frame heights relative to the stage centre. */
const ARC = { cx: -0.22, cy: 0.04, rx: 0.12, ry: 0.09, from: 18.5, to: 20.9 };
const ARC_START = { dx: ARC.cx - ARC.rx, dy: ARC.cy };
const ARC_END = { dx: ARC.cx + ARC.rx, dy: ARC.cy };
/** Hand B's turn-over: over, hold, back (seconds). */
const TIP = { t0: 7.0, t1: 7.6, t2: 8.6, t3: 9.2 };
/** Hand B is not seen between these times. */
const DROP = { from: 12.0, to: 12.35 };
/** Hand B's sweep while it holds the OK sign. */
const SWEEP = { from: 15.0, to: 18.0, dx: 0.12, dy: 0.05 };

const key = (at: number, blend: number, dx: number, dy: number, shape: Shape, size = SIZE, rot = 0): Key => ({ at, blend, dx, dy, size, rot, shape });

const A_KEYS: Key[] = [
  key(0, 0, -SEP, DOWN, S.open),
  key(1.4, 1.4, -SEP, 0.02, S.open),
  key(2.0, 0.5, -SEP, -0.01, S.l),
  key(4.5, 1.0, -0.33, 0.0, S.l, SIZE, -0.14),
  key(6.5, 1.2, -0.27, -0.01, S.l, SIZE, -0.04),
  key(10.8, 0.8, -0.2, 0.06, S.l, 0.23, -0.1),
  key(13.5, 0.5, -SEP, 0.02, S.open),
  key(18.5, 0.5, ARC_START.dx, ARC_START.dy, S.point),
  key(21.0, 0, ARC_END.dx, ARC_END.dy, S.point),
  key(21.8, 0.8, ARC_END.dx, DOWN, S.open),
];

const B_KEYS: Key[] = [
  key(0, 0, SEP, DOWN, S.open),
  key(1.4, 1.4, SEP, 0.02, S.open),
  key(2.0, 0.5, SEP, -0.01, S.l),
  key(4.5, 1.0, 0.33, -0.03, S.lTilt, SIZE, 0.14),
  key(6.5, 1.2, 0.27, -0.01, S.l, SIZE, 0.04),
  key(13.5, 0.5, SEP, 0.02, S.open),
  key(15.0, 0.5, 0.22, -0.02, S.ok),
  key(18.5, 0.5, 0.27, 0.08, S.open),
  key(21.8, 0.8, 0.27, DOWN, S.open),
];

// ── Easing and noise ───────────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (k: number) => {
  const s = clamp01(k);
  return s * s * (3 - 2 * s);
};
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** 0 before `t0`, eases up to 1 by `t1`, holds, eases back to 0 between `t2` and `t3`. */
function overAndBack(t: number, t0: number, t1: number, t2: number, t3: number): number {
  if (t < t1) return smooth((t - t0) / (t1 - t0));
  if (t < t2) return 1;
  return 1 - smooth((t - t2) / (t3 - t2));
}

/** One step of mulberry32 on a (seed, index) pair: a reproducible value in -1..1. */
function hash(seed: number, i: number): number {
  let a = (seed ^ Math.imul(i + 0x9e3779b9, 0x85ebca6b)) | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

/** Hands tremble at a few hertz, not at frame rate. */
const TREMOR_HZ = 6;
/** Tremor amplitude: position in frame heights (about 1.5 px at 720p), rotation in radians. */
const TREMOR = 0.002;
const TREMOR_ROT = 0.006;

/** Smooth value noise in -1..1: a pure function of the time, so a replay gives the same hands. */
function noise(seed: number, t: number): number {
  const u = t * TREMOR_HZ;
  const i = Math.floor(u);
  return mix(hash(seed, i), hash(seed, i + 1), smooth(u - i));
}

// ── Building a hand ────────────────────────────────────────────────────────────────────────

/** The keyframes around `T`: `from` held, or moving to `to` with eased progress `k`. */
function segment(keys: Key[], T: number): { from: Key; to: Key; k: number } {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].at <= T) i++;
  const from = keys[i];
  const to = keys[i + 1];
  if (to === undefined || to.blend <= 0 || T < to.at - to.blend) return { from, to: from, k: 0 };
  return { from, to, k: smooth((T - (to.at - to.blend)) / to.blend) };
}

/** How the landscape choreography fits a stage of this aspect: narrow stages shrink the whole thing. */
function layoutFor(aspect: number) {
  const k = Math.min(1, aspect / 0.85);
  return { k, x: (dx: number) => CENTER.x + (dx * k) / aspect, y: (dy: number) => CENTER.y + dy };
}

/** A hand between two keys, before the per-beat overrides. */
interface Placed {
  dx: number;
  dy: number;
  size: number;
  rot: number;
  curls: Curls;
  thumbAngle: number;
  thumbFrom: ThumbTo;
  thumbTo: ThumbTo;
  k: number;
}

function place(keys: Key[], T: number): Placed {
  const { from, to, k } = segment(keys, T);
  return {
    dx: mix(from.dx, to.dx, k),
    dy: mix(from.dy, to.dy, k),
    size: mix(from.size, to.size, k),
    rot: mix(from.rot, to.rot, k),
    curls: from.shape.curls.map((c, i) => mix(c, to.shape.curls[i], k)) as Curls,
    thumbAngle: mix(from.shape.thumbAngle, to.shape.thumbAngle, k),
    thumbFrom: from.shape.thumbTo,
    thumbTo: to.shape.thumbTo,
    k,
  };
}

const lerp3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, k: number) => ({
  x: mix(a.x, b.x, k),
  y: mix(a.y, b.y, k),
  z: mix(a.z, b.z, k),
});

/**
 * The observation of a placed hand. A pinch (thumbTo) snaps the thumb tip onto a fingertip,
 * so a move into or out of an OK sign blends the thumb's last two landmarks between the
 * pinched and the free thumb instead of cutting.
 */
function observe(pose: SyntheticHandPose, p: Placed, aspect: number): HandObservation {
  if (p.thumbFrom === p.thumbTo || p.k <= 0 || p.k >= 1) return syntheticHand({ ...pose, thumbTo: p.k >= 1 ? p.thumbTo : p.thumbFrom }, aspect);
  const a = syntheticHand({ ...pose, thumbTo: p.thumbFrom }, aspect);
  const b = syntheticHand({ ...pose, thumbTo: p.thumbTo }, aspect);
  for (const i of [3, 4]) {
    a.points[i] = lerp3(a.points[i], b.points[i], p.k);
    a.world[i] = lerp3(a.world[i], b.world[i], p.k);
  }
  return a;
}

export class SimulatedToy {
  /** Seed of the tremor; two demos with the same seed produce identical hands. */
  constructor(private readonly seed = 7) {}

  /** The hands at `timeMs` for a camera of this aspect. */
  frame(timeMs: number, aspect = 16 / 9): HandFrame {
    const T = loopTime(timeMs / 1000);
    const layout = layoutFor(aspect);
    const hands: HandObservation[] = [];
    const a = this.hand("A", T, layout, aspect);
    if (a !== null) hands.push(a);
    if (!(T >= DROP.from && T < DROP.to)) {
      const b = this.hand("B", T, layout, aspect);
      if (b !== null) hands.push(b);
    }
    return { time: timeMs, hands, aspect, inferenceMs: 0 };
  }

  private hand(side: Side, T: number, layout: ReturnType<typeof layoutFor>, aspect: number): HandObservation | null {
    const p = place(side === "A" ? A_KEYS : B_KEYS, T);

    if (side === "A" && T >= ARC.from && T < 21.0) {
      // Beat 9: the pointing hand draws an arc, left to right over the top, easing in and out.
      const s = smooth((T - ARC.from) / (ARC.to - ARC.from));
      const theta = Math.PI * (1 - s);
      p.dx = ARC.cx + ARC.rx * Math.cos(theta);
      p.dy = ARC.cy - ARC.ry * Math.sin(theta);
    }
    if (side === "B" && T >= SWEEP.from && T < SWEEP.to) {
      // Beat 8: the OK hand sweeps out and back, dipping a little on the way.
      const u = (T - SWEEP.from) / (SWEEP.to - SWEEP.from);
      p.dx += SWEEP.dx * Math.sin(Math.PI * u);
      p.dy -= SWEEP.dy * Math.sin(2 * Math.PI * u);
    }

    // Tremor: three independent noise channels per hand.
    const ch = this.seed * 8 + (side === "A" ? 0 : 4);
    const dx = p.dx + TREMOR * noise(ch, T);
    const dy = p.dy + TREMOR * noise(ch + 1, T);
    const rot = p.rot + TREMOR_ROT * noise(ch + 2, T);

    const pose: SyntheticHandPose = {
      ...lPose(side),
      x: layout.x(dx),
      y: layout.y(dy),
      size: p.size * layout.k,
      rotation: rot,
      curls: p.curls,
      thumbAngle: p.thumbAngle,
      thumbTo: null,
      spread: 1,
    };
    if (pose.y > PALM_Y_MAX) return null;

    let obs = observe(pose, p, aspect);
    if (side === "B" && T >= TIP.t0 && T < TIP.t3) {
      // Beat 4: the hand tips over about its knuckle row (thumb ends up on top) and back.
      obs = turnHand(obs, { pitch: Math.PI * overAndBack(T, TIP.t0, TIP.t1, TIP.t2, TIP.t3) }, aspect);
    }
    return obs;
  }
}
