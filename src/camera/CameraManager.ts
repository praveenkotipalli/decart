export type CameraErrorKind = "denied" | "notfound" | "inuse" | "insecure" | "unsupported" | "error";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface CameraOptions {
  width: number;
  height: number;
  fps: number;
  deviceId?: string;
}

function toCameraError(err: unknown): CameraError {
  const name = (err as DOMException)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new CameraError("denied", "Camera access was blocked.");
    case "NotFoundError":
    case "OverconstrainedError":
      return new CameraError("notfound", "No usable camera was found.");
    case "NotReadableError":
    case "AbortError":
      return new CameraError("inuse", "The camera is busy — another app or tab may be using it.");
    default:
      return new CameraError("error", (err as Error)?.message || "The camera could not be started.");
  }
}

/** Owns the webcam stream and the <video> element everything else reads from. */
export class CameraManager {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  get label(): string {
    return this.track?.label ?? "";
  }

  async start(opts: CameraOptions): Promise<MediaStream> {
    if (!window.isSecureContext) {
      throw new CameraError("insecure", "The camera needs a secure origin — open the app on localhost or https.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError("unsupported", "This browser cannot access cameras.");
    }
    this.stop();
    try {
      // `ideal` so odd webcams still open; the model's native size avoids rescaling when it can.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: opts.width },
          height: { ideal: opts.height },
          frameRate: { ideal: opts.fps, max: 60 },
          ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : { facingMode: "user" }),
        },
      });
    } catch (err) {
      throw toCameraError(err);
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    if (!this.video.videoWidth) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.video.addEventListener("loadedmetadata", done, { once: true });
        setTimeout(done, 3000);
      });
    }
    return this.stream;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async devices(): Promise<MediaDeviceInfo[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    } catch {
      return [];
    }
  }
}
