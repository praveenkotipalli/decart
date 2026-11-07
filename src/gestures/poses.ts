/**
 * Hand poses of the hand-frame toy: L, OK, point, fist and open palm.
 *
 * `classifyHand` (classifier.ts) already says which fingers are straight, from the metric
 * world landmarks. This module adds what the toy needs on top of it and settles on one
 * pose per tracking result:
 *  - curl per finger as the wrist–PIP–tip angle, OR-ed with an image-space test, because
 *    MediaPipe's depth under-reports a finger that curls towards the camera;
 *  - the index–thumb angle that makes an L, measured in the image: on real hands the 3D
 *    angle reads 37–59° on open palms and 81° on a thumb folded across a fist, while the
 *    image angle is 57–89° for every L and under 26° for every open palm or folded thumb;
 *  - which side of the hand faces the camera (the flip gesture votes with it);
 *  - the thumb–index ring of an OK sign (the loupe looks through it).
 *
 * World landmarks collapse when the back of the hand faces the camera, which is exactly
 * what flipping a hand shows, and real open hands often fail the metric sanity check too,
 * so every world-derived term has an image-space stand-in. A result that cannot be trusted
 * (hand clipped by the frame edge, sudden change of size) keeps the previous pose instead
 * of guessing.
 *
 * Pure: plain data and a timestamp in, plain data out. Units as in toy/types.ts.
 */
import { dist, type Vec2 } from "../geometry/vec";
import type { HandPose, PoseName } from "../toy/types";
import { LM, type HandObservation, type Vec3 } from "../tracking/landmarks";
import { SHAPE_THRESHOLDS, type HandShape } from "./classifier";

/**
 * Every threshold of the pose classifier. Set on the synthetic hand and on MediaPipe's
 * landmarks for photographed hands (tests/fixtures/real-hands.json); meant to be tuned
 * further on live webcam hands with the `?debug=poses` readout (see `describePose`).
 */
export const POSE_T = {
  /** Index–thumb angle of an L in the image, degrees: to start one / to keep one. Real Ls read 57–89°, open palms 15–26°. */
  phiEnter: 40,
  phiStay: 28,
  /**
   * Wrist–PIP–tip angle, degrees: a finger starts to count as curled below `curlEnter` and
   * stops above `curlStay`. Real curled fingers read 2–56° (up to 94° on a poor fit), the
   * straight fingers of a relaxed open hand 123–177°.
   */
  curlEnter: 105,
  curlStay: 118,
  /** Image-space curl test: the fingertip is no farther from the wrist than this × its PIP joint. */
  tipInside: 1.05,
  /** A middle finger seen straighter than this (degrees, and its tip not inside) cannot start an L: that hand is a "3". */
  middleStraight: 140,
  /** How many of middle, ring and pinky must be curled to start / to keep an L. */
  lCurledEnter: 2,
  lCurledStay: 1,
  /** OK ring, equivalent radius / hand size: to start / to keep. */
  ringEnter: 0.12,
  ringStay: 0.08,
  /** Image-space index straightness (chord / arc), used when the world landmarks are not trusted. */
  index2dEnter: 0.9,
  index2dStay: 0.8,
  /** Image-space thumb reach (thumb tip ↔ index knuckle / hand size). Real Ls 0.78–1.04, open palms 0.63–0.70, folded thumbs ≤ 0.57. */
  thumb2dEnter: 0.72,
  thumb2dStay: 0.55,
  /** Image-space pinch (thumb tip ↔ index tip / hand size). Real OK signs 0.07–0.20; every L, open palm and pointing hand ≥ 0.87. */
  pinch2dEnter: 0.25,
  pinch2dStay: 0.38,
  /** The 3D pinch ratio may be this loose and still confirm an image-space pinch (it misses 3 of 5 real OK signs at 0.63–0.73). */
  pinch3Loose: 0.9,
  /** Thumb tip ↔ index tip / palm length (3D) that makes and keeps a pinch: the classifier's own values. */
  pinchEnter: SHAPE_THRESHOLDS.pinchEnter,
  pinchStay: SHAPE_THRESHOLDS.pinchExit,
  /** Image-space reach (fingertip ↔ wrist / hand size) from which a finger is seen to stick out. Real open hands ≥ 1.42 on two fingers, curled ≤ 0.91. */
  reach2d: 1.3,
  /** Image-space fist: every fingertip (index to pinky) is no farther from the wrist than this × its PIP joint. */
  fistInside: 0.85,
  /** Facing vote: |cPalm| under this is edge-on (no vote from the palm). */
  facingMin: 0.25,
  /** Facing vote: |cL| an L-shaped hand needs to vote while its palm is edge-on. */
  lFacingMin: 0.4,
  /** More landmarks than this outside the picture: the hand is clipped and the result is not trusted. */
  maxOutOfFrame: 4,
  /** A change of hand size by more than this fraction within `s2JumpWindowMs` is not trusted. */
  s2Jump: 0.4,
  s2JumpWindowMs: 300,
  /** World landmarks are trusted while the palm is this long (metres)… */
  palmMinM: 0.06,
  palmMaxM: 0.12,
  /** …and the knuckle row (index to pinky) is this wide, in palm lengths. */
  knuckleMin: 0.45,
  knuckleMax: 1.1,
  /** A ring outline enclosing less than this (frame heights²) has no usable centroid. */
  ringMinArea: 1e-5,
} as const;

/**
 * A HandPose plus the numbers that ride along from result to result or into the debug
 * readout. They live on the returned object, not in module state, so `classifyPose` stays
 * a function of its arguments even if the caller copies poses (a copy only loses them).
 */
interface PoseMemory extends HandPose {
  /** Hand size measured on a result that was not trusted. `s2` keeps the last trusted size. */
  untrustedS2?: number;
  /** The index–thumb angle from the world landmarks, degrees: debug readout only. */
  phi3Deg?: number;
}

const DEG = 180 / Math.PI;

/** Middle, ring, pinky: [PIP joint, fingertip]. */
const OTHER_FINGERS = [
  [LM.MIDDLE_PIP, LM.MIDDLE_TIP],
  [LM.RING_PIP, LM.RING_TIP],
  [LM.PINKY_PIP, LM.PINKY_TIP],
] as const;
/** Index to pinky: [PIP joint, fingertip]. */
const FOUR_FINGERS = [[LM.INDEX_PIP, LM.INDEX_TIP], ...OTHER_FINGERS] as const;

/** Thumb tip → thumb base → index base → index tip: the outline of the thumb–index ring. */
const RING_OUTLINE = [
  LM.THUMB_TIP,
  LM.THUMB_IP,
  LM.THUMB_MCP,
  LM.INDEX_MCP,
  LM.INDEX_PIP,
  LM.INDEX_DIP,
  LM.INDEX_TIP,
] as const;

const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const sign = (v: number): 1 | -1 | 0 => (v > 0 ? 1 : v < 0 ? -1 : 0);
const count = (flags: readonly boolean[]) => flags.reduce((n, f) => n + (f ? 1 : 0), 0);

/** On once `value` reaches `enter`, then on until it drops below `stay`. (classifier.ts keeps its own helper private.) */
const latch = (value: number, was: boolean, enter: number, stay: number) => value >= (was ? stay : enter);

/** Angle between two vectors, degrees. 0 when either has no length. */
function angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const n = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
  if (!(n > 0)) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / n))) * DEG;
}

/** Cross product of the two directions, each scaled to unit length: -1..1. 0 when either has no length. */
function crossOfUnits(ux: number, uy: number, vx: number, vy: number): number {
  const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return n > 0 ? (ux * vy - uy * vx) / n : 0;
}

/** Chord / arc of the index finger in the image: about 1 when it is straight. */
function indexStraightness2d(q: Vec2[]): number {
  const arc =
    dist(q[LM.INDEX_MCP], q[LM.INDEX_PIP]) + dist(q[LM.INDEX_PIP], q[LM.INDEX_DIP]) + dist(q[LM.INDEX_DIP], q[LM.INDEX_TIP]);
  return arc > 1e-9 ? dist(q[LM.INDEX_MCP], q[LM.INDEX_TIP]) / arc : 0;
}

/**
 * The thumb–index ring: area centroid and equivalent radius of its outline.
 * `q` is isotropic (frame heights); the centre is returned in stage space.
 */
function measureRing(q: Vec2[], s2: number, aspect: number): NonNullable<HandPose["ring"]> {
  let doubleArea = 0;
  let cx = 0;
  let cy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < RING_OUTLINE.length; i++) {
    const a = q[RING_OUTLINE[i]];
    const b = q[RING_OUTLINE[(i + 1) % RING_OUTLINE.length]];
    const w = a.x * b.y - b.x * a.y;
    doubleArea += w;
    cx += (a.x + b.x) * w;
    cy += (a.y + b.y) * w;
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x);
    y1 = Math.max(y1, a.y);
  }
  const area = Math.abs(doubleArea) / 2;
  let center = { x: cx / (3 * doubleArea), y: cy / (3 * doubleArea) };
  // A flattened or self-crossing outline has no meaningful centroid: its lobes cancel and the
  // quotient flies off. Fall back to the middle of the ring's two ends: the pinch point and
  // the web between thumb and index finger.
  const usable = area >= POSE_T.ringMinArea && center.x >= x0 && center.x <= x1 && center.y >= y0 && center.y <= y1;
  if (!usable) {
    center = {
      x: (q[LM.THUMB_TIP].x + q[LM.INDEX_TIP].x + q[LM.THUMB_MCP].x + q[LM.INDEX_MCP].x) / 4,
      y: (q[LM.THUMB_TIP].y + q[LM.INDEX_TIP].y + q[LM.THUMB_MCP].y + q[LM.INDEX_MCP].y) / 4,
    };
  }
  const rEq = Math.sqrt(area / Math.PI);
  return { center: { x: center.x / aspect, y: center.y }, rEq, openness: rEq / s2 };
}

/**
 * The pose of one hand for one tracking result.
 *
 * @param shape  `classifyHand(obs.world, previousShape)` for the same result.
 * @param aspect camera width / height, to make stage space isotropic.
 * @param time   result time, ms.
 * @param prev   what this function returned for the same hand on the previous result. It
 *               carries all hysteresis; leave it out for a hand seen for the first time.
 *
 * `name` is the first that applies of OK, L, point, fist, palm; the five booleans mirror
 * it, so at most one of them is true.
 */
export function classifyPose(obs: HandObservation, shape: HandShape, aspect: number, time: number, prev?: HandPose): HandPose {
  const T = POSE_T;
  const P = obs.points;
  const W = obs.world;
  // Isotropic image space, frame heights, mirrored like the display.
  const q: Vec2[] = P.map((p) => ({ x: p.x * aspect, y: p.y }));
  const wrist = q[LM.WRIST];

  // ── Measurements ──────────────────────────────────────────────────────────────────────
  // Hand size: the longest side of the wrist / index-knuckle / pinky-knuckle triangle. One of
  // its sides stays near full length however the hand is turned, so it is not a view artefact.
  const s2 = Math.max(dist(wrist, q[LM.INDEX_MCP]), dist(q[LM.INDEX_MCP], q[LM.PINKY_MCP]), dist(q[LM.PINKY_MCP], wrist));
  const size = Math.max(s2, 1e-9);

  let outOfFrame = 0;
  for (const p of P) if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) outOfFrame++;

  // Metric sanity: a real palm is 6–12 cm long and the knuckle row about three quarters of
  // that. The back of a hand, and some open hands, come back smaller or narrower than that.
  const palm3 = d3(W[LM.WRIST], W[LM.MIDDLE_MCP]);
  const knuckles = d3(W[LM.INDEX_MCP], W[LM.PINKY_MCP]);
  const worldOk =
    palm3 >= T.palmMinM && palm3 <= T.palmMaxM && knuckles >= T.knuckleMin * palm3 && knuckles <= T.knuckleMax * palm3;

  const curlDeg = OTHER_FINGERS.map(([pip, tip]) =>
    angleBetween(
      W[LM.WRIST].x - W[pip].x,
      W[LM.WRIST].y - W[pip].y,
      W[LM.WRIST].z - W[pip].z,
      W[tip].x - W[pip].x,
      W[tip].y - W[pip].y,
      W[tip].z - W[pip].z,
    ),
  ) as [number, number, number];
  const tipInside = (pip: number, tip: number, factor: number = T.tipInside) => dist(q[tip], wrist) < factor * dist(q[pip], wrist);

  // Index direction (knuckle → tip) and thumb direction (MCP → tip), in the image.
  const ix = q[LM.INDEX_TIP].x - q[LM.INDEX_MCP].x;
  const iy = q[LM.INDEX_TIP].y - q[LM.INDEX_MCP].y;
  const tx = q[LM.THUMB_TIP].x - q[LM.THUMB_MCP].x;
  const ty = q[LM.THUMB_TIP].y - q[LM.THUMB_MCP].y;
  // The L is judged in the image: the world angle is unreliable on real hands (see the header).
  const phiDeg = angleBetween(ix, iy, 0, tx, ty, 0);
  const phi3Deg = angleBetween(
    W[LM.INDEX_TIP].x - W[LM.INDEX_MCP].x,
    W[LM.INDEX_TIP].y - W[LM.INDEX_MCP].y,
    W[LM.INDEX_TIP].z - W[LM.INDEX_MCP].z,
    W[LM.THUMB_TIP].x - W[LM.THUMB_MCP].x,
    W[LM.THUMB_TIP].y - W[LM.THUMB_MCP].y,
    W[LM.THUMB_TIP].z - W[LM.THUMB_MCP].z,
  );

  const cPalm = crossOfUnits(
    q[LM.INDEX_MCP].x - wrist.x,
    q[LM.INDEX_MCP].y - wrist.y,
    q[LM.PINKY_MCP].x - wrist.x,
    q[LM.PINKY_MCP].y - wrist.y,
  );
  const cL = crossOfUnits(ix, iy, tx, ty);
  const ring = measureRing(q, size, aspect);

  // Image-space stand-ins for the classifier's thumb and pinch terms, in hand sizes.
  const thumb2d = dist(q[LM.THUMB_TIP], q[LM.INDEX_MCP]) / size;
  const pinch2d = dist(q[LM.THUMB_TIP], q[LM.INDEX_TIP]) / size;
  // The smaller of the two pinch measures, so a consumer's own "still pinching" check (the
  // loupe) sees the real OK signs whose 3D ratio reads 0.6–0.7 with the tips visibly touching.
  const pinchRatio = worldOk ? Math.min(shape.pinchIndexRatio, pinch2d) : pinch2d;

  // ── Can this result be trusted? ───────────────────────────────────────────────────────
  // A clipped hand has extrapolated landmarks. A sudden change of size is a detection that
  // landed somewhere else for one result; a real change is accepted as soon as the next
  // result agrees with it (or with the size before the jump, when it was a one-off).
  const differs = (a: number, b: number) => Math.abs(a - b) > T.s2Jump * b;
  let jumped = false;
  if (prev && time - prev.at < T.s2JumpWindowMs && differs(s2, prev.s2)) {
    const seen = (prev as PoseMemory).untrustedS2;
    jumped = seen === undefined || differs(s2, seen);
  }
  if (outOfFrame > T.maxOutOfFrame || jumped || !(s2 > 0)) {
    if (prev) {
      // Everything is held: flags and measurements stay those of the last trusted result.
      const held: PoseMemory = {
        ...prev,
        curled: [...prev.curled],
        curlDeg: [...prev.curlDeg],
        ring: prev.ring && { ...prev.ring, center: { ...prev.ring.center } },
        uncertain: true,
        facing: 0,
        at: time,
        untrustedS2: s2,
      };
      return held;
    }
    // First sight of this hand and it cannot be trusted: nothing to hold, so no pose yet.
    const blank: PoseMemory = {
      name: null,
      l: false,
      ok: false,
      point: false,
      fist: false,
      palm: false,
      indexOut: false,
      thumbOut: false,
      curled: [false, false, false],
      curlDeg,
      phiDeg,
      pinchRatio,
      worldOk,
      uncertain: true,
      s2,
      cPalm,
      cL,
      facing: 0,
      ring,
      at: time,
      untrustedS2: s2,
      phi3Deg,
    };
    return blank;
  }

  // ── Flags ─────────────────────────────────────────────────────────────────────────────
  // With trusted world landmarks the classifier's finger flags are used as they are. Without
  // them nothing from `shape` is used: each term has an image-space stand-in. The thumb takes
  // the stand-in as well in both cases, because the classifier's 3D thumb sits right at its
  // threshold on several real Ls.
  const indexOut = worldOk
    ? shape.extended[1]
    : latch(indexStraightness2d(q), prev?.indexOut ?? false, T.index2dEnter, T.index2dStay);
  const thumbOut = (worldOk && shape.extended[0]) || latch(thumb2d, prev?.thumbOut ?? false, T.thumb2dEnter, T.thumb2dStay);

  // Curled is its own flag, never "not extended": a loosely curled finger sits inside the
  // classifier's hysteresis band and would read as whatever it was before. The image test
  // holds for every real curled finger, including those of a hand seen from the back.
  const curled = OTHER_FINGERS.map(
    ([pip, tip], i) => tipInside(pip, tip) || (worldOk && curlDeg[i] < (prev?.curled[i] ? T.curlStay : T.curlEnter)),
  ) as [boolean, boolean, boolean];
  const curledCount = count(curled);

  // A pinch is the classifier's, or tips that touch in the image while the 3D ratio is at
  // least not wide open. Once an OK sign is made, either measure keeps it (looser bounds).
  const pinch = (worldOk && shape.pinchIndex) || (pinch2d < T.pinch2dEnter && (!worldOk || shape.pinchIndexRatio < T.pinch3Loose));
  const pinchHeld = pinch2d < T.pinch2dStay || (worldOk && shape.pinchIndexRatio < T.pinchStay);

  // Middle, ring and pinky whose tips are seen well away from the wrist. A finger that points at
  // the camera does not reach, whatever the landmarks claim about its joints.
  const reaches = OTHER_FINGERS.map(([, tip]) => dist(q[tip], wrist) >= T.reach2d * size);
  const othersOut = worldOk ? count(shape.extended.slice(2)) : count(reaches.map((r, i) => r && !curled[i]));
  // A fist tucks every fingertip in, and that shows in the image whatever the depth says. So the
  // image alone can call a fist, and one the world landmarks claim must at least tuck the index
  // tip as far: the bent index of an OK sign (tip at 0.99 of its PIP) is not a fist, a real
  // fist's index reads 0.64–0.66.
  const fist =
    FOUR_FINGERS.every(([pip, tip]) => tipInside(pip, tip, T.fistInside)) ||
    (worldOk && shape.fist && tipInside(LM.INDEX_PIP, LM.INDEX_TIP, T.fistInside));

  // ── Poses ─────────────────────────────────────────────────────────────────────────────
  const ringOpen = ring.openness >= (prev?.ok ? T.ringStay : T.ringEnter);
  // Once made, an OK sign lasts as long as the pinch and the ring do, whatever the other
  // fingers do. A fist ends it: thumb on a curled index finger still looks like a small ring.
  const ok = !fist && ringOpen && (prev?.ok ? pinchHeld : pinch && othersOut >= 2 && !(worldOk && shape.pinchMiddle));
  // No upper bound on the angle (an L seen side-on projects wider than a right angle) and no
  // test of the thumb's own joint, the noisiest one. A half-bent finger keeps an L going. A
  // middle finger seen clearly straight cannot start one: that is a "3", not an L.
  const middleStraight = worldOk && !curled[0] && curlDeg[0] > T.middleStraight;
  const l =
    indexOut &&
    thumbOut &&
    !pinch &&
    (prev?.l
      ? phiDeg >= T.phiStay && curledCount >= T.lCurledStay
      : phiDeg >= T.phiEnter && curledCount >= T.lCurledEnter && !middleStraight);
  const point = indexOut && curledCount >= 2 && !(thumbOut && phiDeg >= T.phiEnter) && !pinch;
  // An open palm lets go of the frame, so it has to be seen, not inferred: while a hand is
  // tipped over its fingers point at the camera, where curled and straight look the same and
  // the depth that would tell them apart is the least reliable. (Requiring the palm to face
  // the camera as well was tried and rejected: it cost open-palm recognition at steep views
  // and did not remove the few false palms a loosely curled L gives at those views.)
  const palm = !fist && (indexOut ? 1 : 0) + othersOut >= 3 && curledCount <= 1 && !pinch && count(reaches) >= 2;

  const name: PoseName | null = ok ? "OK" : l ? "L" : point ? "point" : fist ? "fist" : palm ? "palm" : null;

  // ── Facing vote ───────────────────────────────────────────────────────────────────────
  // The palm's winding says which side faces the camera, until the hand is edge-on. Then an
  // L-shaped hand can still tell: its index and thumb wind the opposite way to its palm.
  // If the two disagree the skeleton is inconsistent and the result does not vote.
  const palmVote = Math.abs(cPalm) >= T.facingMin ? sign(cPalm) : 0;
  const lVote = indexOut && thumbOut && Math.abs(cL) >= T.lFacingMin ? sign(-cL) : 0;
  const facing = palmVote !== 0 && lVote !== 0 && palmVote !== lVote ? 0 : palmVote || lVote;

  const pose: PoseMemory = {
    name,
    l: name === "L",
    ok: name === "OK",
    point: name === "point",
    fist: name === "fist",
    palm: name === "palm",
    indexOut,
    thumbOut,
    curled,
    curlDeg,
    phiDeg,
    pinchRatio,
    worldOk,
    uncertain: false,
    s2,
    cPalm,
    cL,
    facing,
    ring,
    at: time,
    phi3Deg,
  };
  return pose;
}

/**
 * One compact line for the on-screen debug readout (`?debug=poses`), e.g.
 * `phi 111/111 · curl 81/54/40 · cP +0.77 cL -0.93 · pinch 2.19 · ring 0.44 · s2 0.16 · IT MRP 3d f+`.
 * `phi` is the image angle the classifier uses, then the world angle for comparison (shown
 * when the pose carries it). Flags: I index out, T thumb out, M R P the curled fingers
 * (`-` = not), `3d` / `2d` which landmarks were trusted, `f+` / `f-` / `f0` the facing vote,
 * and a trailing `?` on a result that was not trusted (everything shown is then held from
 * the last trusted one).
 */
export function describePose(pose: HandPose): string {
  const signed = (v: number) => (v < 0 ? "" : "+") + v.toFixed(2);
  const flag = (on: boolean, letter: string) => (on ? letter : "-");
  const phi3 = (pose as PoseMemory).phi3Deg;
  const flags =
    flag(pose.indexOut, "I") +
    flag(pose.thumbOut, "T") +
    " " +
    flag(pose.curled[0], "M") +
    flag(pose.curled[1], "R") +
    flag(pose.curled[2], "P") +
    (pose.worldOk ? " 3d" : " 2d") +
    (pose.facing > 0 ? " f+" : pose.facing < 0 ? " f-" : " f0") +
    (pose.uncertain ? " ?" : "");
  return [
    `phi ${Math.round(pose.phiDeg)}${phi3 === undefined ? "" : `/${Math.round(phi3)}`}`,
    `curl ${pose.curlDeg.map((d) => Math.round(d)).join("/")}`,
    `cP ${signed(pose.cPalm)} cL ${signed(pose.cL)}`,
    `pinch ${pose.pinchRatio.toFixed(2)}`,
    `ring ${pose.ring ? pose.ring.openness.toFixed(2) : "-"}`,
    `s2 ${pose.s2.toFixed(2)}`,
    flags,
  ].join(" · ");
}
