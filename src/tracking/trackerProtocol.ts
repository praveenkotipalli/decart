import type { HandFrame, HandObservation } from "./landmarks";

/** Keep in step with the installed @mediapipe/tasks-vision version (CDN fallback only). */
export const MEDIAPIPE_VERSION = "1.2.0";
export const LOCAL_WASM = "/mediapipe/wasm";
export const LOCAL_MODEL = "/mediapipe/hand_landmarker.task";
export const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const CDN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

export interface TrackerOptions {
  minDetection: number;
  minPresence: number;
  minTracking: number;
}

type P3 = { x: number; y: number; z: number };

/** Detection result as it crosses the worker boundary (plain data only). */
export interface RawHands {
  landmarks: P3[][];
  world: P3[][];
  handedness: { label: string; score: number }[];
}

export type DelegatePreference = "auto" | "GPU" | "CPU";

export type WorkerRequest =
  | { type: "init"; wasm: string; model: string; useModule: boolean; options: TrackerOptions; delegate: DelegatePreference }
  | { type: "detect"; frame: VideoFrame | ImageBitmap; ts: number }
  | { type: "options"; options: TrackerOptions };

export type WorkerResponse =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string }
  | { type: "result"; ts: number; inferenceMs: number; hands: RawHands };

/**
 * Converts a detection into stage space. MediaPipe labels handedness as if the
 * image were a mirrored selfie; we feed the raw camera frame, so its labels are
 * swapped — undo that to get the real hand.
 */
export function toHandFrame(raw: RawHands, time: number, aspect: number, mirror: boolean, inferenceMs: number): HandFrame {
  const hands: HandObservation[] = raw.landmarks.map((lms, i) => {
    const h = raw.handedness[i];
    return {
      points: lms.map((p) => ({ x: mirror ? 1 - p.x : p.x, y: p.y, z: p.z })),
      world: (raw.world[i] ?? lms).map((p) => ({ x: p.x, y: p.y, z: p.z })),
      handedness: h?.label === "Left" ? "Right" : "Left",
      score: h?.score ?? 0,
    };
  });
  return { time, hands, aspect, inferenceMs };
}

/** Is a file really served at `url`? (Vite answers unknown paths with index.html.) */
export async function served(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}
