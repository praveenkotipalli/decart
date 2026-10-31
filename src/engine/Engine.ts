import { models, resolveFpsNumber } from "@decartai/sdk";
import { DecartSession, type AIState } from "../ai/DecartSession";
import { CameraError, CameraManager, type CameraErrorKind } from "../camera/CameraManager";
import { downloadBlob, Recorder, timestamp } from "../capture/Recorder";
import { settingsStore, updateSettings, type Settings } from "../config/settings";
import { createStore } from "../core/store";
import type { QuadValidity } from "../geometry/quad";
import { classifyHand, type HandShape } from "../gestures/classifier";
import { GestureMachine, type GestureEvent, type GestureHand, type GestureProgress } from "../gestures/GestureMachine";
import { Calibrator, type CalibrationResult, type CalibrationState } from "../portal/Calibrator";
import { effectiveMapping, resolveCorners, swapVertical } from "../portal/cornerMapping";
import { DEFAULT_HOME, PortalController, type PortalPhase } from "../portal/PortalController";
import { Overlay } from "../render/Overlay";
import { Renderer, type ContentSource } from "../render/Renderer";
import { HandAssigner, type TrackedHand } from "../tracking/handAssignment";
import { HandTracker } from "../tracking/HandTracker";
import type { HandFrame } from "../tracking/landmarks";
import { SimulatedHands, simBeat } from "../tracking/SimulatedHands";
import { RateMeter } from "./RateMeter";

export type CameraStatus = "off" | "starting" | "on" | CameraErrorKind;

export interface EngineStatus {
  camera: CameraStatus;
  cameraDetail: string;
  cameraLabel: string;
  tracker: "idle" | "loading" | "ready" | "error";
  trackerDetail: string;
  simulated: boolean;
  simCaption: string;
  paused: boolean;
  renderFps: number;
  trackFps: number;
  inferenceMs: number;
  hands: number;
  phase: PortalPhase;
  locked: boolean;
  validity: QuadValidity;
  portalVisible: boolean;
  hint: string;
  content: ContentSource;
  ai: {
    state: AIState;
    detail: string;
    configured: boolean | null;
    allowedModels: string[];
    allowFast: boolean;
    seconds: number;
    latencyMs: number | null;
    latencyKind: "g2g" | "rtt" | null;
    ttffMs: number | null;
    fps: number;
    quality: string | null;
  };
  calibration: { state: CalibrationState; progress: number; message: string };
  recording: boolean;
  toast: { id: number; text: string } | null;
  webglError: string;
}

const INITIAL: EngineStatus = {
  camera: "off",
  cameraDetail: "",
  cameraLabel: "",
  tracker: "idle",
  trackerDetail: "",
  simulated: false,
  simCaption: "",
  paused: false,
  renderFps: 0,
  trackFps: 0,
  inferenceMs: 0,
  hands: 0,
  phase: "searching",
  locked: false,
  validity: "valid",
  portalVisible: false,
  hint: "",
  content: "local",
  ai: {
    state: "off",
    detail: "",
    configured: null,
    allowedModels: [],
    allowFast: false,
    seconds: 0,
    latencyMs: null,
    latencyKind: null,
    ttffMs: null,
    fps: 0,
    quality: null,
  },
  calibration: { state: "idle", progress: 0, message: "" },
  recording: false,
  toast: null,
  webglError: "",
};

const SHORT_GESTURE: Record<string, string> = {
  "pinch-middle": "pinch thumb + middle",
  "pinch-index": "pinch thumb + index",
  fist: "make a fist",
  "open-palm": "open palm",
  "open-palm-solo": "show one open palm",
  none: "",
};

export class Engine {
  readonly status = createStore<EngineStatus>(INITIAL);
  readonly camera = new CameraManager();
  private tracker = new HandTracker();
  private trackerInit: Promise<void> | null = null;
  private sim = new SimulatedHands();
  private assigner = new HandAssigner();
  private gestures = new GestureMachine();
  private portal = new PortalController();
  private calibrator = new Calibrator();
  private session = new DecartSession();
  private recorder = new Recorder();
  private renderer: Renderer | null = null;
  private overlay: Overlay | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private settings: Settings = settingsStore.get();
  private unsubscribe: (() => void) | null = null;

  private hands: TrackedHand[] = [];
  private shapes = new Map<number, HandShape>();
  private gestureProgress: GestureProgress[] = [];
  private paused = false;
  private simulated = false;
  private raf = 0;
  private rvfcHandle = 0;
  private lastSimAt = 0;
  private lastPublish = 0;
  private lastPortalVisibleAt = performance.now();
  private renderMeter = new RateMeter();
  private trackMeter = new RateMeter();
  private inferenceMs = 0;
  private referenceImage: Blob | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private toastId = 0;

  constructor() {
    let lastAIState = this.session.state;
    this.session.onChange = () => {
      if (this.session.state === "error" && lastAIState !== "error") this.toast(`AI stopped — ${this.session.detail}`);
      lastAIState = this.session.state;
      this.publish();
    };
    this.session.onStream = (video) => this.renderer?.setAI(video);
    this.tracker.onResult = (frame) => {
      if (!this.simulated && this.camera.stream) this.trackFrame(frame.time, frame);
    };
    this.tracker.onError = (message) => console.warn("[tracker]", message);
    this.applySettings(this.settings, null);
    this.unsubscribe = settingsStore.subscribe(() => {
      const next = settingsStore.get();
      const prev = this.settings;
      this.settings = next;
      this.applySettings(next, prev);
    });
    void this.checkServer();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach(glCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement, container: HTMLElement) {
    try {
      this.renderer = new Renderer(glCanvas);
    } catch (err) {
      this.patch({ webglError: (err as Error).message });
      return;
    }
    this.overlay = new Overlay(overlayCanvas);
    this.renderer.setCamera(this.camera.stream ? this.camera.video : null);
    const resize = () => {
      const r = container.getBoundingClientRect();
      this.renderer!.resize(r.width, r.height, window.devicePixelRatio || 1);
      this.overlay!.resize(glCanvas.width, glCanvas.height);
    };
    resize();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(container);
    this.raf = requestAnimationFrame(this.tick);
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.renderer?.dispose();
    this.renderer = null;
    this.overlay = null;
  }

  dispose() {
    this.detach();
    this.stopCamera();
    this.session.dispose();
    this.tracker.close();
    this.unsubscribe?.();
  }

  private async checkServer() {
    try {
      const r = await fetch("/api/health");
      const h = await r.json();
      const allowed: string[] = h.decart?.allowedModels ?? [];
      this.patchAI({ configured: Boolean(h.decart?.configured), allowedModels: allowed, allowFast: Boolean(h.decart?.allowFast) });
      if (allowed.length && !allowed.includes(this.settings.model)) updateSettings({ model: h.decart.defaultModel });
    } catch {
      this.patchAI({ configured: null, detail: "Local server offline — run `npm run dev`." });
    }
  }

  // ── Camera & tracking ─────────────────────────────────────────────────────

  private ensureTracker(): Promise<void> {
    if (this.tracker.ready) return Promise.resolve();
    if (!this.trackerInit) {
      this.patch({ tracker: "loading", trackerDetail: "Loading hand tracking model…" });
      const conf = this.settings.detectionConfidence;
      const q = new URLSearchParams(location.search);
      const thread = q.get("tracker");
      const delegate = q.get("delegate")?.toUpperCase();
      this.trackerInit = this.tracker
        .init(
          { minDetection: conf, minPresence: conf, minTracking: conf },
          {
            thread: thread === "main" || thread === "worker" ? thread : undefined,
            delegate: delegate === "GPU" || delegate === "CPU" ? delegate : undefined,
          },
        )
        .then(() =>
          this.patch({
            tracker: "ready",
            trackerDetail: `MediaPipe · ${this.tracker.delegate} · ${this.tracker.thread} thread · ${this.tracker.source} model`,
          }),
        )
        .catch((err) => {
          this.trackerInit = null;
          this.patch({ tracker: "error", trackerDetail: `Hand tracking failed to load: ${(err as Error).message}` });
          throw err;
        });
    }
    return this.trackerInit;
  }

  async startCamera() {
    this.patch({ camera: "starting", cameraDetail: "" });
    const trackerReady = this.ensureTracker().catch(() => undefined);
    let w = 1280;
    let h = 720;
    let fps = 30;
    try {
      const m = models.realtime(this.settings.model as Parameters<typeof models.realtime>[0]);
      w = m.width;
      h = m.height;
      fps = resolveFpsNumber(m.fps);
    } catch {
      /* unknown model: keep 720p30 */
    }
    try {
      await this.camera.start({ width: w, height: h, fps });
    } catch (err) {
      const e = err instanceof CameraError ? err : new CameraError("error", String(err));
      this.patch({ camera: e.kind, cameraDetail: e.message });
      return;
    }
    this.renderer?.setCamera(this.camera.video);
    this.patch({ camera: "on", cameraLabel: this.camera.label });
    this.camera.track?.addEventListener("ended", () => {
      this.patch({ camera: "error", cameraDetail: "The camera was disconnected." });
      this.stopCamera(false);
    });
    await trackerReady;
    this.scheduleTracking();
    this.syncAI();
  }

  stopCamera(updateStatus = true) {
    if (this.rvfcHandle && "cancelVideoFrameCallback" in this.camera.video) {
      this.camera.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = 0;
    this.camera.stop();
    this.renderer?.setCamera(null);
    if (this.session.active || this.session.state === "paused") this.session.stop("off");
    if (!this.simulated) this.resetTracking();
    if (updateStatus) this.patch({ camera: "off", cameraLabel: "" });
  }

  setSimulated(on: boolean) {
    this.simulated = on;
    this.resetTracking();
    this.patch({ simulated: on });
    if (!on && this.camera.stream) this.scheduleTracking();
  }

  private resetTracking() {
    this.assigner.reset();
    this.gestures.reset();
    this.shapes.clear();
    this.hands = [];
    this.portal = new PortalController(this.portalOptions(this.settings));
    this.portal.home = this.settings.calibration?.home ?? DEFAULT_HOME;
  }

  /** Run hand tracking once per new camera frame. */
  private scheduleTracking() {
    const video = this.camera.video;
    if (this.rvfcHandle || !this.camera.stream) return;
    if ("requestVideoFrameCallback" in video) {
      const onFrame = () => {
        if (!this.camera.stream) {
          this.rvfcHandle = 0;
          return;
        }
        // Results come back through tracker.onResult (asynchronously when in the worker).
        if (!this.simulated && !this.paused) this.tracker.submit(video, performance.now(), this.settings.mirror);
        this.rvfcHandle = video.requestVideoFrameCallback(onFrame);
      };
      this.rvfcHandle = video.requestVideoFrameCallback(onFrame);
    }
  }

  private trackFrame(now: number, frame: HandFrame) {
    if (this.paused) return;
    const s = this.settings;
    const hands = this.assigner.update(frame, s.mode);
    this.hands = hands;
    this.inferenceMs = this.inferenceMs * 0.85 + frame.inferenceMs * 0.15;
    this.trackMeter.tick(now);

    const live = new Set<number>();
    const gestureHands: GestureHand[] = [];
    for (const h of hands) {
      live.add(h.id);
      if (!h.fresh) continue;
      const shape = classifyHand(h.obs.world, this.shapes.get(h.id));
      this.shapes.set(h.id, shape);
      gestureHands.push({ id: h.id, shape, anchor: h.palm });
    }
    for (const id of [...this.shapes.keys()]) if (!live.has(id)) this.shapes.delete(id);

    const mapping = effectiveMapping(s.mode, s.twoHandMapping, s.oneHandMapping, hands);
    const corners = resolveCorners(mapping, hands);

    let events: GestureEvent[] = [];
    const calibrating = this.calibrator.state === "waiting" || this.calibrator.state === "holding";
    if (calibrating) {
      this.calibrator.update(now, corners.map((c) => (c?.fresh ? c.point : null)), s.mode);
      this.gestureProgress = [];
      this.gestures.reset();
      if (this.calibrator.state === "done" && this.calibrator.result) this.applyCalibration(this.calibrator.result);
      if (this.calibrator.state === "failed") this.toast(this.calibrator.message);
    } else {
      const r = this.gestures.update(now, gestureHands, s.gestures[s.mode]);
      events = r.events;
      this.gestureProgress = r.progress;
    }
    const wasLocked = this.portal.isLocked();
    this.portal.update(now, corners, events);
    for (const e of events) {
      if (e.action === "reset") this.toast("Portal reset");
      else if (this.portal.isLocked() !== wasLocked) this.toast(this.portal.isLocked() ? "Portal locked" : "Portal unlocked");
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  private tick = (t: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.simulated && t - this.lastSimAt >= 33) {
      this.lastSimAt = t;
      this.trackFrame(t, this.sim.frame(t, this.renderer?.stageAspect || 16 / 9));
    }
    const s = this.settings;
    const snap = this.portal.snapshot(t);
    const content = this.effectiveContent();
    const r = this.renderer;
    if (r) {
      r.render({
        time: t / 1000,
        portal: { corners: snap.corners, visibility: snap.visibility, locked: snap.locked, warn: snap.validity !== "valid" && !snap.locked },
        content,
        fit: s.fit,
        mapping: s.mapping,
        fullscreenTransform: s.fullscreenTransform,
        mirror: s.mirror,
        glow: s.glow,
        energy: this.reducedMotion ? Math.min(s.energy, 0.25) : s.energy,
        particles: s.particles && !this.reducedMotion,
      });
      this.overlay?.draw({
        stage: r.stage,
        dpr: r.dpr,
        hands: this.hands,
        skeleton: s.showSkeleton,
        labels: s.showLabels,
        portal: snap,
        gestures: this.gestureProgress,
      });
    }
    this.renderMeter.tick(t);

    // Billing guard: Decart charges per generated second, so stop when nobody is looking.
    const visible = snap.visibility > 0.5;
    if (visible) this.lastPortalVisibleAt = t;
    if (s.source === "decart" && this.session.active && s.idlePauseSec > 0 && t - this.lastPortalVisibleAt > s.idlePauseSec * 1000) {
      this.session.stop("paused");
      this.toast("AI paused to save credits");
    } else if (s.source === "decart" && this.session.state === "paused" && visible && this.camera.stream) {
      this.startAI();
    }

    if (t - this.lastPublish > 160) {
      this.lastPublish = t;
      this.publish(snap.phase, snap.locked, snap.validity, visible);
    }
  };

  private get reducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  private effectiveContent(): ContentSource {
    const s = this.settings;
    if (s.source !== "decart") return s.source;
    const st = this.session.state;
    if (s.autoFallback && (st === "error" || st === "unconfigured" || !this.camera.stream)) return "local";
    return "decart";
  }

  // ── AI ────────────────────────────────────────────────────────────────────

  private syncAI() {
    const want = this.settings.source === "decart" && !!this.camera.stream;
    const st = this.session.state;
    if (want && !this.session.active && (st === "off" || st === "paused")) this.startAI();
    if (!want && (this.session.active || st === "paused")) this.session.stop("off");
    this.publish();
  }

  private startAI() {
    if (!this.camera.stream) return;
    const s = this.settings;
    this.lastPortalVisibleAt = performance.now();
    void this.session.start(this.camera.stream, {
      model: s.model,
      prompt: s.prompt,
      enhance: s.enhance,
      image: this.referenceImage,
      fast: s.fast,
      mirror: s.mirror,
    });
  }

  /** Switch what fills the portal. Choosing Decart (re)starts a session, clearing any error. */
  setSource(source: ContentSource) {
    if (source === "decart" && !this.camera.stream) this.toast("Start the camera to stream to Decart");
    // A previous failure must not block a deliberate retry; syncAI() (via the settings
    // subscription) then starts exactly one session.
    if (source === "decart" && (this.session.state === "error" || this.session.state === "unconfigured")) {
      this.session.stop("off");
    }
    updateSettings((s) => ({ source, previewSource: source === "decart" ? s.previewSource : source }));
  }

  retryAI() {
    if (this.settings.source !== "decart") this.setSource("decart");
    else {
      this.session.stop("off");
      this.startAI();
    }
  }

  setReferenceImage(blob: Blob | null) {
    this.referenceImage = blob;
    const s = this.settings;
    void this.session.update(s.prompt, s.enhance, blob);
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) this.gestureProgress = [];
    this.toast(this.paused ? "Tracking paused" : "Tracking resumed");
    this.publish();
  }

  toggleLock() {
    this.portal.toggleLock();
    this.toast(this.portal.isLocked() ? "Portal locked" : "Portal unlocked");
  }

  reset() {
    this.portal.reset();
    this.toast("Portal reset");
  }

  startCalibration() {
    if (!this.camera.stream && !this.simulated) {
      this.toast("Start the camera first");
      return;
    }
    if (this.paused) this.togglePause();
    this.calibrator.start(performance.now());
    this.publish();
  }

  cancelCalibration() {
    this.calibrator.cancel();
    this.publish();
  }

  private applyCalibration(r: CalibrationResult) {
    const s = this.settings;
    let mapping = s.twoHandMapping;
    if (s.mode === "two-hand") {
      if (r.swapA) mapping = swapVertical(mapping, "A");
      if (r.swapB) mapping = swapVertical(mapping, "B");
    }
    this.portal.home = r.home;
    updateSettings({ calibration: { ...r, at: Date.now() }, twoHandMapping: mapping, smoothing: r.suggestedMinCutoff });
    const swapped = r.swapA || r.swapB ? " · finger mapping adapted to your pose" : "";
    this.toast(`Calibrated · smoothing ${r.suggestedMinCutoff} Hz${swapped}`);
  }

  async snapshot() {
    if (!this.renderer) return;
    const blob = await this.renderer.capture();
    if (blob) {
      downloadBlob(blob, `domain-${timestamp()}.png`);
      this.toast("Snapshot saved");
    }
  }

  async toggleRecording() {
    if (!this.renderer) return;
    if (this.recorder.recording) {
      const out = await this.recorder.stop();
      if (out) downloadBlob(out.blob, `domain-${timestamp()}.${out.ext}`);
      this.toast("Recording saved");
    } else if (Recorder.supported()) {
      this.recorder.start(this.renderer.canvas, 30);
      this.toast("Recording…");
    } else this.toast("Recording is not supported in this browser");
    this.publish();
  }

  /** Read-only state for automated QA (exposed as window.__domain with ?qa). */
  debugState() {
    const snap = this.portal.snapshot(performance.now());
    const st = this.status.get();
    return {
      phase: snap.phase,
      locked: snap.locked,
      validity: snap.validity,
      visibility: snap.visibility,
      corners: snap.corners,
      fingers: snap.fingers,
      hands: this.hands.map((h) => ({ id: h.id, role: h.role, fresh: h.fresh, handedness: h.obs.handedness })),
      stage: this.renderer?.stage ?? null,
      content: st.content,
      ai: st.ai.state,
      renderFps: st.renderFps,
      trackFps: st.trackFps,
      inferenceMs: st.inferenceMs,
    };
  }

  // ── Settings & status ─────────────────────────────────────────────────────

  private portalOptions(s: Settings) {
    return {
      smoothing: { minCutoff: s.smoothing, beta: s.responsiveness, dCutoff: 1 },
      invalidPolicy: s.invalidPolicy,
      lingerMs: s.lingerMs,
      scale: s.portalScale,
    };
  }

  private applySettings(s: Settings, prev: Settings | null) {
    this.portal.setOptions(this.portalOptions(s));
    this.portal.home = s.calibration?.home ?? DEFAULT_HOME;
    this.assigner.options = { ...this.assigner.options, graceMs: s.graceMs };
    if (!prev) return;

    if (prev.mode !== s.mode) {
      this.assigner.reset();
      this.gestures.reset();
    }
    if (prev.detectionConfidence !== s.detectionConfidence && this.tracker.ready) {
      const c = s.detectionConfidence;
      void this.tracker.setOptions({ minDetection: c, minPresence: c, minTracking: c });
    }
    if (prev.source !== s.source) this.syncAI();
    const reconnect = prev.model !== s.model || prev.fast !== s.fast || prev.mirror !== s.mirror;
    if (reconnect && this.session.active) this.startAI();
    else if (prev.prompt !== s.prompt || prev.enhance !== s.enhance) {
      clearTimeout(this.promptTimer);
      // Debounced so typing does not send a state update per keystroke.
      this.promptTimer = setTimeout(() => void this.session.update(s.prompt, s.enhance, this.referenceImage), 450);
    }
  }

  private hint(phase: PortalPhase, locked: boolean, validity: QuadValidity): string {
    const s = this.settings;
    const b = s.gestures[s.mode];
    const lock = SHORT_GESTURE[b.lock];
    const reset = SHORT_GESTURE[b.reset];
    if (this.paused) return "Tracking paused — press Space to resume";
    const cal = this.calibrator.state;
    if (cal === "waiting" || cal === "holding") return this.calibrator.message;
    if (locked) return lock ? `Locked — ${lock} again to unlock` : "Locked — press L to unlock";
    if (phase === "searching")
      return s.mode === "two-hand"
        ? "Raise both hands: thumbs and index fingers frame the portal"
        : "Raise one spread hand, palm to the camera";
    if (phase === "home") return "Portal reset — raise your hands to take it back";
    if (validity !== "valid" && s.invalidPolicy === "hold") return "Corners crossed — holding the last valid shape";
    if (phase === "coasting") return "Reacquiring a hand…";
    return [lock && `${lock} to lock`, reset && `${reset} to reset`].filter(Boolean).join(" · ");
  }

  private toast(text: string) {
    this.patch({ toast: { id: ++this.toastId, text } });
  }

  private patch(p: Partial<EngineStatus>) {
    this.status.set((s) => ({ ...s, ...p }));
  }

  private patchAI(p: Partial<EngineStatus["ai"]>) {
    this.status.set((s) => ({ ...s, ai: { ...s.ai, ...p } }));
  }

  private publish(phase?: PortalPhase, locked?: boolean, validity?: QuadValidity, visible?: boolean) {
    const prev = this.status.get();
    const m = this.session.metrics;
    const ph = phase ?? prev.phase;
    const lk = locked ?? prev.locked;
    const va = validity ?? prev.validity;
    const latency = m.g2gMs ?? m.rttMs;
    this.status.set({
      ...prev,
      simulated: this.simulated,
      simCaption: this.simulated ? simBeat(performance.now() / 1000) : "",
      paused: this.paused,
      renderFps: this.renderMeter.rate(),
      trackFps: this.trackMeter.rate(),
      inferenceMs: this.inferenceMs,
      hands: this.hands.filter((h) => h.fresh).length,
      phase: ph,
      locked: lk,
      validity: va,
      portalVisible: visible ?? prev.portalVisible,
      hint: this.hint(ph, lk, va),
      content: this.effectiveContent(),
      ai: {
        ...prev.ai,
        state: this.session.state,
        detail: this.session.detail || (prev.ai.configured === null ? prev.ai.detail : ""),
        configured: this.session.state === "unconfigured" ? false : prev.ai.configured,
        seconds: m.seconds,
        latencyMs: latency,
        latencyKind: m.g2gMs != null ? "g2g" : m.rttMs != null ? "rtt" : null,
        ttffMs: m.ttffMs,
        fps: m.fps,
        quality: m.quality,
      },
      calibration: { state: this.calibrator.state, progress: this.calibrator.progress, message: this.calibrator.message },
      recording: this.recorder.recording,
    });
  }
}
