/**
 * Named poses for the synthetic hand, and a way to turn a finished hand over in 3D.
 * Used by the unit tests and by the scripted demo of the hand-frame toy. Everything is
 * built on `syntheticHand` / `framePose`, which are not changed.
 */
import { LM, type HandObservation, type Vec3 } from "./landmarks";
import { framePose, type SyntheticHandPose } from "./syntheticHand";

type Side = "A" | "B";
type Overrides = Partial<SyntheticHandPose>;

/** The relaxed thumb of an open hand, degrees (the value of RELAXED_POSE). */
const THUMB_RELAXED = 215;

/**
 * One half of the two-hand frame: index finger up, thumb reaching in and slightly down,
 * the other three fingers loosely curled. Hand A is the screen-left one, B the screen-right.
 */
export function lPose(side: Side, overrides: Overrides = {}): SyntheticHandPose {
  return framePose(side, overrides);
}

/**
 * OK sign: thumb tip on the tip of a bent index finger, the other three fingers straight.
 * The index curl of 0.45 is what makes the ring round (openness about 0.17).
 */
export function okPose(side: Side, overrides: Overrides = {}): SyntheticHandPose {
  return framePose(side, { curls: [0, 0.45, 0, 0, 0], thumbAngle: THUMB_RELAXED, thumbTo: "index", ...overrides });
}

/** Pointing: index finger up, the thumb tucked over the other three, which are fully curled. */
export function pointPose(side: Side, overrides: Overrides = {}): SyntheticHandPose {
  return framePose(side, { curls: [1, 0, 1, 1, 1], thumbAngle: THUMB_RELAXED, ...overrides });
}

/** Open hand, all five fingers straight, thumb relaxed. */
export function openPose(side: Side, overrides: Overrides = {}): SyntheticHandPose {
  return framePose(side, { curls: [0, 0, 0, 0, 0], thumbAngle: THUMB_RELAXED, ...overrides });
}

/** Closed fist. */
export function fistPose(side: Side, overrides: Overrides = {}): SyntheticHandPose {
  return framePose(side, { curls: [1, 1, 1, 1, 1], thumbAngle: THUMB_RELAXED, ...overrides });
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Unit vector, or null when `v` has no length. */
function unit(v: Vec3): Vec3 | null {
  const n = Math.hypot(v.x, v.y, v.z);
  return n > 1e-12 ? { x: v.x / n, y: v.y / n, z: v.z / n } : null;
}

/** Rodrigues' rotation of `v` about the unit axis `k`, right-handed. */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kxv = cross(k, v);
  const kv = dot(k, v) * (1 - c);
  return { x: v.x * c + kxv.x * s + k.x * kv, y: v.y * c + kxv.y * s + k.y * kv, z: v.z * c + kxv.z * s + k.z * kv };
}

/**
 * Rigidly rotates 21 landmarks about their palm centre (mean of the wrist and the four
 * finger bases, as `palmCenter`): `turn` about the wrist → middle-knuckle axis, then `pitch`
 * about the knuckle row. Both axes are taken from the points as given, so the same call
 * works in any space the hand is expressed in.
 */
function turnPoints(points: Vec3[], turn: number, pitch: number): Vec3[] {
  const bases = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  const centre = { x: 0, y: 0, z: 0 };
  for (const i of bases) {
    centre.x += points[i].x / bases.length;
    centre.y += points[i].y / bases.length;
    centre.z += points[i].z / bases.length;
  }
  const long = unit(sub(points[LM.MIDDLE_MCP], points[LM.WRIST]));
  if (!long) return points.map((p) => ({ ...p }));
  // The knuckle row is not quite square to the long axis; make it so, so that the two
  // rotations are about perpendicular axes that both lie in the palm.
  const row = sub(points[LM.PINKY_MCP], points[LM.INDEX_MCP]);
  const along = dot(row, long);
  const across = unit({ x: row.x - long.x * along, y: row.y - long.y * along, z: row.z - long.z * along });
  return points.map((p) => {
    let v = rotate(sub(p, centre), long, turn);
    if (across) v = rotate(v, across, pitch);
    return { x: centre.x + v.x, y: centre.y + v.y, z: centre.z + v.z };
  });
}

/**
 * Turns a finished observation in 3D about its palm centre, to show a hand being flipped.
 *  - `turn`: about the hand's long axis (wrist → middle knuckle), like turning the forearm.
 *    The index finger keeps pointing the same way; the thumb changes sides.
 *  - `pitch`: about the axis across the palm (the knuckle row), like tipping the hand over.
 *    The fingers end up pointing the opposite way: thumb on top.
 * Radians, right-handed about those axes; π in either shows the back of the hand. When both
 * are given, the hand is turned first and then tipped about its original knuckle row.
 *
 * Stage points are rotated in isotropic space (x × aspect, with z taken as frame heights,
 * which is what `syntheticHand` writes) and projected straight back; world points get the
 * same rotation about their own axes, so the two stay views of one rigid hand. The palm
 * centre does not move.
 */
export function turnHand(obs: HandObservation, r: { turn?: number; pitch?: number }, aspect: number): HandObservation {
  const turn = r.turn ?? 0;
  const pitch = r.pitch ?? 0;
  if (turn === 0 && pitch === 0) {
    return { ...obs, points: obs.points.map((p) => ({ ...p })), world: obs.world.map((p) => ({ ...p })) };
  }
  const isotropic = obs.points.map((p) => ({ x: p.x * aspect, y: p.y, z: p.z }));
  const points = turnPoints(isotropic, turn, pitch).map((p) => ({ x: p.x / aspect, y: p.y, z: p.z }));
  return { ...obs, points, world: turnPoints(obs.world, turn, pitch) };
}
