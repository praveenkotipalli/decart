import {
  createDecartClient,
  models,
  type ConnectionState,
  type DecartSDKError,
  type RealTimeClient,
  type WebRTCStats,
} from "@decartai/sdk";

/**
 * - off: not requested
 * - unconfigured: the server has no DECART_API_KEY
 * - connecting / waiting (capacity or queue) / connected (no frame yet) / live (generating)
 * - reconnecting: the SDK is retrying after a drop
 * - paused: disconnected on purpose to stop billing (idle)
 * - error: gave up; `detail` says why
 */
export type AIState =
  | "off"
  | "unconfigured"
  | "connecting"
  | "waiting"
  | "connected"
  | "live"
  | "reconnecting"
  | "paused"
  | "error";

export interface AIMetrics {
  /** Billed generation seconds this session (from generationTick). */
  seconds: number;
  /** Median camera-to-display latency, ms (Decart glass-to-glass), when measured. */
  g2gMs: number | null;
  /** Time to first transformed frame, ms. */
  ttffMs: number | null;
  /** Network round trip, ms — a fallback latency indicator before g2g is available. */
  rttMs: number | null;
  /** Decoded output frames per second. */
  fps: number;
  quality: string | null;
}

export interface SessionOptions {
  model: string;
  prompt: string;
  enhance: boolean;
  image: Blob | null;
  fast: boolean;
  mirror: boolean;
}

class TokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** Errors that will not fix themselves by retrying. */
const TERMINAL = new Set(["INVALID_API_KEY", "MODEL_NOT_FOUND", "DECART_NOT_CONFIGURED", "MODEL_NOT_ALLOWED", "ORIGIN_NOT_ALLOWED", "INVALID_INPUT", "INVALID_OPTIONS"]);
const TERMINAL_END_REASONS = new Set(["moderation_violation", "insufficient_credits", "policy_violation"]);
const RETRY_DELAYS_MS = [1500, 4000, 9000, 15000];

/**
 * The SDK re-wraps some server errors as a generic "Signaling error"; the server's
 * own message (e.g. a copyright refusal) survives in `cause`.
 */
function serverMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } };
  return e?.cause?.message || e?.message || String(err);
}

/** Server refusals of the content itself: retrying the same prompt cannot succeed. */
function contentRefusal(message: string): string | null {
  if (/copyright/i.test(message)) return "COPYRIGHT";
  if (/moderation|not allowed|prohibited|violat/i.test(message)) return "moderation_violation";
  return null;
}

function describe(code: string, fallback: string): string {
  switch (code) {
    case "INVALID_API_KEY":
      return "Decart rejected the API key. Check DECART_API_KEY on the server.";
    case "DECART_NOT_CONFIGURED":
      return "No Decart API key on the server. Add DECART_API_KEY to .env and restart.";
    case "MODEL_NOT_FOUND":
    case "MODEL_NOT_ALLOWED":
      return "That model is not available to this account or server.";
    case "INVALID_INPUT":
      return `Decart refused the input: ${fallback}`;
    case "TOKEN_EXPIRED":
      return "The session token expired. Reconnecting…";
    case "RATE_LIMITED":
      return "Too many connection attempts. Waiting…";
    case "moderation_violation":
      return "Decart ended the session: the content was flagged by moderation.";
    case "insufficient_credits":
      return "Decart ended the session: the account is out of credits.";
    case "policy_violation":
      return "Decart refused the session (policy). Check the prompt and the token's origin.";
    case "session_limit":
      return "Concurrent session limit reached — close other Decart sessions.";
    case "COPYRIGHT":
      return "Decart blocked the prompt as copyrighted IP. Describe the look instead of naming a character — try the “Blindfolded sorcerer” preset.";
    default:
      return code.startsWith("WEBRTC") ? "Network problem reaching Decart." : fallback;
  }
}

export class DecartSession {
  state: AIState = "off";
  detail = "";
  model = "";
  metrics: AIMetrics = { seconds: 0, g2gMs: null, ttffMs: null, rttMs: null, fps: 0, quality: null };
  /** Receives the transformed stream; the renderer samples it as a texture. */
  readonly video: HTMLVideoElement;
  onChange: () => void = () => {};
  onStream: (video: HTMLVideoElement | null) => void = () => {};

  private client = createDecartClient({
    // A fresh short-lived client token for every connect and reconnect; the permanent
    // key never leaves the server.
    apiKeyProvider: () => this.fetchToken(),
    telemetry: false,
  });
  private rt: RealTimeClient | null = null;
  private opts: SessionOptions | null = null;
  private stream: MediaStream | null = null;
  private want = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    // Kept in the DOM (invisible) so every browser keeps decoding it.
    Object.assign(this.video.style, {
      position: "fixed",
      width: "2px",
      height: "2px",
      opacity: "0",
      pointerEvents: "none",
      left: "0",
      top: "0",
    });
    document.body.appendChild(this.video);
  }

  get active() {
    return this.want;
  }

  private set(state: AIState, detail = "") {
    this.state = state;
    this.detail = detail;
    this.onChange();
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await fetch("/api/realtime-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.opts?.model }),
      });
    } catch {
      throw new TokenError("SERVER_UNREACHABLE", "The local server is not running (npm run dev starts it).");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.apiKey) {
      throw new TokenError(
        body.error ?? `HTTP_${res.status}`,
        body.message ?? `Token request failed (${res.status})`,
        Number(res.headers.get("Retry-After")) || undefined,
      );
    }
    return body.apiKey as string;
  }

  async start(stream: MediaStream, opts: SessionOptions) {
    this.stopInternal();
    this.want = true;
    this.stream = stream;
    this.opts = opts;
    this.attempt = 0;
    this.metrics = { seconds: 0, g2gMs: null, ttffMs: null, rttMs: null, fps: 0, quality: null };
    await this.connect();
  }

  private async connect() {
    if (!this.want || !this.stream || !this.opts) return;
    const gen = ++this.generation;
    const o = this.opts;
    this.model = o.model;
    this.set("connecting", "Opening a realtime session…");

    let model;
    try {
      model = models.realtime(o.model as Parameters<typeof models.realtime>[0]);
    } catch {
      this.fail("MODEL_NOT_FOUND", `Unknown model ${o.model}`);
      return;
    }

    try {
      const rt = await this.client.realtime.connect(this.stream, {
        model,
        mirror: o.mirror,
        ...(o.fast ? { speed: "fast" as const } : {}),
        onRemoteStream: (s) => {
          this.video.srcObject = s;
          void this.video.play().catch(() => undefined);
          this.onStream(this.video);
        },
        onCapacityWait: ({ retryAfterMs, attempt }) =>
          this.set("waiting", `Decart is at capacity — retry ${attempt} in ${Math.ceil(retryAfterMs / 1000)} s`),
        onQueuePosition: ({ position, queueSize }) => this.set("waiting", `Queued: ${position} of ${queueSize}`),
        initialState: {
          prompt: { text: o.prompt, enhance: o.enhance },
          ...(o.image ? { image: o.image } : {}),
        },
      });
      if (gen !== this.generation || !this.want) {
        rt.disconnect();
        return;
      }
      this.rt = rt;
      this.attempt = 0;
      rt.on("connectionChange", (s) => this.onConnection(s, gen));
      rt.on("error", (e) => this.onError(e, gen));
      rt.on("sessionEnded", ({ reason }) => {
        if (gen !== this.generation) return;
        if (TERMINAL_END_REASONS.has(reason) || reason === "session_limit") this.fail(reason, describe(reason, reason));
        else this.scheduleRetry(describe(reason, `Session ended (${reason})`));
      });
      rt.on("generationTick", ({ seconds }) => {
        this.metrics.seconds = seconds;
      });
      rt.on("stats", (s: WebRTCStats) => {
        this.metrics.fps = s.video?.framesPerSecond ?? 0;
        if (s.glassToGlass?.medianMs != null) this.metrics.g2gMs = s.glassToGlass.medianMs;
        if (s.glassToGlass?.ttffMs != null) this.metrics.ttffMs = s.glassToGlass.ttffMs;
      });
      rt.on("connectionQuality", (r) => {
        this.metrics.quality = r.quality;
        this.metrics.rttMs = r.metrics.rttMs ?? this.metrics.rttMs;
      });
      this.onConnection(rt.getConnectionState(), gen);
    } catch (err) {
      if (gen !== this.generation) return;
      const code = (err as TokenError | DecartSDKError)?.code ?? "CONNECT_FAILED";
      const message = serverMessage(err);
      const refusal = contentRefusal(message);
      if (refusal) this.fail(refusal, describe(refusal, message));
      else if (code === "DECART_NOT_CONFIGURED") {
        this.want = false;
        this.set("unconfigured", describe(code, message));
      } else if (TERMINAL.has(code)) this.fail(code, describe(code, message));
      else this.scheduleRetry(describe(code, message), (err as TokenError).retryAfterSec);
    }
  }

  private onConnection(s: ConnectionState, gen: number) {
    if (gen !== this.generation) return;
    switch (s) {
      case "connecting":
        this.set("connecting", "Opening a realtime session…");
        break;
      case "connected":
        this.set("connected", "Connected — waiting for the first transformed frame");
        break;
      case "generating":
        this.set("live", "");
        break;
      case "reconnecting":
        this.set("reconnecting", "Connection dropped — reconnecting");
        break;
      case "disconnected":
        if (this.want && this.state !== "error" && this.state !== "unconfigured") {
          this.scheduleRetry("Disconnected — retrying");
        }
        break;
    }
  }

  private onError(e: DecartSDKError, gen: number) {
    if (gen !== this.generation) return;
    const message = serverMessage(e);
    console.warn("[decart]", e.code, message);
    const refusal = contentRefusal(message);
    if (refusal) this.fail(refusal, describe(refusal, message));
    else if (TERMINAL.has(e.code)) this.fail(e.code, describe(e.code, message));
    else {
      this.detail = e.code === "WEBRTC_SERVER_ERROR" ? `Decart: ${message}` : describe(e.code, message);
      this.onChange();
    }
  }

  private scheduleRetry(reason: string, afterSec?: number) {
    this.teardown();
    if (!this.want) return;
    if (this.attempt >= RETRY_DELAYS_MS.length) {
      this.fail("GAVE_UP", `${reason} Gave up after ${this.attempt} retries.`);
      return;
    }
    const delay = afterSec ? afterSec * 1000 : RETRY_DELAYS_MS[this.attempt];
    this.attempt++;
    this.set("reconnecting", `${reason} — retry ${this.attempt} in ${Math.ceil(delay / 1000)} s`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private fail(code: string, message: string) {
    this.want = false;
    this.teardown();
    this.set("error", message || code);
  }

  /** Update prompt / reference image without reconnecting. `set()` replaces the whole state. */
  async update(prompt: string, enhance: boolean, image: Blob | null) {
    if (this.opts) this.opts = { ...this.opts, prompt, enhance, image };
    if (!this.rt) return;
    try {
      await this.rt.set({ prompt, enhance, ...(image ? { image } : {}) });
      if (this.state === "live") this.detail = "";
    } catch (err) {
      const e = err as DecartSDKError;
      const message = serverMessage(err);
      const refusal = contentRefusal(message);
      // A refused prompt update leaves the running session (and its last prompt) intact.
      this.detail = refusal ? describe(refusal, message) : describe(e.code ?? "INVALID_INPUT", message);
    }
    this.onChange();
  }

  /** Disconnect and stop billing. `paused` keeps the intent so the engine can resume. */
  stop(as: "off" | "paused" = "off") {
    this.stopInternal();
    this.set(as, as === "paused" ? "Paused to save credits — show the portal to resume" : "");
  }

  private stopInternal() {
    this.want = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.teardown();
  }

  private teardown() {
    if (this.rt) {
      try {
        this.rt.disconnect();
      } catch {
        /* already closed */
      }
      this.rt = null;
    }
    this.video.srcObject = null;
    this.onStream(null);
  }

  dispose() {
    this.stopInternal();
    this.video.remove();
  }
}
