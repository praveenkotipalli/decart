/**
 * The frame shown inside the hand frame must line up with the camera image around it,
 * so the picture sent to the AI has to cover a known region of the camera frame.
 * When the camera's aspect ratio matches the model's, the camera stream is sent as it
 * is. When it does not (a 4:3 webcam feeding a 16:9 model), we crop it ourselves —
 * otherwise the service decides how to fit it, and the result could not be aligned.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AiInput {
  stream: MediaStream;
  /** Region of the camera frame that is sent, as fractions of the frame (x, y, w, h). */
  rect: Rect;
  /** Frames are already flipped here, so the SDK must not mirror them again. */
  mirrored: boolean;
  /** How the stream is produced — for diagnostics. */
  impl: "direct" | "track-processor" | "canvas";
  dispose(): void;
}

export const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Largest centred region of a w×h frame with the given aspect ratio, in pixels.
 * Sizes are even because video encoders need even dimensions.
 */
export function coverCrop(w: number, h: number, aspect: number): Rect {
  let cw = w;
  let ch = h;
  if (w / h > aspect) cw = h * aspect;
  else ch = w / aspect;
  cw = Math.max(2, Math.floor(cw / 2) * 2);
  ch = Math.max(2, Math.floor(ch / 2) * 2);
  return { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
}

/** True when two aspect ratios are close enough that no crop is worth the per-frame cost. */
export function aspectsMatch(a: number, b: number, tolerance = 0.03): boolean {
  return Math.abs(a / b - 1) <= tolerance;
}

// Insertable Streams are not in TypeScript's DOM library yet.
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessor;
type GeneratorCtor = new (init: { kind: "video" }) => TrackGenerator;

function insertableStreams(): { Processor: ProcessorCtor; Generator: GeneratorCtor } | null {
  const g = globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };
  return typeof g.MediaStreamTrackProcessor === "function" && typeof g.MediaStreamTrackGenerator === "function"
    ? { Processor: g.MediaStreamTrackProcessor, Generator: g.MediaStreamTrackGenerator }
    : null;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawCropped(ctx: Ctx2D, source: CanvasImageSource, crop: Rect, mirror: boolean) {
  ctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? crop.w : 0, 0);
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
}

/**
 * @param camera the webcam stream
 * @param size the camera frame size in pixels
 * @param target the model's native frame (only the aspect ratio and fps are used)
 * @param mirror whether the picture sent to the AI should be flipped horizontally
 */
export function prepareAiInput(
  camera: MediaStream,
  size: { width: number; height: number },
  target: { width: number; height: number; fps: number },
  mirror: boolean,
): AiInput {
  const [track] = camera.getVideoTracks();
  const targetAspect = target.width / target.height;
  if (!track || !size.width || !size.height || aspectsMatch(size.width / size.height, targetAspect)) {
    return { stream: camera, rect: FULL_RECT, mirrored: false, impl: "direct", dispose: () => {} };
  }

  const crop = coverCrop(size.width, size.height, targetAspect);
  const rect: Rect = { x: crop.x / size.width, y: crop.y / size.height, w: crop.w / size.width, h: crop.h / size.height };
  const api = insertableStreams();

  if (api) {
    const processor = new api.Processor({ track });
    const generator = new api.Generator({ kind: "video" });
    const canvas = new OffscreenCanvas(crop.w, crop.h);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const pipeline = new TransformStream<VideoFrame, VideoFrame>({
        transform(frame, controller) {
          try {
            // The camera may renegotiate its size; scale the crop with it.
            const sx = frame.displayWidth / size.width;
            const sy = frame.displayHeight / size.height;
            const live = sx === 1 && sy === 1 ? crop : { x: crop.x * sx, y: crop.y * sy, w: crop.w * sx, h: crop.h * sy };
            ctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? crop.w : 0, 0);
            ctx.drawImage(frame, live.x, live.y, live.w, live.h, 0, 0, crop.w, crop.h);
            controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: "discard" }));
          } finally {
            frame.close();
          }
        },
      });
      processor.readable.pipeThrough(pipeline).pipeTo(generator.writable).catch(() => {});
      let disposed = false;
      return {
        stream: new MediaStream([generator]),
        rect,
        mirrored: mirror,
        impl: "track-processor",
        dispose: () => {
          if (disposed) return;
          disposed = true;
          generator.stop();
        },
      };
    }
  }

  // Fallback for browsers without Insertable Streams: pump frames through a canvas.
  const canvas = document.createElement("canvas");
  canvas.width = crop.w;
  canvas.height = crop.h;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof canvas.captureStream !== "function") {
    return { stream: camera, rect: FULL_RECT, mirrored: false, impl: "direct", dispose: () => {} };
  }
  const [out] = canvas.captureStream(target.fps).getVideoTracks();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  let disposed = false;
  let raf = 0;
  const draw = () => {
    if (disposed) return;
    if (video.videoWidth) drawCropped(ctx, video, crop, mirror);
    raf = requestAnimationFrame(draw);
  };
  void video.play().catch(() => undefined);
  raf = requestAnimationFrame(draw);
  return {
    stream: new MediaStream([out]),
    rect,
    mirrored: mirror,
    impl: "canvas",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      out.stop();
      video.srcObject = null;
    },
  };
}
