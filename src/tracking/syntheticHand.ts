import { LM, type HandObservation, type Vec3 } from "./landmarks";

/**
 * A kinematic stand-in for a MediaPipe hand: produces the same 21 landmarks in
 * stage space and metric world space. Used by the unit tests and by the
 * "simulated hands" demo, so gestures and portal logic can be exercised without
 * a camera.
 */
export interface SyntheticHandPose {
  /** Palm centre in stage space ([0,1]², x across the displayed frame). */
  x: number;
  y: number;
  /** Wrist → middle knuckle length, in frame heights. */
  size: number;
  /** In-plane rotation, radians, clockwise on screen. 0 = fingers up. */
  rotation: number;
  /** +1: index left of pinky on screen (right hand, palm to camera, mirrored view). */
  chirality: 1 | -1;
  /** Curl per finger, 0 = straight, 1 = fully curled: thumb, index, middle, ring, pinky. */
  curls: [number, number, number, number, number];
  /** Finger fan multiplier, 1 = relaxed spread. */
  spread: number;
  /** Thumb direction in hand space, degrees from +x (y down): 180 = across, 225 = up-left. */
  thumbAngle: number;
  /** Put the thumb tip on this fingertip (a pinch). */
  thumbTo?: "index" | "middle" | null;
}

export const RELAXED_POSE: SyntheticHandPose = {
  x: 0.5,
  y: 0.5,
  size: 0.16,
  rotation: 0,
  chirality: 1,
  curls: [0, 0, 0, 0, 0],
  spread: 1,
  thumbAngle: 215,
  thumbTo: null,
};

const PALM_METRES = 0.085;

// Hand space: palm length 1, wrist at origin, fingers toward -y, z toward the camera is negative.
const MCP = [
  { x: -0.34, y: -0.94 },
  { x: -0.02, y: -1.0 },
  { x: 0.27, y: -0.95 },
  { x: 0.5, y: -0.84 },
];
const SEGMENTS = [
  [0.46, 0.27, 0.22],
  [0.52, 0.31, 0.23],
  [0.48, 0.29, 0.22],
  [0.37, 0.22, 0.2],
];
const FAN_DEG = [-9, 0, 8, 17];
const BEND_DEG = [75, 100, 70];

function fingerChain(i: number, curl: number, spread: number): Vec3[] {
  const fan = (FAN_DEG[i] * spread * Math.PI) / 180;
  const u = { x: Math.sin(fan), y: -Math.cos(fan) };
  const pts: Vec3[] = [{ x: MCP[i].x, y: MCP[i].y, z: 0 }];
  let bend = 0;
  for (let s = 0; s < 3; s++) {
    bend += (BEND_DEG[s] * curl * Math.PI) / 180;
    const p = pts[pts.length - 1];
    const l = SEGMENTS[i][s];
    pts.push({ x: p.x + u.x * Math.cos(bend) * l, y: p.y + u.y * Math.cos(bend) * l, z: p.z - Math.sin(bend) * l });
  }
  return pts; // mcp, pip, dip, tip
}

export function syntheticHand(pose: SyntheticHandPose, aspect = 16 / 9): HandObservation {
  const local: Vec3[] = new Array(21);
  local[LM.WRIST] = { x: 0, y: 0, z: 0 };

  const fingerStarts = [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  for (let i = 0; i < 4; i++) {
    const chain = fingerChain(i, pose.curls[i + 1], pose.spread);
    chain.forEach((p, k) => (local[fingerStarts[i] + k] = p));
  }

  const cmc = { x: -0.24, y: -0.2, z: 0 };
  const th = (pose.thumbAngle * Math.PI) / 180;
  const d = { x: Math.cos(th), y: Math.sin(th) };
  const mcp = { x: cmc.x + d.x * 0.33, y: cmc.y + d.y * 0.33, z: -0.03 };
  let ip = { x: mcp.x + d.x * 0.3, y: mcp.y + d.y * 0.3, z: -0.05 };
  let tip = { x: ip.x + d.x * 0.26, y: ip.y + d.y * 0.26, z: -0.07 };
  const c = pose.curls[0];
  if (c > 0) {
    const tuckTip = { x: 0.0, y: -0.72, z: -0.28 };
    const tuckIp = { x: -0.22, y: -0.55, z: -0.16 };
    ip = { x: ip.x + (tuckIp.x - ip.x) * c, y: ip.y + (tuckIp.y - ip.y) * c, z: ip.z + (tuckIp.z - ip.z) * c };
    tip = { x: tip.x + (tuckTip.x - tip.x) * c, y: tip.y + (tuckTip.y - tip.y) * c, z: tip.z + (tuckTip.z - tip.z) * c };
  }
  if (pose.thumbTo) {
    const target = local[pose.thumbTo === "index" ? LM.INDEX_TIP : LM.MIDDLE_TIP];
    tip = { x: target.x - 0.03, y: target.y + 0.03, z: target.z - 0.02 };
    ip = { x: (mcp.x + tip.x) / 2 - 0.08, y: (mcp.y + tip.y) / 2, z: (mcp.z + tip.z) / 2 - 0.05 };
  }
  local[LM.THUMB_CMC] = cmc;
  local[LM.THUMB_MCP] = mcp;
  local[LM.THUMB_IP] = ip;
  local[LM.THUMB_TIP] = tip;

  const cos = Math.cos(pose.rotation);
  const sin = Math.sin(pose.rotation);
  // Palm centre in hand space, so (pose.x, pose.y) is where the palm lands.
  const pc = { x: 0.1, y: -0.55 };
  const points = local.map((p) => {
    const lx = (p.x - pc.x) * pose.chirality;
    const ly = p.y - pc.y;
    const rx = (lx * cos - ly * sin) * pose.size;
    const ry = (lx * sin + ly * cos) * pose.size;
    return { x: pose.x + rx / aspect, y: pose.y + ry, z: p.z * pose.size };
  });
  const world = local.map((p) => ({
    x: (p.x - pc.x) * pose.chirality * PALM_METRES,
    y: (p.y - pc.y) * PALM_METRES,
    z: p.z * PALM_METRES,
  }));

  return { points, world, handedness: pose.chirality > 0 ? "Right" : "Left", score: 0.98 };
}

/** The two-hand "frame" pose: index fingers up, thumbs reaching in and down. */
export function framePose(side: "A" | "B", overrides: Partial<SyntheticHandPose> = {}): SyntheticHandPose {
  const a = side === "A";
  return {
    ...RELAXED_POSE,
    x: a ? 0.36 : 0.64,
    y: 0.52,
    chirality: a ? -1 : 1,
    curls: [0, 0, 0.55, 0.7, 0.75],
    thumbAngle: 150,
    ...overrides,
  };
}
