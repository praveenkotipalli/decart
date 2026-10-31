import type { Vec2 } from "../geometry/vec";
import { LM, palmCenter, type HandFrame, type HandObservation } from "./landmarks";

/**
 * A = the hand on the left of the screen when both hands were acquired, B = the right one.
 * Roles are sticky while both hands stay tracked, so crossing your hands crosses the
 * portal (detected and handled downstream) instead of silently swapping corners.
 */
export type HandRole = "A" | "B";
export type TrackingMode = "two-hand" | "one-hand";

export interface TrackedHand {
  id: number;
  role: HandRole;
  obs: HandObservation;
  palm: Vec2;
  /** Observed in the latest frame (false while coasting through a short dropout). */
  fresh: boolean;
  lastSeen: number;
  /**
   * +1 when the index finger is left of the pinky on screen (a right hand, palm to camera,
   * in the mirrored view), -1 otherwise. Latched with hysteresis; drives one-hand mapping.
   */
  chirality: 1 | -1;
}

export interface AssignerOptions {
  /** How long a lost hand keeps its identity and corners, ms. */
  graceMs: number;
  /** Max palm travel between observations to count as the same hand (frame-height units). */
  maxMatchDistance: number;
}

const CHIRALITY_FLIP_MS = 250;
const CHIRALITY_MIN = 0.002;
/** Matching cost added when MediaPipe's left/right label disagrees with the track's. */
const HANDEDNESS_PENALTY = 0.15;

type InternalTrack = TrackedHand & { flipSince: number | null; velocity: Vec2 };

export function measureChirality(points: HandObservation["points"], aspect: number): number {
  const w = points[LM.WRIST];
  const i = points[LM.INDEX_MCP];
  const p = points[LM.PINKY_MCP];
  const ax = (i.x - w.x) * aspect;
  const ay = i.y - w.y;
  const bx = (p.x - w.x) * aspect;
  const by = p.y - w.y;
  return ax * by - ay * bx;
}

export class HandAssigner {
  private tracks: InternalTrack[] = [];
  private nextId = 1;

  constructor(public options: AssignerOptions = { graceMs: 450, maxMatchDistance: 0.4 }) {}

  reset() {
    this.tracks = [];
  }

  update(frame: HandFrame, mode: TrackingMode): TrackedHand[] {
    const { time, aspect } = frame;
    this.tracks = this.tracks.filter((t) => time - t.lastSeen <= this.options.graceMs);
    for (const t of this.tracks) t.fresh = false;

    const detections = frame.hands.slice(0, 2).map((obs) => ({ obs, palm: palmCenter(obs.points) }));
    const distance = (a: Vec2, b: Vec2) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    // Constant-velocity prediction: when hands pass each other, each one is matched to
    // where it was heading rather than to whichever hand happens to be nearest.
    const predicted = this.tracks.map((t) => {
      const dt = Math.min(time - t.lastSeen, 150) / 1000;
      return { x: t.palm.x + t.velocity.x * dt, y: t.palm.y + t.velocity.y * dt };
    });
    const cost = (d: number, t: number) =>
      distance(detections[d].palm, predicted[t]) +
      (detections[d].obs.handedness !== this.tracks[t].obs.handedness ? HANDEDNESS_PENALTY : 0);

    // Optimal assignment over at most 2x2 candidates: try both pairings.
    const matched = new Map<number, number>(); // detection index -> track index
    if (this.tracks.length && detections.length) {
      const pairings: [number, number][][] = [];
      if (detections.length === 1) pairings.push(...this.tracks.map((_, ti) => [[0, ti]] as [number, number][]));
      else if (this.tracks.length === 1) pairings.push([[0, 0]], [[1, 0]]);
      else pairings.push([[0, 0], [1, 1]], [[0, 1], [1, 0]]);

      let best: [number, number][] = [];
      let bestCost = Infinity;
      for (const pairing of pairings) {
        const valid = pairing.filter(([d, t]) => distance(detections[d].palm, predicted[t]) <= this.options.maxMatchDistance);
        // Prefer more matches, then lower total cost.
        const total = (pairing.length - valid.length) * 1e3 + valid.reduce((s, [d, t]) => s + cost(d, t), 0);
        if (total < bestCost) {
          bestCost = total;
          best = valid;
        }
      }
      for (const [d, t] of best) matched.set(d, t);
    }

    for (const [di, ti] of matched) {
      const t = this.tracks[ti];
      const palm = detections[di].palm;
      const dt = (time - t.lastSeen) / 1000;
      if (dt > 0 && dt < 0.2) {
        const k = 0.5;
        t.velocity = {
          x: t.velocity.x + k * ((palm.x - t.palm.x) / dt - t.velocity.x),
          y: t.velocity.y + k * ((palm.y - t.palm.y) / dt - t.velocity.y),
        };
      } else t.velocity = { x: 0, y: 0 };
      t.obs = detections[di].obs;
      t.palm = palm;
      t.fresh = true;
      t.lastSeen = time;
      this.updateChirality(t, aspect, time);
    }

    let created = 0;
    detections.forEach((det, di) => {
      if (matched.has(di)) return;
      if (this.tracks.length >= 2) {
        // A new hand while two are known: it replaces the one that has been gone longest.
        const stale = this.tracks.filter((t) => !t.fresh).sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (!stale) return;
        this.tracks.splice(this.tracks.indexOf(stale), 1);
      }
      const taken = new Set(this.tracks.map((t) => t.role));
      const role: HandRole =
        !taken.has("A") && (taken.has("B") || det.palm.x < 0.5 || mode === "one-hand") ? "A" : "B";
      const c = measureChirality(det.obs.points, aspect);
      this.tracks.push({
        id: this.nextId++,
        role,
        obs: det.obs,
        palm: det.palm,
        fresh: true,
        lastSeen: time,
        chirality: c >= 0 ? 1 : -1,
        flipSince: null,
        velocity: { x: 0, y: 0 },
      });
      created++;
    });

    if (mode === "two-hand" && created && this.tracks.length === 2) {
      // Second hand just arrived: there is no complete portal to preserve yet,
      // so give roles by screen side, which is what the user expects.
      const [a, b] = this.tracks[0].palm.x <= this.tracks[1].palm.x ? [0, 1] : [1, 0];
      this.tracks[a].role = "A";
      this.tracks[b].role = "B";
    }
    if (mode === "one-hand" && !this.tracks.some((t) => t.role === "A") && this.tracks.length) {
      this.tracks[0].role = "A";
    }

    return this.tracks.map(({ flipSince: _f, velocity: _v, ...t }) => t);
  }

  private updateChirality(t: InternalTrack, aspect: number, time: number) {
    const c = measureChirality(t.obs.points, aspect);
    const sign = c >= 0 ? 1 : -1;
    if (sign === t.chirality || Math.abs(c) < CHIRALITY_MIN) {
      t.flipSince = null;
      return;
    }
    if (t.flipSince === null) t.flipSince = time;
    else if (time - t.flipSince >= CHIRALITY_FLIP_MS) {
      t.chirality = sign;
      t.flipSince = null;
    }
  }
}
