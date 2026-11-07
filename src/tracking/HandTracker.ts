import type { HandLandmarker } from "@mediapipe/tasks-vision";
import type { RawFace } from "../toy/types";
import type { HandFrame } from "./landmarks";
import {
  CDN_FACE_MODEL,
  CDN_MODEL,
  CDN_WASM,
  LOCAL_FACE_MODEL,
  LOCAL_MODEL,
  LOCAL_WASM,
  served,
  toHandFrame,
  type DelegatePreference,
  type TrackerOptions,
  type WorkerRequest,
  type WorkerResponse,
} from "./trackerProtocol";

export type { TrackerOptions };

/** Frames are downscaled before inference; the models work at 192–224 px internally. */
const INFER_WIDTH = 640;

/**
 * MediaPipe Hand Landmarker in VIDEO mode. Runs in a Web Worker so inference
 * never blocks rendering; falls back to the main thread if workers can't host it.
 * Only one frame is ever in flight — new camera frames are skipped while busy,
 * so results are always about the latest frame and nothing queues up.
 */
export class HandTracker {
  delegate: "GPU" | "CPU" = "GPU";
  source: "local" | "cdn" = "local";
  thread: "worker" | "main" = "worker";
  onResult: (frame: HandFrame) => void = () => {};
  onError: (message: string) => void = () => {};
  /** Faces of one camera frame, normalised to the unmirrored frame, with that frame's mirror flag. */
  onFaces: (faces: RawFace[], mirror: boolean, time: number) => void = () => {};
  /** The face detector started (true) or stopped / failed (false). */
  onFaceStatus: (running: boolean) => void = () => {};
  /** What was last asked for; the detector itself reports through onFaceStatus. */
  faceEnabled = false;

  private worker: Worker | null = null;
  private landmarker: HandLandmarker | null = null;
  private busy = false;
  private lastTs = 0;
  private pending: { time: number; aspect: number; mirror: boolean } | null = null;
  private lastSubmit: { video: HTMLVideoElement; mirror: boolean } | null = null;
  private skipped: number | null = null;
  private isReady = false;
  private faceFailed = false;
  private faceIntervalMs = 400;
  private faceModel: Promise<string> | null = null;

  get ready() {
    return this.isReady;
  }

  /**
   * @param prefer diagnostics overrides (`?tracker=main|worker`, `?delegate=gpu|cpu`); defaults
   *   to a worker with the GPU delegate, falling back to the main thread / CPU.
   */
  async init(opts: TrackerOptions, prefer: { thread?: "worker" | "main"; delegate?: DelegatePreference } = {}): Promise<void> {
    const local = (await served(LOCAL_MODEL)) && (await served(`${LOCAL_WASM}/vision_wasm_module_internal.wasm`));
    this.source = local ? "local" : "cdn";
    const wasm = local ? LOCAL_WASM : CDN_WASM;
    const model = new URL(local ? LOCAL_MODEL : CDN_MODEL, location.href).href;
    const wasmAbs = new URL(wasm, location.href).href;
    const delegate = prefer.delegate ?? "auto";
    try {
      if (prefer.thread === "main") throw new Error("main thread requested");
      await this.initWorker(wasmAbs, model, opts, delegate);
      this.thread = "worker";
    } catch (err) {
      if (prefer.thread !== "main") console.warn("[tracker] worker unavailable, tracking on the main thread", err);
      this.worker?.terminate();
      this.worker = null;
      await this.initMain(wasmAbs, model, opts, delegate);
      this.thread = "main";
    }
    this.isReady = true;
  }

  private initWorker(wasm: string, model: string, options: TrackerOptions, delegate: DelegatePreference): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./tracker.worker.ts", import.meta.url), { type: "module" });
      this.worker = w;
      const timer = setTimeout(() => reject(new Error("worker init timed out")), 45_000);
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || "worker failed to load"));
      };
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.type === "ready") {
          clearTimeout(timer);
          this.delegate = m.delegate;
          w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data);
          resolve();
        } else if (m.type === "error") {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      w.postMessage({ type: "init", wasm, model, useModule: true, options, delegate } satisfies WorkerRequest);
    });
  }

  /** The face box needs the worker (it is not offered on the main-thread fallback) and must not have failed before. */
  get faceSupported(): boolean {
    return this.isReady && this.worker !== null && !this.faceFailed;
  }

  /** Start or stop the optional face detector. Starting loads a second small model in the worker. */
  enableFace(on: boolean, intervalMs = this.faceIntervalMs) {
    const worker = this.worker;
    if (!worker || (on && !this.faceSupported)) {
      this.faceEnabled = false;
      return;
    }
    if (on === this.faceEnabled) return;
    this.faceEnabled = on;
    this.faceIntervalMs = intervalMs;
    if (!on) {
      worker.postMessage({ type: "face-close" } satisfies WorkerRequest);
      return;
    }
    this.faceModel ??= served(LOCAL_FACE_MODEL).then((local) => new URL(local ? LOCAL_FACE_MODEL : CDN_FACE_MODEL, location.href).href);
    void this.faceModel.then((model) => {
      if (this.faceEnabled && this.worker === worker) {
        worker.postMessage({ type: "face-init", model, intervalMs: this.faceIntervalMs } satisfies WorkerRequest);
      }
    });
  }

  setFaceInterval(intervalMs: number) {
    if (!this.faceEnabled || !this.worker || Math.abs(intervalMs - this.faceIntervalMs) < 50) return;
    this.faceIntervalMs = intervalMs;
    this.worker.postMessage({ type: "face-config", intervalMs } satisfies WorkerRequest);
  }

  private onWorkerMessage(m: WorkerResponse) {
    if (m.type === "face") {
      if (this.faceEnabled) this.onFaces(m.faces, this.lastSubmit?.mirror ?? true, performance.now());
      return;
    }
    if (m.type === "face-status") {
      if (m.state === "failed") {
        this.faceFailed = true;
        this.faceEnabled = false;
        console.warn("[tracker] face detection unavailable:", m.message);
      }
      this.onFaceStatus(m.state === "ready" && this.faceEnabled);
      return;
    }
    if (m.type === "result") {
      const p = this.pending;
      this.busy = false;
      this.pending = null;
      if (p) this.onResult(toHandFrame(m.hands, p.time, p.aspect, p.mirror, m.inferenceMs));
      // A camera frame arrived while we were busy: send it now rather than waiting for the next one.
      if (this.skipped) {
        this.skipped = null;
        const { video, mirror } = this.lastSubmit!;
        this.submit(video, performance.now(), mirror);
      }
    } else if (m.type === "error") {
      this.busy = false;
      this.onError(m.message);
    }
  }

  private async initMain(wasm: string, model: string, opts: TrackerOptions, delegate: DelegatePreference) {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(wasm);
    const base = {
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: opts.minDetection,
      minHandPresenceConfidence: opts.minPresence,
      minTrackingConfidence: opts.minTracking,
    };
    try {
      if (delegate === "CPU") throw new Error("CPU requested");
      this.landmarker = await HandLandmarker.createFromOptions(fileset, { ...base, baseOptions: { modelAssetPath: model, delegate: "GPU" } });
      this.delegate = "GPU";
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, { ...base, baseOptions: { modelAssetPath: model, delegate: "CPU" } });
      this.delegate = "CPU";
    }
  }

  /**
   * Offer the current camera frame. Returns false (and drops the frame) while a
   * previous one is still being processed.
   */
  submit(video: HTMLVideoElement, now: number, mirror: boolean): boolean {
    this.lastSubmit = { video, mirror };
    if (this.isReady && this.busy) this.skipped = now;
    if (!this.isReady || this.busy || video.readyState < 2 || !video.videoWidth) return false;
    const ts = Math.max(Math.round(now), this.lastTs + 1); // MediaPipe needs strictly increasing timestamps
    this.lastTs = ts;
    const aspect = video.videoWidth / video.videoHeight;

    if (this.worker) {
      this.busy = true;
      this.pending = { time: now, aspect, mirror };
      const worker = this.worker;
      // VideoFrame is a GPU-backed handle (no copy); ImageBitmap is the fallback. A CPU-delegate
      // task reads its whole input back from the GPU, so it gets the small bitmap instead.
      if (typeof VideoFrame !== "undefined" && this.delegate !== "CPU") {
        try {
          const frame = new VideoFrame(video, { timestamp: ts * 1000 });
          worker.postMessage({ type: "detect", frame, ts } satisfies WorkerRequest, [frame]);
          return true;
        } catch {
          /* fall through to ImageBitmap */
        }
      }
      const h = Math.round(INFER_WIDTH / aspect);
      createImageBitmap(video, { resizeWidth: INFER_WIDTH, resizeHeight: h, resizeQuality: "low" })
        .then((frame) => worker.postMessage({ type: "detect", frame, ts } satisfies WorkerRequest, [frame]))
        .catch(() => {
          this.busy = false;
          this.pending = null;
        });
      return true;
    }

    if (!this.landmarker) return false;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(video, ts);
    const raw = {
      landmarks: res.landmarks,
      world: res.worldLandmarks,
      handedness: res.handedness.map((c) => ({ label: c[0]?.categoryName ?? "", score: c[0]?.score ?? 0 })),
    };
    this.onResult(toHandFrame(raw, now, aspect, mirror, performance.now() - t0));
    return true;
  }

  async setOptions(opts: TrackerOptions) {
    if (this.worker) this.worker.postMessage({ type: "options", options: opts } satisfies WorkerRequest);
    else
      await this.landmarker?.setOptions({
        minHandDetectionConfidence: opts.minDetection,
        minHandPresenceConfidence: opts.minPresence,
        minTrackingConfidence: opts.minTracking,
      });
  }

  close() {
    this.worker?.terminate();
    this.worker = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.isReady = false;
    this.busy = false;
    this.faceEnabled = false;
    this.faceFailed = false;
  }
}
