import type { Vec2 } from "../geometry/vec";

/** MediaPipe hand landmark indices. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export type LandmarkIndex = (typeof LM)[keyof typeof LM];

export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Landmarks a portal corner may be bound to, with human labels for the settings UI. */
export const CORNER_LANDMARK_OPTIONS: ReadonlyArray<{ index: LandmarkIndex; label: string }> = [
  { index: LM.THUMB_TIP, label: "Thumb tip" },
  { index: LM.INDEX_TIP, label: "Index tip" },
  { index: LM.MIDDLE_TIP, label: "Middle tip" },
  { index: LM.RING_TIP, label: "Ring tip" },
  { index: LM.PINKY_TIP, label: "Pinky tip" },
  { index: LM.WRIST, label: "Wrist" },
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One detected hand for one frame. */
export interface HandObservation {
  /** 21 landmarks in stage space: [0,1]² over the displayed (mirrored) camera frame. */
  points: Vec3[];
  /** 21 metric landmarks (metres, hand-centred). Rotation/scale invariant — used for gestures. */
  world: Vec3[];
  /** MediaPipe's handedness label, already corrected for the mirrored display. */
  handedness: "Left" | "Right";
  score: number;
}

export interface HandFrame {
  /** Monotonic time of the camera frame, ms. */
  time: number;
  hands: HandObservation[];
  /** Width / height of the camera frame, so stage space can be made isotropic. */
  aspect: number;
  /** Inference duration, ms (0 for simulated input). */
  inferenceMs: number;
}

export const toVec2 = (p: Vec3): Vec2 => ({ x: p.x, y: p.y });

/** Palm centre in stage space: mean of wrist and the four finger bases. */
export function palmCenter(points: Vec3[]): Vec2 {
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += points[i].x;
    y += points[i].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}
