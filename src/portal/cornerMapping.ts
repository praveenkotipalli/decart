import type { Vec2 } from "../geometry/vec";
import type { HandRole, TrackedHand, TrackingMode } from "../tracking/handAssignment";
import { LM, type LandmarkIndex } from "../tracking/landmarks";

export interface CornerSource {
  role: HandRole;
  landmark: LandmarkIndex;
}

/** Sources for P1 (top-left), P2 (top-right), P3 (bottom-right), P4 (bottom-left). */
export type CornerMapping = [CornerSource, CornerSource, CornerSource, CornerSource];

export const CORNER_NAMES = ["P1", "P2", "P3", "P4"] as const;
export const CORNER_LABELS = ["Top left", "Top right", "Bottom right", "Bottom left"] as const;

/**
 * "Frame" pose: palms toward the camera, index fingers up, thumbs spread inward
 * and down. Each hand's index tip is a top corner and its thumb tip the bottom
 * corner below it, so the four tips outline the portal.
 */
export const DEFAULT_TWO_HAND_MAPPING: CornerMapping = [
  { role: "A", landmark: LM.INDEX_TIP },
  { role: "B", landmark: LM.INDEX_TIP },
  { role: "B", landmark: LM.THUMB_TIP },
  { role: "A", landmark: LM.THUMB_TIP },
];

/**
 * One spread hand, palm to camera, as seen for a right hand in the mirrored view
 * (index left of pinky): index tip, pinky tip, wrist, thumb tip run clockwise.
 */
export const DEFAULT_ONE_HAND_MAPPING: CornerMapping = [
  { role: "A", landmark: LM.INDEX_TIP },
  { role: "A", landmark: LM.PINKY_TIP },
  { role: "A", landmark: LM.WRIST },
  { role: "A", landmark: LM.THUMB_TIP },
];

/** Mirror image of a mapping: swaps left and right corners, keeping clockwise order. */
export function mirrorMapping(m: CornerMapping): CornerMapping {
  return [m[1], m[0], m[3], m[2]];
}

/** Swaps the top and bottom corner driven by one hand (calibration uses this). */
export function swapVertical(m: CornerMapping, role: HandRole): CornerMapping {
  const r = [...m] as CornerMapping;
  const [top, bottom] = role === "A" ? [0, 3] : [1, 2];
  [r[top], r[bottom]] = [r[bottom], r[top]];
  return r;
}

export interface ResolvedCorner {
  point: Vec2;
  handId: number;
  /** false while the source hand is coasting through a short dropout */
  fresh: boolean;
}

/**
 * Picks the mapping for this frame. In one-hand mode the hand's chirality decides
 * whether the configured mapping or its mirror is used, so the outline stays
 * clockwise whether the palm or the back of the hand faces the camera — while an
 * in-plane rotation of the hand still rotates the portal.
 */
export function effectiveMapping(
  mode: TrackingMode,
  twoHand: CornerMapping,
  oneHand: CornerMapping,
  hands: TrackedHand[],
): CornerMapping {
  if (mode === "two-hand") return twoHand;
  const a = hands.find((h) => h.role === "A");
  return a && a.chirality < 0 ? mirrorMapping(oneHand) : oneHand;
}

export function resolveCorners(mapping: CornerMapping, hands: TrackedHand[]): (ResolvedCorner | null)[] {
  return mapping.map((src) => {
    const hand = hands.find((h) => h.role === src.role);
    if (!hand) return null;
    const p = hand.obs.points[src.landmark];
    return { point: { x: p.x, y: p.y }, handId: hand.id, fresh: hand.fresh };
  });
}
