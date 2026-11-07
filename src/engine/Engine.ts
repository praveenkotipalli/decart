import { models, resolveFpsNumber } from "@decartai/sdk";
import { animeTag, animeTone } from "../ai/animeView";
import { DecartSession, type AIState } from "../ai/DecartSession";
import { CameraError, CameraManager, type CameraErrorKind } from "../camera/CameraManager";
import { Compositor } from "../capture/Compositor";
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
import { TrackerOverlay } from "../render/TrackerOverlay";
import { effectiveFilter, FILTERS, nextFilter } from "../toy/filters";
import { SimulatedToy, toyBeat } from "../toy/SimulatedToy";
import { ToyController, type ToyEnv, type ToyEvent, type ToyOptions } from "../toy/ToyController";
import type { EffectId, ToyScene, ToyStatus } from "../toy/types";
import { facePolicy, InferenceLoad } from "../tracking/FaceTrack";
import { HandAssigner, type TrackedHand } from "../tracking/handAssignment";
import { HandTracker } from "../tracking/HandTracker";
import type { HandFrame } from "../tracking/landmarks";
import { SimulatedHands, simBeat } from "../tracking/SimulatedHands";
import { AnimeDriver, type AnimeStatus } from "./AnimeDriver";
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
  /** Which experience is running: the hand-frame toy ("window") or the classic portal. */
  frameStyle: Settings["frameStyle"];
  /** Hand-frame toy state; null in classic style. */
  toy: ToyStatus | null;
  anime: AnimeStatus;
  /** Whether the face detector is running (window style). */
  faceTracking: boolean;
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
  frameStyle: "window",
  toy: null,
  anime: { on: false, view: "off", usedSec: 0, budgetSec: 0, connectingSec: 0, model: "", pricePerSec: 0, warning: null },
  faceTracking: false,
};

const SHORT_GESTURE: Record<string, string> = {
  "pinch-middle": "pinch thumb + middle",
  "pinch-index": "pinch thumb + index",
  fist: "make a fist",
  "open-palm": "open palm",
  "open-palm-solo": "show one open palm",
  none: "",
};

/** Render rate below this for LOW_FPS_MS switches the toy to its cheaper settings (one way). */
const LOW_FPS = 45;
const LOW_FPS_MS = 3000;
const NO_PORTAL = { corners: null, visibility: 0, locked: false, warn: false } as const;

const toyOptions = (s: Settings): ToyOptions => ({
  effect: s.effect,
  filter: s.filter,
  lastTint: s.lastTint,
  glitch: s.glitch,
  loupeZoom: s.loupeZoom,
  smoothing: { minCutoff: s.smoothing, beta: s.responsiveness, dCutoff: 1 },
  trackers: s.trackers,
});

export class Engine {
  readonly status = createStore<EngineStatus>({ ...INITIAL, frameStyle: settingsStore.get().frameStyle });
  readonly camera = new CameraManager();
  private tracker = new HandTracker();
  private trackerInit: Promise<void> | null = null;
  private sim = new SimulatedHands();
  private simToy = new SimulatedToy();
  private assigner = new HandAssigner();
  private gestures = new GestureMachine();
  private portal = new PortalController();
  private calibrator = new Calibrator();
  private session = new DecartSession();
  private recorder = new Recorder();
  private compositor: Compositor | null = null;
  private renderer: Renderer | null = null;
  private overlay: Overlay | null = null;
  private trackerOverlay: TrackerOverlay | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeNow: (() => void) | null = null;
  private settings: Settings = settingsStore.get();
  private unsubscribe: (() => void) | null = null;
  private toy = new ToyController(toyOptions(this.settings));
  private anime: AnimeDriver;

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
  private lastFrameAt = 0;
  private renderMeter = new RateMeter();
  private trackMeter = new RateMeter();
  private inferenceMs = 0;
  private referenceImage: Blob | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private toastId = 0;
  private toyStatus: ToyStatus | null = null;
  private toyScene: ToyScene | null = null;
  private captureWaiters: ((b: Blob | null) => void)[] = [];
  private lowFps = false;
  private lowFpsSince = 0;
  /** The frame-rate governor ignores start-up stutter (model loading, shader compilation) until this time. */
  private calmUntil = performance.now() + 8000;
  private face = { running: false, coolUntil: 0, enabledAt: 0 };
  /** 1 s average of the hand inference time, and how long it has sat on one side of the face policy's thresholds. */
  private load = new InferenceLoad();
  private loadSample = { handInferenceMs: 0, steadyMs: 0 };
  private readonly debug: { poses: boolean; onion: boolean; face: boolean };

  constructor() {
    const q = new URLSearchParams(location.search);
    const debug = (q.get("debug") ?? "").split(",");
    this.debug = { poses: debug.includes("poses"), onion: debug.includes("onion"), face: q.get("face") !== "0" };

    this.anime = new AnimeDriver({
      session: this.session,
      camera: this.camera,
      settings: () => this.settings,
      renderer: () => this.renderer,
      allowedModels: () => this.status.get().ai.allowedModels,
      configured: () => this.status.get().ai.configured,
      toast: (text) => this.toast(text),
      revertPrompt: (good) => updateSettings(good),
    });

    let lastAIState = this.session.state;
    this.session.onChange = () => {
      if (this.session.state === "error" && lastAIState !== "error") {
        this.toast(`${this.settings.frameStyle === "window" ? "anime stopped" : "AI stopped"} — ${this.session.detail}`);
      }
      lastAIState = this.session.state;
      this.publish();
    };
    this.session.onStream = (video) => this.renderer?.setAI(video);
    this.tracker.onResult = (frame) => {
      if (!this.simulated && this.camera.stream) this.trackFrame(frame.time, frame);
    };
    this.tracker.onFaces = (faces, mirror, time) => this.toy.onFace(time, faces, mirror);
    this.tracker.onFaceStatus = (running) => {
      this.face.running = running;
      if (!running) this.toy.onFace(performance.now(), null, this.settings.mirror);
    };
    this.tracker.onError = (message) => console.warn("[tracker]", message);
    this.camera.video.addEventListener("resize", this.syncStageAspect);
    this.applySettings(this.settings, null);
    this.unsubscribe = settingsStore.subscribe(() => {
      const next = settingsStore.get();
      const prev = this.settings;
      this.settings = next;
      this.applySettings(next, prev);
    });
    void this.checkServer();
  }

  private get windowStyle() {
    return this.settings.frameStyle === "window";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach(glCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement, container: HTMLElement) {
    try {
      this.renderer = new Renderer(glCanvas);
    } catch (err) {
      this.patch({ webglError: (err as Error).message });
      return;
    }
    // Both overlays draw on the same canvas; only the one for the current frame style is used.
    this.overlay = new Overlay(overlayCanvas);
    this.trackerOverlay = new TrackerOverlay(overlayCanvas);
    this.overlayCanvas = overlayCanvas;
    this.renderer.setCamera(this.camera.stream ? this.camera.video : null);
    this.renderer.setAI(this.session.video.srcObject ? this.session.video : null);
    if (this.lowFps) this.renderer.setMaxDpr(1);
    const resize = () => {
      const r = container.getBoundingClientRect();
      const before = `${glCanvas.width}x${glCanvas.height}`;
      this.renderer!.resize(r.width, r.height, window.devicePixelRatio || 1);
      this.overlay!.resize(glCanvas.width, glCanvas.height);
      // Resizing a canvas clears it: draw again now so a resize never shows a blank frame.
      if (this.lastFrameAt && before !== `${glCanvas.width}x${glCanvas.height}`) this.frame(performance.now());
    };
    this.resizeNow = resize;
    resize();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(container);
    this.raf = requestAnimationFrame(this.tick);
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.resizeNow = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.overlay = null;
    this.trackerOverlay = null;
    this.overlayCanvas = null;
  }

  dispose() {
    this.detach();
    this.stopCamera();
    this.anime.dispose();
    this.session.dispose();
    this.tracker.close();
    this.camera.video.removeEventListener("resize", this.syncStageAspect);
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

  /** The frame size to ask the camera for: the active AI model's own size, so nothing is rescaled on the way. */
  private cameraSize(): { width: number; height: number; fps: number } {
    if (this.windowStyle) return this.anime.nativeSize();
    try {
      const m = models.realtime(this.settings.model as Parameters<typeof models.realtime>[0]);
      return { width: m.width, height: m.height, fps: resolveFpsNumber(m.fps) };
    } catch {
      return { width: 1280, height: 720, fps: 30 }; // unknown model: keep 720p30
    }
  }

  /** The letterboxed stage takes the camera's shape; CSS reads it from these properties. */
  private syncStageAspect = () => {
    const v = this.camera.video;
    const on = Boolean(this.camera.stream && v.videoWidth && v.videoHeight);
    const w = on ? v.videoWidth : 16;
    const h = on ? v.videoHeight : 9;
    const root = document.documentElement.style;
    root.setProperty("--stage-ar", `${w} / ${h}`);
    root.setProperty("--stage-ar-n", (w / h).toFixed(5));
  };

  async startCamera() {
    this.patch({ camera: "starting", cameraDetail: "" });
    const trackerReady = this.ensureTracker().catch(() => undefined);
    const size = this.cameraSize();
    try {
      await this.camera.start(size);
    } catch (err) {
      const e = err instanceof CameraError ? err : new CameraError("error", String(err));
      this.patch({ camera: e.kind, cameraDetail: e.message });
      return;
    }
    this.renderer?.setCamera(this.camera.video);
    this.syncStageAspect();
    this.patch({ camera: "on", cameraLabel: this.camera.label });
    this.camera.track?.addEventListener("ended", () => {
      this.patch({ camera: "error", cameraDetail: "The camera was disconnected." });
      this.stopCamera(false);
    });
    await trackerReady;
    this.calmUntil = performance.now() + 6000;
    this.scheduleTracking();
    this.syncAI();
  }

  stopCamera(updateStatus = true) {
    if (this.rvfcHandle && "cancelVideoFrameCallback" in this.camera.video) {
      this.camera.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = 0;
    this.tracker.enableFace(false);
    // Stop billing before the stream it feeds on goes away.
    if (this.anime.isOn) this.anime.turnOff();
    this.camera.stop();
    this.renderer?.setCamera(null);
    this.syncStageAspect();
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
    this.gestureProgress = [];
    this.portal = new PortalController(this.portalOptions(this.settings));
    this.portal.home = this.settings.calibration?.home ?? DEFAULT_HOME;
    this.toy.reset();
    this.load.reset();
    this.loadSample = { handInferenceMs: 0, steadyMs: 0 };
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
    if (this.windowStyle) this.trackToy(now, frame);
    else this.trackPortal(now, frame);
  }

  /** Shape flags per fresh hand, kept by track id so their hysteresis carries over. */
  private classifyShapes(hands: TrackedHand[], each?: (h: TrackedHand, shape: HandShape) => void) {
    const live = new Set<number>();
    for (const h of hands) {
      live.add(h.id);
      if (!h.fresh) continue;
      const shape = classifyHand(h.obs.world, this.shapes.get(h.id));
      this.shapes.set(h.id, shape);
      each?.(h, shape);
    }
    for (const id of [...this.shapes.keys()]) if (!live.has(id)) this.shapes.delete(id);
  }

  /** Pixel space of the tracker labels: the camera frame (720p for simulated hands). */
  private labelSpace(): { w: number; h: number } {
    return this.renderer?.cameraSize ?? { w: 1280, h: 720 };
  }

  // ── The hand-frame toy ────────────────────────────────────────────────────

  private trackToy(now: number, frame: HandFrame) {
    // The frame always takes two hands; the classic one-hand mode does not apply here.
    const hands = this.assigner.update(frame, "two-hand");
    this.hands = hands;
    this.inferenceMs = this.inferenceMs * 0.85 + frame.inferenceMs * 0.15;
    this.trackMeter.tick(now);
    if (!this.simulated) this.loadSample = this.load.sample(now, frame.inferenceMs, this.face.running);
    this.classifyShapes(hands);
    for (const e of this.toy.onTracking(now, hands, this.shapes, frame.aspect, this.labelSpace())) this.onToyEvent(e);
  }

  private onToyEvent(e: ToyEvent) {
    switch (e.type) {
      case "flip":
        this.cycleFilter(1);
        break;
      case "lock":
        this.toast(e.locked ? "frame locked" : "frame unlocked");
        break;
      case "plate":
        if (e.state === "ready") this.toast("room memorised");
        break;
      case "cleared":
        this.toast("cleared");
        break;
    }
  }

  private frameToy(t: number, dt: number) {
    const s = this.settings;
    const r = this.renderer;
    const anime = this.anime.status(t);
    const env: ToyEnv = {
      animeShowing: anime.view === "live",
      animeTag: animeTag(anime.view, anime.connectingSec),
      animeTone: animeTone(anime.view),
      reducedMotion: this.reducedMotion,
      lowFps: this.lowFps,
      space: this.labelSpace(),
      debug: this.debug.poses,
      simCaption: this.simulated ? toyBeat(t / 1000) : "",
    };
    const { scene, trackers, status } = this.toy.snapshot(t, dt, env);
    this.toyStatus = status;
    this.toyScene = scene;
    if (r) {
      r.render({
        time: t / 1000,
        portal: NO_PORTAL,
        content: "local",
        fit: s.fit,
        mapping: "window",
        fullscreenTransform: false,
        mirror: s.mirror,
        glow: 0,
        energy: 0,
        particles: false,
        toy: scene,
        anime: this.anime.isOn,
        onion: this.debug.onion,
      });
      this.trackerOverlay?.draw(trackers, { width: r.canvas.width, height: r.canvas.height, dpr: r.dpr, stage: r.stage, time: t });
      this.captureToy(r);
    }
    this.anime.step(t, status);
    this.governFps(t);
    this.governFace(t);
  }

  /**
   * Snapshots and recordings of the toy include the tracker graphics, which live on a
   * separate canvas: flatten both, in the same task as the GL draw.
   */
  private captureToy(r: Renderer) {
    if (!this.recorder.recording && !this.captureWaiters.length) return;
    const comp = (this.compositor ??= new Compositor());
    comp.compose(r.canvas, this.settings.captureTrackers ? this.overlayCanvas : null);
    if (this.captureWaiters.length) {
      const waiting = this.captureWaiters.splice(0);
      void comp.toBlob().then((b) => waiting.forEach((resolve) => resolve(b)));
    }
  }

  /** On a machine that cannot hold the frame rate, trade resolution and spark count for it. One way: no flip-flopping. */
  private governFps(t: number) {
    if (this.lowFps || document.hidden) return;
    if (t < this.calmUntil) {
      this.lowFpsSince = 0;
      return;
    }
    const fps = this.renderMeter.rate(t);
    if (fps >= LOW_FPS) {
      this.lowFpsSince = 0;
      return;
    }
    if (!this.lowFpsSince) this.lowFpsSince = t;
    else if (t - this.lowFpsSince > LOW_FPS_MS) {
      this.lowFps = true;
      this.renderer?.setMaxDpr(1);
      this.resizeNow?.();
    }
  }

  /**
   * The face box needs a second model in the tracking worker. It runs only while hand
   * tracking has headroom, and is switched off again when it does not.
   */
  private governFace(t: number) {
    const s = this.settings;
    const camera = Boolean(this.camera.stream) && !this.simulated && this.tracker.ready;
    const needed = camera && this.debug.face && this.tracker.faceSupported && (s.trackers || s.effect === "vanish");
    const p = facePolicy(
      { running: this.face.running, coolUntil: this.face.coolUntil },
      { now: t, mode: s.faceBox, needed, ...this.loadSample },
    );
    this.face.coolUntil = p.coolUntil;
    const want = p.want && this.trackMeter.rate(t) > 0;
    if (want !== this.tracker.faceEnabled) {
      this.tracker.enableFace(want, p.intervalMs);
      this.face.enabledAt = t;
    } else if (want) this.tracker.setFaceInterval(p.intervalMs);
  }

  setEffect(effect: EffectId) {
    if (this.settings.effect !== effect) updateSettings({ effect });
  }

  /** `f`, the filter pill, or one flipped hand: step to the next (or previous) filter. */
  cycleFilter(dir: 1 | -1 = 1) {
    const s = this.settings;
    if (!this.windowStyle || s.effect !== "frame") return;
    const showing = this.anime.view() === "live";
    // Step from the filter that is on screen, which is not the stored one while "clear" is being replaced.
    const next = nextFilter(effectiveFilter(s.filter, showing, s.lastTint), dir, !showing);
    updateSettings({ filter: next, lastTint: next === "none" ? s.lastTint : next });
    this.toast(`filter · ${FILTERS[next].label}`);
  }

  toggleTrackers() {
    const on = !this.settings.trackers;
    updateSettings({ trackers: on });
    this.toast(on ? "trackers on" : "trackers off");
  }

  toggleAnime() {
    if (!this.windowStyle) return;
    if (this.simulated && !this.camera.stream) {
      this.toast("start the camera to stream to Decart");
      return;
    }
    this.anime.toggle();
    this.publish();
  }

  /** `c`: the current effect's own action (clear the ink, re-fog, memorise the room …). */
  effectAction() {
    if (!this.windowStyle) return;
    for (const e of this.toy.command("action", performance.now())) this.onToyEvent(e);
  }

  /** `Esc` in window style: cancel a running countdown. */
  cancelToy() {
    if (!this.windowStyle) return;
    for (const e of this.toy.command("cancel", performance.now())) this.onToyEvent(e);
  }

  // ── The classic portal ────────────────────────────────────────────────────

  private trackPortal(now: number, frame: HandFrame) {
    const s = this.settings;
    const hands = this.assigner.update(frame, s.mode);
    this.hands = hands;
    this.inferenceMs = this.inferenceMs * 0.85 + frame.inferenceMs * 0.15;
    this.trackMeter.tick(now);

    const gestureHands: GestureHand[] = [];
    this.classifyShapes(hands, (h, shape) => gestureHands.push({ id: h.id, shape, anchor: h.palm }));

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

  private framePortal(t: number) {
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

    // Billing guard: Decart charges per generated second, so stop when nobody is looking.
    const visible = snap.visibility > 0.5;
    if (visible) this.lastPortalVisibleAt = t;
    if (s.source === "decart" && this.session.active && s.idlePauseSec > 0 && t - this.lastPortalVisibleAt > s.idlePauseSec * 1000) {
      this.session.stop("paused");
      this.toast("AI paused to save credits");
    } else if (s.source === "decart" && this.session.state === "paused" && visible && this.camera.stream) {
      this.startAI();
    }
    return { phase: snap.phase, locked: snap.locked, validity: snap.validity, visible };
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  private tick = (t: number) => {
    this.raf = requestAnimationFrame(this.tick);
    this.frame(t);
  };

  private frame(t: number) {
    const dt = this.lastFrameAt ? Math.min(0.1, Math.max(0, (t - this.lastFrameAt) / 1000)) : 1 / 60;
    this.lastFrameAt = t;
    if (this.simulated && t - this.lastSimAt >= 33) {
      this.lastSimAt = t;
      const aspect = this.renderer?.stageAspect || 16 / 9;
      this.trackFrame(t, this.windowStyle ? this.simToy.frame(t, aspect) : this.sim.frame(t, aspect));
    }

    if (this.windowStyle) {
      this.frameToy(t, dt);
      this.renderMeter.tick(t);
      if (t - this.lastPublish > 160) {
        this.lastPublish = t;
        this.publish();
      }
      return;
    }

    const p = this.framePortal(t);
    this.renderMeter.tick(t);
    if (t - this.lastPublish > 160) {
      this.lastPublish = t;
      this.publish(p.phase, p.locked, p.validity, p.visible);
    }
  }

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

  // ── AI (classic portal; the toy's anime switch lives in AnimeDriver) ───────

  private syncAI() {
    if (this.windowStyle) {
      // Nothing starts by itself in window style: anime is an explicit, per-launch switch.
      this.publish();
      return;
    }
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
    this.renderer?.setAiRect({ x: 0, y: 0, w: 1, h: 1 });
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
    if (this.windowStyle) {
      for (const e of this.toy.command("lock", performance.now())) this.onToyEvent(e);
      return;
    }
    this.portal.toggleLock();
    this.toast(this.portal.isLocked() ? "Portal locked" : "Portal unlocked");
  }

  reset() {
    if (this.windowStyle) {
      this.toy.command("reset", performance.now());
      return;
    }
    this.portal.reset();
    this.toast("Portal reset");
  }

  startCalibration() {
    if (this.windowStyle) return;
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
    const blob = this.windowStyle
      ? await new Promise<Blob | null>((resolve) => this.captureWaiters.push(resolve))
      : await this.renderer.capture();
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
      if (this.windowStyle) {
        const comp = (this.compositor ??= new Compositor());
        // Give the recording canvas its size before the stream starts; frames follow from the render loop.
        comp.compose(this.renderer.canvas, null);
        this.recorder.start(comp.canvas, 30);
      } else this.recorder.start(this.renderer.canvas, 30);
      this.toast("Recording…");
    } else this.toast("Recording is not supported in this browser");
    this.publish();
  }

  /** Pixel colours of the next rendered frame at stage positions (automated QA only). */
  probe(points: { x: number; y: number }[]): Promise<number[][]> {
    return this.renderer ? this.renderer.probe(points) : Promise.resolve([]);
  }

  /** Read-only state for automated QA (exposed as window.__domain with ?qa). */
  debugState() {
    const st = this.status.get();
    const base = {
      frameStyle: this.settings.frameStyle,
      hands: this.hands.map((h) => ({ id: h.id, role: h.role, fresh: h.fresh, handedness: h.obs.handedness })),
      stage: this.renderer?.stage ?? null,
      canvas: this.renderer ? { w: this.renderer.canvas.width, h: this.renderer.canvas.height, dpr: this.renderer.dpr } : null,
      content: st.content,
      ai: st.ai.state,
      renderFps: st.renderFps,
      trackFps: st.trackFps,
      inferenceMs: st.inferenceMs,
    };
    if (this.windowStyle) {
      const scene = this.toyScene;
      return {
        ...base,
        toy: this.toyStatus,
        frame: scene?.frame ?? null,
        loupes: scene?.loupes ?? [],
        treatment: scene?.treatment ?? null,
        sparks: scene?.sparks?.count ?? 0,
        anime: this.anime.status(),
        filter: this.settings.filter,
        effect: this.settings.effect,
        lowFps: this.lowFps,
        face: this.face.running,
      };
    }
    const snap = this.portal.snapshot(performance.now());
    return {
      ...base,
      phase: snap.phase,
      locked: snap.locked,
      validity: snap.validity,
      visibility: snap.visibility,
      corners: snap.corners,
      fingers: snap.fingers,
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
    this.toy.setOptions(toyOptions(s));
    if (!prev) return;

    if (prev.frameStyle !== s.frameStyle) this.switchStyle(s);
    if (prev.mode !== s.mode) {
      this.assigner.reset();
      this.gestures.reset();
    }
    if (prev.detectionConfidence !== s.detectionConfidence && this.tracker.ready) {
      const c = s.detectionConfidence;
      void this.tracker.setOptions({ minDetection: c, minPresence: c, minTracking: c });
    }

    if (s.frameStyle === "window") {
      // A mirror change moves every landmark and turns the remembered room plate the wrong way round.
      if (prev.mirror !== s.mirror) this.toy.reset();
      if (prev.frameStyle === s.frameStyle) this.anime.settingsChanged(prev, s);
      return;
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

  /** Changing between the toy and the classic portal: nothing billed or tracked carries over. */
  private switchStyle(s: Settings) {
    clearTimeout(this.promptTimer);
    this.anime.turnOff();
    if (this.session.active || this.session.state !== "off") this.session.stop("off");
    this.calibrator.cancel();
    this.tracker.enableFace(false);
    this.resetTracking();
    this.toyStatus = null;
    this.toyScene = null;
    this.trackerOverlay?.clear();
    this.patch({ frameStyle: s.frameStyle, toy: null });
    if (this.camera.stream) {
      void this.anime.applyCameraSize();
      if (s.frameStyle === "classic") this.syncAI();
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
    const win = this.windowStyle;
    const ph = phase ?? prev.phase;
    const lk = locked ?? prev.locked;
    const va = validity ?? prev.validity;
    const latency = m.g2gMs ?? m.rttMs;
    const now = performance.now();
    this.status.set({
      ...prev,
      simulated: this.simulated,
      simCaption: this.simulated ? (win ? toyBeat(now / 1000) : simBeat(now / 1000)) : "",
      paused: this.paused,
      renderFps: this.renderMeter.rate(),
      trackFps: this.trackMeter.rate(),
      inferenceMs: this.inferenceMs,
      hands: this.hands.filter((h) => h.fresh).length,
      phase: ph,
      locked: win ? Boolean(this.toyStatus?.locked) : lk,
      validity: va,
      portalVisible: win ? Boolean(this.toyStatus?.frameVisible) : (visible ?? prev.portalVisible),
      hint: win ? "" : this.hint(ph, lk, va),
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
      frameStyle: this.settings.frameStyle,
      toy: win ? this.toyStatus : null,
      anime: this.anime.status(now),
      faceTracking: this.face.running,
    });
  }
}

