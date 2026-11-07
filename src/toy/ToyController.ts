/**
 * The orchestrator of the hand-frame toy (the "window" frame style).
 *
 * Two clocks feed it. Tracking results (5–17 Hz, stamped with the time of the camera frame
 * they came from, so a little behind the render clock) go through `onTracking`: the poses
 * are classified, the glided landmarks updated, and the gate, frame, flip, loupe and effect
 * state machines stepped. Render frames (60 Hz) call `snapshot`, which turns that state into
 * plain data for the GL renderer (ToyScene), the 2D tracker overlay (TrackerScene) and the
 * HUD (ToyStatus).
 *
 * The controller owns no setting: the engine keeps the `ToyOptions` and pushes every change
 * through `setOptions`. A flip event in particular does not change the filter here; the
 * engine cycles it, and the new filter arriving as an option is what starts the treatment
 * transition.
 *
 * Pure: no DOM, no clocks, no randomness. Everything that runs per render frame reuses its
 * buffers (the stamp buffers, the hand samples, the corner samples).
 */
import type { Quad } from "../geometry/vec";
import type { HandShape } from "../gestures/classifier";
import { classifyPose, describePose } from "../gestures/poses";
import { FaceTrack } from "../tracking/FaceTrack";
import type { HandRole, TrackedHand } from "../tracking/handAssignment";
import { HandMotion } from "../tracking/handMotion";
import { LM, type HandObservation } from "../tracking/landmarks";
import type { OneEuroParams } from "../tracking/oneEuro";
import { DrawEffect } from "./effects/draw";
import { FogEffect } from "./effects/fog";
import { SparksEffect } from "./effects/sparks";
import { VanishEffect } from "./effects/vanish";
import { effectiveFilter, FILTERS, TreatmentTransition, type Treatment } from "./filters";
import { FlipDetector } from "./FlipDetector";
import { FrameController, type CornerSample, type FrameSnapshot } from "./FrameController";
import { FrameGate, type GateHand } from "./frameGate";
import { LoupeController } from "./LoupeController";
import {
  StampBuffer,
  type EffectId,
  type FilterId,
  type HandPose,
  type HandSample,
  type LoupeSnapshot,
  type PlateState,
  type PoseName,
  type RawFace,
  type TintId,
  type ToyScene,
  type ToyStatus,
  type TrackerHand,
  type TrackerScene,
} from "./types";

export interface ToyOptions {
  effect: EffectId;
  filter: FilterId;
  /** The last filter that was not "none": shown in its place while anime is not on screen. */
  lastTint: TintId;
  /** Tile-glitch transition when the look inside the frame changes; a plain cross-fade otherwise. */
  glitch: boolean;
  /** Magnification of the OK-sign loupe, 1.5–3. */
  loupeZoom: number;
  /** One Euro parameters of the frame corners (the Stability / Responsiveness settings). */
  smoothing: OneEuroParams;
  /** The trackers switch (TrackerScene.enabled). */
  trackers: boolean;
}

/** What the engine knows at render time and the controller does not. */
export interface ToyEnv {
  /** AI pixels are on screen right now. */
  animeShowing: boolean;
  /** A short anime state for the frame tag ("anime connecting 5 s", "anime paused"…), or null when there is none. */
  animeTag: string | null;
  animeTone: "camera" | "busy" | "live";
  reducedMotion: boolean;
  lowFps: boolean;
  /** Pixel space of the tracker labels (the camera frame). */
  space: { w: number; h: number };
  /** The `?debug=poses` readout. */
  debug: boolean;
  /** Caption of the scripted demo, when it is running. */
  simCaption?: string;
}

export type ToyEvent =
  | { type: "flip"; role: HandRole | null; cause: "facing" | "twist" }
  | { type: "frame"; open: boolean }
  | { type: "cleared" }
  | { type: "plate"; state: PlateState }
  | { type: "lock"; locked: boolean };

export const TOY_T = {
  /** ToyStatus.handsIdle: no fresh hand for this long, ms. */
  idleMs: 1500,
  /** ToyStatus.oneL: exactly one hand has held an L this long while the frame is closed, ms. */
  oneLMs: 600,
  /** A frame or loupe above this opacity shows the AI picture (ToyStatus.aiConsumerVisible). */
  consumerVisible: 0.5,
  /** A fingertip this far outside the picture still moves its corner (the frame controller clamps it there). */
  tipMargin: 0.02,
} as const;

const NO_CORNERS: (CornerSample | null)[] = [null, null, null, null];
const EMPTY_LOUPES: LoupeSnapshot[] = [];

/**
 * The pose of a hand nothing is known about yet: first seen while coasting, or without a
 * HandShape for it. Untrusted and flagless, so every consumer leaves it alone.
 */
function blankPose(obs: HandObservation, aspect: number, time: number): HandPose {
  const p = obs.points;
  const d = (a: number, b: number) => Math.hypot((p[a].x - p[b].x) * aspect, p[a].y - p[b].y);
  const s2 = Math.max(d(LM.WRIST, LM.INDEX_MCP), d(LM.INDEX_MCP, LM.PINKY_MCP), d(LM.PINKY_MCP, LM.WRIST));
  return {
    name: null,
    l: false,
    ok: false,
    point: false,
    fist: false,
    palm: false,
    indexOut: false,
    thumbOut: false,
    curled: [false, false, false],
    curlDeg: [0, 0, 0],
    phiDeg: 0,
    pinchRatio: 2,
    worldOk: false,
    uncertain: true,
    s2,
    cPalm: 0,
    cL: 0,
    facing: 0,
    ring: null,
    at: time,
  };
}

export class ToyController {
  private options: ToyOptions;
  private aspect = 16 / 9;
  /** Latest render time seen; the frame controller's fades only ever move forward. */
  private lastSnapshotAt = -Infinity;

  // ── Per tracking result ──────────────────────────────────────────────────────────────────
  private readonly motion = new HandMotion();
  /** Pose per track id; the previous one carries the classifier's hysteresis. */
  private readonly poses = new Map<number, HandPose>();
  /** The hands of the latest result (reused objects), in the assigner's order. */
  private readonly samples: HandSample[] = [];
  private readonly samplePool: HandSample[] = [];
  private readonly live = new Set<number>();
  /** When each track started holding an L on trusted results; coasting and untrusted results keep it. */
  private readonly lSince = new Map<number, number>();
  private lastFreshAt = -Infinity;

  // ── The frame (effects frame and vanish) ─────────────────────────────────────────────────
  private readonly gate = new FrameGate();
  private readonly frame: FrameController;
  private readonly flip = new FlipDetector();
  private readonly loupes: LoupeController;
  private readonly gateA: GateHand = { present: false, fresh: false, pose: null, palm: null };
  private readonly gateB: GateHand = { present: false, fresh: false, pose: null, palm: null };
  private readonly cornerPool: CornerSample[] = [0, 1, 2, 3].map(() => ({ point: { x: 0, y: 0 }, handId: 0, fresh: true, accept: true }));
  private readonly corners: (CornerSample | null)[] = [null, null, null, null];
  /** The gate state last handed to the frame controller, and the one last reported as an event. */
  private openGiven = false;
  private wasOpen = false;

  // ── The look inside the frame ────────────────────────────────────────────────────────────
  private readonly treatment: TreatmentTransition;
  /** Something that shows the treatment (frame or loupe) was on screen at the last snapshot. */
  private treatmentShown = false;
  /** The next treatment change jumps instead of animating (after an effect switch or a reset). */
  private snapTreatment = true;

  // ── Effects 2–5 ──────────────────────────────────────────────────────────────────────────
  private readonly draw = new DrawEffect();
  private readonly sparks = new SparksEffect();
  private readonly fog = new FogEffect();
  /** `fog.enter` needs a time, which setOptions does not have: done on the next snapshot. */
  private fogEnterPending: boolean;
  private readonly vanish = new VanishEffect();
  private lastPlate: PlateState = "none";
  private readonly ink = new StampBuffer();
  private readonly fogStamps = new StampBuffer();
  private readonly poseNames = new Map<number, PoseName | null>();

  private readonly face = new FaceTrack();
  /** describePose output per hand, rebuilt only when the pose object changes. */
  private readonly debugText = new Map<number, { pose: HandPose; text: string }>();

  constructor(options: ToyOptions) {
    this.options = { ...options, smoothing: { ...options.smoothing } };
    this.frame = new FrameController({ smoothing: this.options.smoothing });
    this.loupes = new LoupeController({ zoom: options.loupeZoom });
    this.treatment = new TreatmentTransition({ row: FILTERS[effectiveFilter(options.filter, false, options.lastTint)].row, anime: 0 });
    this.fogEnterPending = options.effect === "fog";
  }

  /**
   * A settings change. A filter (or lastTint) change starts the treatment transition on the
   * next snapshot; an effect change resets the gesture state (ink, sparks and the room plate
   * stay). Fields left undefined are unchanged.
   */
  setOptions(patch: Partial<ToyOptions>): void {
    const prev = this.options;
    const next: ToyOptions = {
      effect: patch.effect ?? prev.effect,
      filter: patch.filter ?? prev.filter,
      lastTint: patch.lastTint ?? prev.lastTint,
      glitch: patch.glitch ?? prev.glitch,
      loupeZoom: patch.loupeZoom ?? prev.loupeZoom,
      smoothing: patch.smoothing ? { ...patch.smoothing } : prev.smoothing,
      trackers: patch.trackers ?? prev.trackers,
    };
    this.options = next;
    if (next.effect !== prev.effect) this.enterEffect(next.effect);
    if (next.loupeZoom !== prev.loupeZoom) this.loupes.setZoom(next.loupeZoom);
    const s = next.smoothing;
    const p = prev.smoothing;
    if (s.minCutoff !== p.minCutoff || s.beta !== p.beta || s.dCutoff !== p.dCutoff) this.frame.setOptions({ smoothing: s });
  }

  /**
   * One tracking result: every hand the assigner tracks (coasting ones included), the shape
   * flags the engine classified for the fresh ones, the camera aspect and the label pixel
   * space. `time` is the result's own (camera frame) time. Returns this result's events.
   */
  onTracking(time: number, hands: TrackedHand[], shapes: ReadonlyMap<number, HandShape>, aspect: number, space: { w: number; h: number }): ToyEvent[] {
    if (aspect > 0) this.aspect = aspect;
    aspect = this.aspect;
    this.motion.update(time, hands, aspect, space);

    // Poses: a fresh hand is classified against its previous pose; a coasting one (or one
    // without shape flags) keeps what it had.
    const samples = this.samples;
    samples.length = 0;
    this.live.clear();
    let anyFresh = false;
    for (const h of hands) {
      if (h.obs.points.length < 21 || this.live.has(h.id)) continue;
      this.live.add(h.id);
      const prev = this.poses.get(h.id);
      const shape = shapes.get(h.id);
      const pose = h.fresh && shape ? classifyPose(h.obs, shape, aspect, time, prev) : (prev ?? blankPose(h.obs, aspect, time));
      this.poses.set(h.id, pose);
      if (h.fresh) anyFresh = true;
      const s = this.sampleSlot(samples.length);
      s.id = h.id;
      s.role = h.role;
      s.fresh = h.fresh;
      s.ageMs = this.motion.ageMs(h.id, time);
      s.points = h.obs.points;
      s.palm = h.palm;
      s.pose = pose;
      samples.push(s);
      this.trackL(s, time);
    }
    for (const id of this.poses.keys()) {
      if (this.live.has(id)) continue;
      this.poses.delete(id);
      this.lSince.delete(id);
      this.debugText.delete(id);
    }
    if (anyFresh) this.lastFreshAt = time;

    const events: ToyEvent[] = [];
    const effect = this.options.effect;
    switch (effect) {
      case "frame":
        this.updateFrame(time, samples, aspect, true, events);
        this.loupes.update(time, samples, true, aspect);
        break;
      case "vanish":
        this.updateFrame(time, samples, aspect, false, events);
        this.vanish.update(time, { hands: samples.length, face: this.face.present(time) });
        break;
      case "draw":
        this.draw.update(time, samples, aspect);
        break;
      case "particles":
        this.sparks.update(time, samples);
        break;
      case "fog":
        break;
    }
    this.plateEvents(events);
    return events;
  }

  /** A face detector result (`null` = the detector is not running). */
  onFace(time: number, faces: RawFace[] | null, mirror: boolean): void {
    this.face.update(time, faces, mirror);
    // The "nobody here" clock of the automatic room capture runs on face results too, between hand results.
    if (this.options.effect === "vanish") this.vanish.update(time, { hands: this.samples.length, face: this.face.present(time) });
  }

  /**
   * A key. `action` is `c`: clear the ink / the sparks, re-fog, or start (or cancel) the room
   * capture countdown; nothing in effect frame. `lock` toggles the frame lock (frame and
   * vanish). `cancel` stops a countdown. `reset` is reset().
   */
  command(c: "action" | "lock" | "reset" | "cancel", time: number): ToyEvent[] {
    const events: ToyEvent[] = [];
    const effect = this.options.effect;
    switch (c) {
      case "action":
        switch (effect) {
          case "draw":
            this.draw.clear();
            events.push({ type: "cleared" });
            break;
          case "particles":
            this.sparks.clear();
            events.push({ type: "cleared" });
            break;
          case "fog":
            this.fog.reset();
            events.push({ type: "cleared" });
            break;
          case "vanish":
            if (this.vanish.state === "countdown") this.vanish.cancel();
            else if (this.vanish.state !== "capturing") this.vanish.requestCapture(time);
            break;
          case "frame":
            break;
        }
        break;
      case "lock":
        if (effect === "frame" || effect === "vanish") {
          // toggleLock returns the new state, and false when there was nothing to lock: only a change is an event.
          const was = this.frame.isLocked();
          const locked = this.frame.toggleLock();
          if (locked !== was) events.push({ type: "lock", locked });
        }
        break;
      case "cancel":
        if (this.vanish.state === "countdown") this.vanish.cancel();
        break;
      case "reset":
        this.reset();
        break;
    }
    this.plateEvents(events);
    return events;
  }

  /**
   * One render frame. `time` is the render clock (ms, non-decreasing), `dt` the seconds since
   * the previous frame. Cheap: the stamp buffers and samples are reused; only small plain
   * objects are made per call.
   */
  snapshot(time: number, dt: number, env: ToyEnv): { scene: ToyScene; trackers: TrackerScene; status: ToyStatus } {
    const o = this.options;
    const effect = o.effect;
    const aspect = this.aspect;
    this.lastSnapshotAt = time;
    const kin = this.motion.snapshot(time);
    const samples = this.samples;

    let frameSnap: FrameSnapshot | null = null;
    let frame: ToyScene["frame"] = null;
    let loupes: LoupeSnapshot[] = EMPTY_LOUPES;
    let ink: ToyScene["ink"] = null;
    let fog: ToyScene["fog"] = null;
    let sparks: ToyScene["sparks"] = null;
    let capture: ToyScene["plate"]["capture"] = "none";

    if (effect === "frame" || effect === "vanish") {
      this.tickGate(time);
      frameSnap = this.frame.snapshot(time);
      // The controller also reports the quad at visibility 0 while the gate is closed: not drawn.
      if (frameSnap.quad !== null && frameSnap.visibility > 0) {
        frame = { quad: frameSnap.quad, visibility: frameSnap.visibility, arm: frameSnap.arm, locked: frameSnap.locked };
      }
    }
    switch (effect) {
      case "frame":
        loupes = this.loupes.snapshot(time);
        break;
      case "draw":
        // Every frame, hands or not: a departed hand's withheld ink drains here.
        this.ink.reset();
        this.draw.advance(time, kin, this.ink);
        ink = { stamps: this.ink, clear: this.draw.consumeClear() };
        break;
      case "particles":
        this.sparks.advance(time, dt, aspect, kin, env.lowFps || env.reducedMotion);
        sparks = { data: this.sparks.field.data, count: this.sparks.field.count };
        break;
      case "fog": {
        if (this.fogEnterPending) {
          this.fog.enter(time);
          this.fogEnterPending = false;
        }
        this.fogStamps.reset();
        this.poseNames.clear();
        for (const s of samples) this.poseNames.set(s.id, s.pose.name);
        const r = this.fog.advance(time, kin, this.poseNames, this.fogStamps, aspect);
        fog = { stamps: this.fogStamps, decaySteps: r.decaySteps, reset: r.reset, density: r.density };
        break;
      }
      case "vanish":
        capture = this.vanish.consumeCapture(time);
        break;
    }

    // ── The look inside the frame ─────────────────────────────────────────────────────────
    const vanish = effect === "vanish";
    const plateReady = this.vanish.state === "ready";
    // Vanish shows the remembered room with no filter; until there is one, the camera through the last tint.
    const eff: FilterId = vanish ? (plateReady ? "none" : o.lastTint) : effectiveFilter(o.filter, env.animeShowing, o.lastTint);
    const next: Treatment = vanish ? { row: plateReady ? -1 : FILTERS[o.lastTint].row, anime: 0 } : { row: FILTERS[eff].row, anime: env.animeShowing ? 1 : 0 };
    const cur = this.treatment.target;
    if (cur.row !== next.row || cur.anime !== next.anime) {
      // Animate only while the treatment is on screen; otherwise jump, so a frame never opens mid-transition.
      if (this.treatmentShown && !this.snapTreatment) this.treatment.set(next, time, o.glitch && !env.reducedMotion);
      else this.treatment.snap(next);
    }
    this.snapTreatment = false;
    const ts = this.treatment.state(time);

    const frameVis = frameSnap?.visibility ?? 0;
    let loupeVis = 0;
    for (const l of loupes) if (l.visibility > loupeVis) loupeVis = l.visibility;
    this.treatmentShown = frameVis > 0 || loupeVis > 0;

    const scene: ToyScene = {
      effect,
      time: time / 1000,
      dt,
      frame,
      loupes,
      treatment: { rowFrom: ts.from.row, rowTo: ts.to.row, animeFrom: ts.from.anime, animeTo: ts.to.anime, progress: ts.progress, seed: ts.seed, tiles: ts.tiles },
      plate: { mix: vanish && plateReady ? 1 : 0, capture },
      ink,
      fog,
      sparks,
    };

    // ── Trackers ──────────────────────────────────────────────────────────────────────────
    const hands: TrackerHand[] = [];
    for (const k of kin) {
      const s = this.sampleOf(k.id);
      if (s === null) continue;
      const name = s.pose.name;
      hands.push({
        role: k.role,
        side: k.role === "A" ? "L" : "R",
        fresh: k.fresh,
        points: k.points,
        pose: name,
        speedPx: k.speedPx,
        // Open palms get neither reticles nor a caption (as the reel).
        engaged: name !== null && name !== "palm",
        hold: effect === "draw" ? this.draw.holdProgress(k.id) : 0,
        debugText: env.debug ? this.describe(s) : null,
      });
    }
    const countdown = this.vanish.countdown(time);
    const trackers: TrackerScene = {
      enabled: o.trackers,
      debug: env.debug,
      space: env.space,
      hands,
      face: this.face.snapshot(time),
      frameTag: frame === null ? null : this.frameTag(frame.quad, eff, plateReady, env),
      loupes,
      countdown: vanish && this.vanish.state === "countdown" ? countdown : null,
    };

    // ── Status ────────────────────────────────────────────────────────────────────────────
    let handsFresh = 0;
    let poseA: PoseName | null = null;
    let poseB: PoseName | null = null;
    let intent = false;
    for (const s of samples) {
      if (s.fresh) {
        handsFresh++;
        if (s.pose.l || s.pose.ok) intent = true;
      }
      if (s.role === "A") poseA = s.pose.name;
      else poseB = s.pose.name;
    }
    const status: ToyStatus = {
      effect,
      gate: frameSnap !== null ? this.gate.phase : "idle",
      frameVisible: frame !== null,
      crossed: frameSnap?.crossed ?? false,
      locked: frameSnap?.locked ?? false,
      loupes: loupes.length,
      filter: o.filter,
      effectiveFilter: eff,
      poseA,
      poseB,
      handsFresh,
      handsIdle: time - this.lastFreshAt >= TOY_T.idleMs,
      oneL: this.oneL(time),
      plate: this.vanish.state,
      countdown,
      face: this.face.present(time),
      aiConsumerVisible: effect === "frame" && (frameVis > TOY_T.consumerVisible || loupeVis > TOY_T.consumerVisible),
      poseIntent: effect === "frame" && intent,
      simCaption: env.simCaption ?? "",
    };
    return { scene, trackers, status };
  }

  /**
   * Start over (tracking restarted, mirror changed): every pose, track, gate, frame, flip,
   * loupe and pen is forgotten, the room plate invalidated and the face box dropped. Ink and
   * sparks already on the picture stay; `c` clears them.
   */
  reset(): void {
    this.poses.clear();
    this.lSince.clear();
    this.debugText.clear();
    this.live.clear();
    this.samples.length = 0;
    this.motion.reset();
    this.gate.reset();
    this.frame.reset();
    this.flip.reset();
    this.loupes.reset();
    this.draw.reset();
    this.sparks.reset();
    this.vanish.invalidate();
    this.lastPlate = this.vanish.state;
    this.face.reset();
    this.fogEnterPending = this.options.effect === "fog";
    for (let i = 0; i < 4; i++) this.corners[i] = null;
    this.openGiven = false;
    this.wasOpen = false;
    this.treatmentShown = false;
    this.snapTreatment = true;
    this.lastFreshAt = -Infinity;
    this.lastSnapshotAt = -Infinity;
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────

  /** A new effect starts from a clean slate: frame, flip, loupes and every pen / fist state. Ink, sparks and the room plate stay. */
  private enterEffect(effect: EffectId): void {
    this.gate.reset();
    this.frame.reset();
    this.flip.reset();
    this.loupes.reset();
    this.draw.reset();
    this.sparks.reset();
    if (this.vanish.state === "countdown") this.vanish.cancel();
    this.fogEnterPending = effect === "fog";
    for (let i = 0; i < 4; i++) this.corners[i] = null;
    this.openGiven = false;
    this.wasOpen = false;
    // Nothing is on screen any more: the new effect's look jumps in rather than transitioning.
    this.snapTreatment = true;
  }

  /** Gate → corners → frame controller → (effect frame) flip detector, for one result. */
  private updateFrame(time: number, samples: HandSample[], aspect: number, flips: boolean, events: ToyEvent[]): void {
    const a = this.roleSample("A");
    const b = this.roleSample("B");
    this.gateHand(this.gateA, a);
    this.gateHand(this.gateB, b);
    const open = this.gate.update(time, this.gateA, this.gateB, aspect) === "open";

    this.corner(0, a, LM.INDEX_TIP);
    this.corner(1, b, LM.INDEX_TIP);
    this.corner(2, b, LM.THUMB_TIP);
    this.corner(3, a, LM.THUMB_TIP);
    // Every result, open or not: the corner filters settle while the gate is still closed.
    this.frame.update(time, this.corners, open, aspect);
    this.openGiven = open;
    if (open !== this.wasOpen) {
      this.wasOpen = open;
      events.push({ type: "frame", open });
    }
    if (!flips) return;

    // The twist of the live fingertips is computed inside frame.update and read back through a
    // snapshot. Results run a little behind the render clock, and the fades only move forward,
    // so the snapshot is taken at the later of the two times (no fade is advanced twice).
    const twistValid = this.frame.snapshot(Math.max(time, this.lastSnapshotAt)).twistValid;
    const ev = this.flip.update(
      time,
      samples,
      { open, locked: this.frame.isLocked(), openedAt: this.gate.openedAt, closedAt: this.gate.closedAt, twistValid },
      aspect,
    );
    if (ev !== null) events.push({ type: "flip", role: ev.role, cause: ev.cause });
  }

  /** Per render frame: the gate's stall rule. */
  private tickGate(time: number): void {
    const phase = this.gate.tick(time);
    if (phase !== "open" && this.openGiven) {
      // The tracker went quiet and the gate let go on its own: no result will tell the frame
      // controller, so do it here, dropping the corners (they snap to wherever the hands are next seen).
      this.frame.update(time, NO_CORNERS, false, this.aspect);
      this.openGiven = false;
    }
  }

  private gateHand(g: GateHand, s: HandSample | null): void {
    g.present = s !== null;
    g.fresh = s !== null && s.fresh;
    g.pose = s !== null ? s.pose : null;
    g.palm = s !== null ? s.palm : null;
  }

  /** Corner `i` from landmark `lm` of hand `s`; null when that role is not tracked. */
  private corner(i: number, s: HandSample | null, lm: number): void {
    if (s === null) {
      this.corners[i] = null;
      return;
    }
    const c = this.cornerPool[i];
    const p = s.points[lm];
    c.point.x = p.x;
    c.point.y = p.y;
    c.handId = s.id;
    c.fresh = s.fresh;
    // An untrusted pose or a tip well outside the picture leaves the corner where it was.
    const m = TOY_T.tipMargin;
    c.accept = !s.pose.uncertain && p.x >= -m && p.x <= 1 + m && p.y >= -m && p.y <= 1 + m;
    this.corners[i] = c;
  }

  private sampleSlot(i: number): HandSample {
    let s = this.samplePool[i];
    if (s === undefined) {
      s = { id: 0, role: "A", fresh: false, ageMs: 0, points: [], palm: { x: 0, y: 0 }, pose: null as unknown as HandPose };
      this.samplePool[i] = s;
    }
    return s;
  }

  private roleSample(role: HandRole): HandSample | null {
    for (const s of this.samples) if (s.role === role) return s;
    return null;
  }

  private sampleOf(id: number): HandSample | null {
    for (const s of this.samples) if (s.id === id) return s;
    return null;
  }

  /** The "one L" hint: a hand that holds an L while the other does not. Coasting and untrusted results hold the clock. */
  private trackL(s: HandSample, time: number): void {
    if (!s.fresh || s.pose.uncertain) return;
    if (s.pose.l) {
      if (!this.lSince.has(s.id)) this.lSince.set(s.id, time);
    } else this.lSince.delete(s.id);
  }

  private oneL(time: number): boolean {
    if (this.gate.phase === "open") return false;
    let n = 0;
    // Only the time since the frame closed counts: a hand still holding its L right after a release is not "one L" yet.
    for (const since of this.lSince.values()) if (time - Math.max(since, this.gate.closedAt) >= TOY_T.oneLMs) n++;
    return n === 1;
  }

  private plateEvents(events: ToyEvent[]): void {
    const state = this.vanish.state;
    if (state !== this.lastPlate) {
      this.lastPlate = state;
      events.push({ type: "plate", state });
    }
  }

  /** The small caption next to corner 0 naming what is inside the frame. */
  private frameTag(quad: Quad, eff: FilterId, plateReady: boolean, env: ToyEnv): TrackerScene["frameTag"] {
    const at = { x: quad[0].x, y: quad[0].y };
    if (this.options.effect === "vanish") {
      const tint = FILTERS[this.options.lastTint];
      return plateReady
        ? { at, text: "vanish", tone: "camera", swatch: null }
        : { at, text: `${tint.label} · no room yet`, tone: "camera", swatch: tint.swatch[1] };
    }
    const def = FILTERS[eff];
    const text = env.animeShowing ? (eff === "none" ? "anime" : `anime · ${def.label}`) : env.animeTag ? `${def.label} · ${env.animeTag}` : def.label;
    return { at, text, tone: env.animeTone, swatch: eff === "none" ? null : def.swatch[1] };
  }

  private describe(s: HandSample): string {
    let d = this.debugText.get(s.id);
    if (d === undefined || d.pose !== s.pose) {
      d = { pose: s.pose, text: describePose(s.pose) };
      this.debugText.set(s.id, d);
    }
    return d.text;
  }
}
