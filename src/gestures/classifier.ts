import { LM, type Vec3 } from "../tracking/landmarks";

/**
 * Static hand-shape flags for one frame. Computed from MediaPipe's *world*
 * landmarks (metres, hand-centred), so thresholds are independent of how far the
 * hand is from the camera and how it is rotated. Every flag has separate enter
 * and exit thresholds so it does not flicker at the boundary.
 */
export interface HandShape {
  /** thumb, index, middle, ring, pinky */
  extended: [boolean, boolean, boolean, boolean, boolean];
  pinchIndex: boolean;
  pinchMiddle: boolean;
  fist: boolean;
  openPalm: boolean;
  /** thumb-tip ↔ index-tip distance / palm length */
  pinchIndexRatio: number;
  /** thumb-tip ↔ middle-tip distance / palm length */
  pinchMiddleRatio: number;
  /** wrist ↔ middle-MCP distance, metres */
  palmLength: number;
}

export const SHAPE_THRESHOLDS = {
  fingerStraightEnter: 0.86,
  fingerStraightExit: 0.76,
  thumbOutEnter: 0.62,
  thumbOutExit: 0.5,
  pinchEnter: 0.3,
  pinchExit: 0.42,
  fistEnter: 0.95,
  fistExit: 1.1,
  /** fingertip span (index↔pinky) / knuckle span: ~1 fingers together, ~1.5 spread */
  spreadEnter: 1.3,
  spreadExit: 1.15,
} as const;

const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** True when `value` is past `enter` (or, if it was already on, not yet back past `exit`). */
function hysteresis(value: number, was: boolean, enter: number, exit: number, below: boolean): boolean {
  if (below) return was ? value < exit : value < enter;
  return was ? value > exit : value > enter;
}

const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP],
];

/** Chord / arc length of a finger: ~1 when straight, ~0.5 when curled. */
export function fingerStraightness(w: Vec3[], [mcp, pip, dip, tip]: readonly number[]): number {
  const arc = d3(w[mcp], w[pip]) + d3(w[pip], w[dip]) + d3(w[dip], w[tip]);
  return arc > 1e-9 ? d3(w[mcp], w[tip]) / arc : 0;
}

export function classifyHand(w: Vec3[], prev?: HandShape): HandShape {
  const T = SHAPE_THRESHOLDS;
  const palmLength = Math.max(d3(w[LM.WRIST], w[LM.MIDDLE_MCP]), 1e-6);

  const fingers = FINGERS.map((f, i) =>
    hysteresis(fingerStraightness(w, f), prev?.extended[i + 1] ?? false, T.fingerStraightEnter, T.fingerStraightExit, false),
  );
  // The thumb is "out" when its tip is well away from the base of the index finger.
  const thumbOut = hysteresis(
    d3(w[LM.THUMB_TIP], w[LM.INDEX_MCP]) / palmLength,
    prev?.extended[0] ?? false,
    T.thumbOutEnter,
    T.thumbOutExit,
    false,
  );

  const pinchIndexRatio = d3(w[LM.THUMB_TIP], w[LM.INDEX_TIP]) / palmLength;
  const pinchMiddleRatio = d3(w[LM.THUMB_TIP], w[LM.MIDDLE_TIP]) / palmLength;
  const pinchIndex = hysteresis(pinchIndexRatio, prev?.pinchIndex ?? false, T.pinchEnter, T.pinchExit, true);
  // Thumb→middle only counts when it is clearly the middle finger, not an index pinch.
  const pinchMiddle =
    hysteresis(pinchMiddleRatio, prev?.pinchMiddle ?? false, T.pinchEnter, T.pinchExit, true) &&
    pinchMiddleRatio < pinchIndexRatio * 0.85;

  const palm = {
    x: (w[LM.WRIST].x + w[LM.INDEX_MCP].x + w[LM.MIDDLE_MCP].x + w[LM.PINKY_MCP].x) / 4,
    y: (w[LM.WRIST].y + w[LM.INDEX_MCP].y + w[LM.MIDDLE_MCP].y + w[LM.PINKY_MCP].y) / 4,
    z: (w[LM.WRIST].z + w[LM.INDEX_MCP].z + w[LM.MIDDLE_MCP].z + w[LM.PINKY_MCP].z) / 4,
  };
  const tipReach =
    FINGERS.reduce((s, f) => s + d3(w[f[3]], palm), 0) / FINGERS.length / palmLength;
  const fist = hysteresis(tipReach, prev?.fist ?? false, T.fistEnter, T.fistExit, true) && !fingers.some(Boolean);

  const spread = d3(w[LM.INDEX_TIP], w[LM.PINKY_TIP]) / Math.max(d3(w[LM.INDEX_MCP], w[LM.PINKY_MCP]), 1e-6);
  const openPalm =
    fingers.every(Boolean) &&
    thumbOut &&
    !pinchIndex &&
    !pinchMiddle &&
    hysteresis(spread, prev?.openPalm ?? false, T.spreadEnter, T.spreadExit, false);

  return {
    extended: [thumbOut, fingers[0], fingers[1], fingers[2], fingers[3]],
    pinchIndex,
    pinchMiddle,
    fist,
    openPalm,
    pinchIndexRatio,
    pinchMiddleRatio,
    palmLength,
  };
}
