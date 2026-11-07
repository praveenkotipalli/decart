import { models, resolveFpsNumber } from "@decartai/sdk";
import { prepareAiInput, type AiInput } from "../ai/aiInputStream";
import { animeModelInfo, animePrompt, resolveAnimeModel } from "../ai/animePrompts";
import { animeView } from "../ai/animeView";
import { guardGrant, guardInit, guardStep, type GuardState } from "../ai/billingGuard";
import type { DecartSession } from "../ai/DecartSession";
import type { CameraManager } from "../camera/CameraManager";
import type { Settings } from "../config/settings";
import type { Renderer } from "../render/Renderer";
import { displayRect } from "../toy/frameMath";
import type { AnimeView } from "../toy/types";

/** How long the tab may stay hidden before a billed session is paused. */
const HIDDEN_PAUSE_MS = 10_000;
const PROMPT_DEBOUNCE_MS = 450;

export interface AnimeStatus {
  on: boolean;
  view: AnimeView;
  /** Billed seconds since anime was last switched on, and the allowance that switch granted. */
  usedSec: number;
  budgetSec: number;
  /** Whole seconds the current connection attempt has been running. */
  connectingSec: number;
  model: string;
  pricePerSec: number;
  /** Set when the AI picture cannot be lined up exactly with the camera. */
  warning: string | null;
}

export interface AnimeHost {
  session: DecartSession;
  camera: CameraManager;
  settings(): Settings;
  renderer(): Renderer | null;
  /** From the server's health check; empty while unknown. */
  allowedModels(): string[];
  /** Whether the server holds a Decart key (null = server unreachable / not asked yet). */
  configured(): boolean | null;
  toast(text: string): void;
  /** Called when a prompt was refused, with the prompt fields that were last accepted. */
  revertPrompt(good: { animePreset: string; animePrompt: string | null }): void;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * The anime switch of the hand-frame toy: starts and stops the Decart session, keeps
 * the picture it sends lined up with the camera, and enforces the billing guards.
 *
 * Billing rules, all enforced here:
 *  - anime is off on every page load and only an explicit toggle turns it on;
 *  - the session is paused when nothing on screen shows the AI picture for a while, and
 *    when the tab is hidden; it resumes only when the user poses for a frame;
 *  - each toggle grants a fixed number of billed seconds, after which anime turns off.
 */
export class AnimeDriver {
  private on = false;
  private budgetHit = false;
  private guard: GuardState;
  private input: AiInput | null = null;
  private connectStartedAt = 0;
  private usedSec = 0;
  private lastView: AnimeView = "off";
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private good: { animePreset: string; animePrompt: string | null };

  constructor(private host: AnimeHost) {
    const s = host.settings();
    this.guard = guardInit(performance.now(), s.animeBudgetSec);
    this.good = { animePreset: s.animePreset, animePrompt: s.animePrompt };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  dispose() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearTimeout(this.hiddenTimer);
    clearTimeout(this.promptTimer);
    this.input?.dispose();
    this.input = null;
  }

  get isOn() {
    return this.on;
  }

  /** The model that will actually be used: the chosen one if the server allows it. */
  modelId(): string {
    const s = this.host.settings();
    return resolveAnimeModel(s.animeModel, this.host.allowedModels()) ?? s.animeModel;
  }

  /** The model's own frame size: the camera is opened at this size so nothing has to be rescaled. */
  nativeSize(): { width: number; height: number; fps: number } {
    try {
      const m = models.realtime(this.modelId() as Parameters<typeof models.realtime>[0]);
      return { width: m.width, height: m.height, fps: resolveFpsNumber(m.fps) };
    } catch {
      const info = animeModelInfo(this.modelId());
      return { width: info.width, height: info.height, fps: 30 };
    }
  }

  view(now = performance.now()): AnimeView {
    const ai = this.host.renderer()?.aiStatus();
    const age = ai?.lastFrameAt ? now - ai.lastFrameAt : Infinity;
    const v = animeView(this.on, this.host.session.state, Boolean(ai?.ready), age, this.budgetHit);
    // Without a key on the server the switch cannot work: say so before it is pressed.
    return v === "off" && this.host.configured() === false ? "unconfigured" : v;
  }

  status(now = performance.now()): AnimeStatus {
    const s = this.host.settings();
    const view = this.view(now);
    const model = this.modelId();
    return {
      on: this.on,
      view,
      usedSec: this.usedSec,
      budgetSec: s.animeBudgetSec,
      connectingSec: view === "connecting" ? Math.max(0, Math.floor((now - this.connectStartedAt) / 1000)) : 0,
      model,
      pricePerSec: animeModelInfo(model).pricePerSec,
      warning: this.alignmentWarning(view),
    };
  }

  /** `d`: on, off, or — after an error — try again. */
  toggle() {
    const view = this.view();
    if (this.on && view !== "error") {
      this.turnOff();
      this.host.toast("anime off");
      return;
    }
    if (!this.host.camera.stream) {
      this.host.toast("start the camera to stream to Decart");
      return;
    }
    if (this.host.configured() === false) {
      this.host.toast("anime needs a Decart key on the server");
      return;
    }
    const sess = this.host.session;
    if (sess.state === "error" || sess.state === "unconfigured") sess.stop("off");
    const s = this.host.settings();
    this.budgetHit = false;
    this.guard = guardGrant(this.guard, s.animeBudgetSec);
    this.on = true;
    const perMinute = animeModelInfo(this.modelId()).pricePerSec * 60;
    this.host.toast(`anime on · billed per second · $${perMinute.toFixed(2)} a minute`);
    this.start();
  }

  /** Switch anime off without a message (camera stopped, frame style changed). */
  turnOff() {
    this.on = false;
    this.stop("off");
  }

  /** Run once per rendered frame. `toy` is what is on screen: it decides whether billing may continue. */
  step(now: number, toy: { aiConsumerVisible: boolean; poseIntent: boolean } | null) {
    const s = this.host.settings();
    const sess = this.host.session;
    const r = guardStep(
      this.guard,
      {
        now,
        on: this.on,
        ai: sess.state,
        consumerVisible: Boolean(toy?.aiConsumerVisible),
        poseIntent: Boolean(toy?.poseIntent),
        tabHidden: document.hidden,
        sessionSeconds: sess.metrics.seconds,
      },
      { idleSec: s.idlePauseSec, hiddenSec: HIDDEN_PAUSE_MS / 1000 },
    );
    this.guard = r.state;
    this.usedSec = r.usedSec;
    if (r.action === "pause") {
      this.stop("paused");
      this.host.toast("anime paused to save credits");
    } else if (r.action === "resume") {
      if (this.host.camera.stream) this.start();
    } else if (r.action === "stop-budget") {
      const cost = r.usedSec * animeModelInfo(this.modelId()).pricePerSec;
      this.on = false;
      this.budgetHit = true;
      this.stop("off");
      this.host.toast(`anime budget reached · ${clock(r.usedSec)} · $${cost.toFixed(2)} — press d to continue`);
    }

    const view = this.view(now);
    if (view === "live" && this.lastView !== "live" && this.lastView !== "stalled") this.host.toast("anime is live");
    this.lastView = view;
  }

  /** React to a settings change (model, mirror, style, prompt). */
  settingsChanged(prev: Settings, next: Settings) {
    const sess = this.host.session;
    if (prev.animeModel !== next.animeModel) {
      void this.applyCameraSize().then(() => {
        if (this.on && sess.active) this.start();
      });
    } else if (prev.mirror !== next.mirror) {
      if (this.on && sess.active) this.start();
    } else if (
      prev.animePreset !== next.animePreset ||
      prev.animePrompt !== next.animePrompt ||
      prev.animeEnhance !== next.animeEnhance
    ) {
      clearTimeout(this.promptTimer);
      // Debounced so typing does not send a state update per keystroke.
      this.promptTimer = setTimeout(() => void this.sendPrompt(), PROMPT_DEBOUNCE_MS);
    }
  }

  /** Ask the camera for the current model's frame size (used when the model changes mid-session). */
  async applyCameraSize() {
    const track = this.host.camera.track;
    if (!track) return;
    const n = this.nativeSize();
    try {
      await track.applyConstraints({ width: { ideal: n.width }, height: { ideal: n.height }, frameRate: { ideal: n.fps, max: 60 } });
    } catch {
      /* the camera keeps its size; the input is cropped to the model's shape instead */
    }
  }

  private async sendPrompt() {
    const s = this.host.settings();
    const sess = this.host.session;
    if (!this.on || !sess.active) {
      this.good = { animePreset: s.animePreset, animePrompt: s.animePrompt };
      return;
    }
    const p = animePrompt(s.animePreset, this.modelId(), s.animePrompt, s.animeEnhance);
    await sess.update(p.text, p.enhance, null);
    // DecartSession reports a refused update through `detail` and keeps the old prompt running.
    if (sess.state === "live" && sess.detail) {
      this.host.toast(sess.detail);
      this.host.revertPrompt(this.good);
    } else {
      this.good = { animePreset: s.animePreset, animePrompt: s.animePrompt };
    }
  }

  private start() {
    const cam = this.host.camera;
    if (!cam.stream) return;
    const s = this.host.settings();
    const model = this.modelId();
    this.input?.dispose();
    const size = { width: cam.video.videoWidth, height: cam.video.videoHeight };
    // Crops the camera to the model's shape when they differ, so the AI picture covers a
    // known region of the camera frame and can be drawn exactly over it.
    this.input = prepareAiInput(cam.stream, size, this.nativeSize(), s.mirror);
    this.host.renderer()?.setAiRect(displayRect(this.input.rect, s.mirror));
    const p = animePrompt(s.animePreset, model, s.animePrompt, s.animeEnhance);
    this.connectStartedAt = performance.now();
    void this.host.session.start(this.input.stream, {
      model,
      prompt: p.text,
      enhance: p.enhance,
      image: null,
      fast: false,
      // When the crop already flipped the frames, the SDK must not flip them again.
      mirror: s.mirror && !this.input.mirrored,
    });
  }

  private stop(as: "off" | "paused") {
    clearTimeout(this.promptTimer);
    const sess = this.host.session;
    if (as === "paused" || sess.active || sess.state !== "off") sess.stop(as);
    this.input?.dispose();
    this.input = null;
  }

  /** requestAnimationFrame stops in a hidden tab, so the hidden-tab pause needs its own timer. */
  private onVisibility = () => {
    clearTimeout(this.hiddenTimer);
    if (!document.hidden) return;
    this.hiddenTimer = setTimeout(() => {
      if (document.hidden && this.on && this.host.session.active) this.stop("paused");
    }, HIDDEN_PAUSE_MS);
  };

  private alignmentWarning(view: AnimeView): string | null {
    if (view !== "live" || !this.input) return null;
    const v = this.host.session.video;
    const cam = this.host.camera.video;
    if (!v.videoWidth || !v.videoHeight || !cam.videoWidth || !cam.videoHeight) return null;
    const sent = (cam.videoWidth * this.input.rect.w) / (cam.videoHeight * this.input.rect.h);
    const got = v.videoWidth / v.videoHeight;
    const off = Math.abs(got / sent - 1);
    return off > 0.005
      ? `the AI frame is ${v.videoWidth}×${v.videoHeight}, ${(off * 100).toFixed(1)}% off the shape that was sent — edges may be slightly misaligned`
      : null;
  }
}
