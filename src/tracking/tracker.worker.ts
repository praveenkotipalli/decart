/// <reference lib="webworker" />
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { FaceTask, installModuleImportHook } from "./faceTask";
import type { RawHands, WorkerRequest, WorkerResponse } from "./trackerProtocol";

// Hand landmark inference off the main thread, so a slow frame never stalls rendering.
let landmarker: HandLandmarker | null = null;
type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let fileset: Fileset | null = null;
// Optional second task: the face box. Any failure only switches the face box off.
let faceTask: FaceTask | null = null;
let faceLoading = false;
// Bumped by every face-close, so a create that was still pending when the close arrived is discarded.
let faceGeneration = 0;
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
      // MediaPipe loads its wasm glue with importScripts(), which a module worker does not
      // have; this hook lets every task after the first (and the CPU retry below) load it.
      installModuleImportHook(self as unknown as Parameters<typeof installModuleImportHook>[0]);
      fileset = await FilesetResolver.forVisionTasks(msg.wasm, msg.useModule);
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
    }
    // The hand result is already on its way; the face box (at most a few times a second)
    // reuses the same frame before it is released.
    if (faceTask?.due(msg.ts)) {
      try {
        const r = faceTask.detect(msg.frame, msg.ts);
        post({ type: "face", ts: msg.ts, faces: r.faces, ms: r.ms });
      } catch (err) {
        faceTask.close();
        faceTask = null;
        post({ type: "face-status", state: "failed", message: (err as Error)?.message ?? String(err) });
      }
    }
    msg.frame.close();
  } else if (msg.type === "options") {
    await landmarker?.setOptions({
      minHandDetectionConfidence: msg.options.minDetection,
      minHandPresenceConfidence: msg.options.minPresence,
      minTrackingConfidence: msg.options.minTracking,
    });
  } else if (msg.type === "face-init") {
    if (!fileset || faceLoading) return;
    if (faceTask) {
      faceTask.setInterval(msg.intervalMs);
      post({ type: "face-status", state: "ready" });
      return;
    }
    faceLoading = true;
    const gen = faceGeneration;
    try {
      const task = await FaceTask.create(fileset, msg.model);
      if (gen !== faceGeneration) {
        task.close();
        post({ type: "face-status", state: "closed" });
        return;
      }
      task.setInterval(msg.intervalMs);
      faceTask = task;
      post({ type: "face-status", state: "ready" });
    } catch (err) {
      post({ type: "face-status", state: "failed", message: (err as Error)?.message ?? String(err) });
    } finally {
      faceLoading = false;
    }
  } else if (msg.type === "face-config") {
    faceTask?.setInterval(msg.intervalMs);
  } else if (msg.type === "face-close") {
    faceGeneration++;
    faceTask?.close();
    faceTask = null;
    post({ type: "face-status", state: "closed" });
  }
};
