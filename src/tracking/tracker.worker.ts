/// <reference lib="webworker" />
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import type { RawHands, WorkerRequest, WorkerResponse } from "./trackerProtocol";

// Hand landmark inference off the main thread, so a slow frame never stalls rendering.
let landmarker: HandLandmarker | null = null;
const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

function pack(res: HandLandmarkerResult): RawHands {
  return {
    landmarks: res.landmarks.map((h) => h.map(({ x, y, z }) => ({ x, y, z }))),
    world: res.worldLandmarks.map((h) => h.map(({ x, y, z }) => ({ x, y, z }))),
    handedness: res.handedness.map((c) => ({ label: c[0]?.categoryName ?? "", score: c[0]?.score ?? 0 })),
  };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      const fileset = await FilesetResolver.forVisionTasks(msg.wasm, msg.useModule);
      const base = {
        runningMode: "VIDEO" as const,
        numHands: 2,
        minHandDetectionConfidence: msg.options.minDetection,
        minHandPresenceConfidence: msg.options.minPresence,
        minTrackingConfidence: msg.options.minTracking,
      };
      let delegate: "GPU" | "CPU" = msg.delegate === "CPU" ? "CPU" : "GPU";
      try {
        if (delegate === "CPU") throw new Error("CPU requested");
        landmarker = await HandLandmarker.createFromOptions(fileset, {
          ...base,
          baseOptions: { modelAssetPath: msg.model, delegate: "GPU" },
          canvas: new OffscreenCanvas(1, 1),
        });
      } catch {
        delegate = "CPU";
        landmarker = await HandLandmarker.createFromOptions(fileset, {
          ...base,
          baseOptions: { modelAssetPath: msg.model, delegate: "CPU" },
        });
      }
      post({ type: "ready", delegate });
    } catch (err) {
      post({ type: "error", message: (err as Error)?.message ?? String(err) });
    }
  } else if (msg.type === "detect") {
    if (!landmarker) {
      msg.frame.close();
      return;
    }
    const t0 = performance.now();
    try {
      const res = landmarker.detectForVideo(msg.frame, msg.ts);
      post({ type: "result", ts: msg.ts, inferenceMs: performance.now() - t0, hands: pack(res) });
    } catch (err) {
      post({ type: "error", message: (err as Error)?.message ?? String(err) });
    } finally {
      msg.frame.close();
    }
  } else if (msg.type === "options") {
    await landmarker?.setOptions({
      minHandDetectionConfidence: msg.options.minDetection,
      minHandPresenceConfidence: msg.options.minPresence,
      minTrackingConfidence: msg.options.minTracking,
    });
  }
};
