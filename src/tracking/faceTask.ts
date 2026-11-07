import { FaceDetector } from "@mediapipe/tasks-vision";
import type { RawFace } from "../toy/types";

/**
 * Worker side of the face box: the MediaPipe Face Detector as a second task inside the
 * tracker worker, plus the import hook that lets a module worker load MediaPipe's wasm glue
 * more than once. Browser only (OffscreenCanvas); never unit-tested, so it stays small.
 */

/** The fileset `FilesetResolver.forVisionTasks` resolves to; the typings do not export it by name. */
export type WasmFileset = Parameters<typeof FaceDetector.createFromOptions>[0];

export const FACE_TASK = {
  /** The detector input: a small 2D copy of the camera frame. Width is fixed ... */
  width: 256,
  /** ... and the height follows the frame's aspect (144 for 16:9), within these bounds. */
  height: 144,
  minHeight: 96,
  maxHeight: 256,
  minDetectionConfidence: 0.5,
  /** Until the main thread says otherwise, ms. */
  defaultIntervalMs: 400,
} as const;

export interface ModuleHookScope {
  import?: (url: string) => Promise<void>;
  ModuleFactory?: unknown;
}

/**
 * MediaPipe loads its wasm glue script with `importScripts(url)`. In a module worker that throws
 * a TypeError, after which the runner calls `self.import ? self.import(url) : import(url)` and
 * then expects the global `ModuleFactory` to be set (and clears it again once the task exists).
 * The glue is an ES module that sets the global at its top level — which runs only on the first
 * `import()`; later ones return the cached module and leave the global unset, so every task after
 * the first (and the GPU → CPU retry of the first) would fail with "ModuleFactory not set.".
 * This hook re-publishes the module's default export, the factory, on every load.
 */
export function installModuleImportHook(scope: ModuleHookScope): void {
  if (typeof scope.import === "function") return;
  scope.import = async (url: string) => {
    const m = (await import(/* @vite-ignore */ url)) as { default?: unknown };
    if (m.default !== undefined) scope.ModuleFactory = m.default;
  };
}

/** Pixel size of a frame as the hand path hands it over. */
function frameSize(frame: VideoFrame | ImageBitmap): [number, number] {
  if ("displayWidth" in frame) return [frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight];
  return [frame.width, frame.height];
}

/**
 * BlazeFace short range on the CPU in VIDEO mode. `detect` is run on the same frame the hand
 * landmarker just saw, after its result has been posted and before the frame is closed; it is
 * due at most once per interval. Boxes come back normalised to the frame, unmirrored.
 */
export class FaceTask {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private intervalMs: number = FACE_TASK.defaultIntervalMs;
  /** Timestamp of the last detection, ms; -Infinity = none yet. */
  private lastTs = -Infinity;
  private closed = false;

  private constructor(private readonly detector: FaceDetector) {
    this.canvas = new OffscreenCanvas(FACE_TASK.width, FACE_TASK.height);
    // The detector reads the pixels straight back; nothing but this frame is ever drawn here.
    const ctx = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error("face: no 2D context for the detector input");
    this.ctx = ctx;
  }

  static async create(fileset: WasmFileset, modelUrl: string): Promise<FaceTask> {
    // CPU delegate: the task is tiny, and a GPU task would read the whole input back anyway.
    const detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: FACE_TASK.minDetectionConfidence,
    });
    return new FaceTask(detector);
  }

  /** How often the detector should run, ms. */
  setInterval(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.intervalMs = ms;
  }

  /** Should the frame stamped `ts` (ms) be detected on? */
  due(ts: number): boolean {
    return !this.closed && ts - this.lastTs >= this.intervalMs;
  }

  /**
   * Detects on `frame`, which is never closed here (the caller owns it).
   * @param ts the frame's timestamp, ms, as given to the hand landmarker
   */
  detect(frame: VideoFrame | ImageBitmap, ts: number): { faces: RawFace[]; ms: number } {
    if (this.closed) throw new Error("face: task closed");
    const t0 = performance.now();
    const [fw, fh] = frameSize(frame);
    this.fit(fw, fh);
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.drawImage(frame, 0, 0, w, h);
    // VIDEO mode needs strictly increasing timestamps; the hand path guarantees that already.
    const stamp = Math.max(ts, this.lastTs + 1);
    this.lastTs = stamp;
    const result = this.detector.detectForVideo(this.canvas, stamp);
    const faces: RawFace[] = [];
    for (const d of result.detections) {
      const b = d.boundingBox;
      if (!b) continue;
      faces.push({ x: b.originX / w, y: b.originY / h, w: b.width / w, h: b.height / h, score: d.categories[0]?.score ?? 0 });
    }
    return { faces, ms: performance.now() - t0 };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detector.close();
  }

  /** Keeps the input copy at the frame's aspect, so faces are not squeezed on a 4:3 camera. */
  private fit(fw: number, fh: number): void {
    if (!(fw > 0 && fh > 0)) return;
    const h = Math.min(Math.max(Math.round((FACE_TASK.width * fh) / fw), FACE_TASK.minHeight), FACE_TASK.maxHeight);
    if (h !== this.canvas.height) this.canvas.height = h;
  }
}
