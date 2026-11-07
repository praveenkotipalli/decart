/**
 * Shared contract of the "hand frame" toy (the window frame style).
 *
 * Everything here is plain data. The pure logic (poses, gate, frame, flip, loupe,
 * effects, ToyController) produces it; the GL renderer, the 2D tracker overlay and
 * the React HUD consume it. Units:
 *  - "stage space" is [0,1]² over the displayed (mirrored) camera frame, y down.
 *  - "frame heights" is the isotropic unit: stage y, or stage x multiplied by the
 *    camera aspect ratio.
 *  - controller times are milliseconds on the performance.now() clock; `ToyScene.time`
 *    and `ToyScene.dt` are seconds because that is what the shaders take.
 */
import type { Quad, Vec2 } from "../geometry/vec";
import type { HandRole } from "../tracking/handAssignment";
import type { Vec3 } from "../tracking/landmarks";

export type EffectId = "frame" | "draw" | "particles" | "fog" | "vanish";
/** Index + 1 is the keyboard key. */
export const EFFECT_ORDER: readonly EffectId[] = ["frame", "draw", "particles", "fog", "vanish"];

export type FilterId = "rose" | "none" | "cobalt" | "violet" | "silver";
export type TintId = Exclude<FilterId, "none">;

export type PoseName = "L" | "OK" | "point" | "fist" | "palm";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What the anime switch is doing, as shown to the user.
 * `live` means AI pixels are on screen right now; every other value means they are not.
 */
export type AnimeView = "off" | "connecting" | "live" | "stalled" | "paused" | "unconfigured" | "error" | "budget";

/** One hand's pose for one tracking result. Flags carry hysteresis through the previous pose. */
export interface HandPose {
  name: PoseName | null;
  l: boolean;
  ok: boolean;
  point: boolean;
  fist: boolean;
  palm: boolean;
  indexOut: boolean;
  thumbOut: boolean;
  /** middle, ring, pinky */
  curled: [boolean, boolean, boolean];
  /** Wrist–PIP–tip angle per finger (middle, ring, pinky), degrees: ~175 straight, ~50 curled. */
  curlDeg: [number, number, number];
  /** Angle between the index direction and the thumb direction, degrees. */
  phiDeg: number;
  /** Thumb tip ↔ index tip distance / palm length (from HandShape). */
  pinchRatio: number;
  /** False when the metric landmarks have collapsed (typically the back of the hand). */
  worldOk: boolean;
  /** This result was not trusted (clipped by the frame edge, or a size jump): flags were copied from the previous pose. */
  uncertain: boolean;
  /** Hand scale: the longest side of the wrist / index-knuckle / pinky-knuckle triangle, frame heights. */
  s2: number;
  /** Normalised palm cross product: about ±0.77 flat-on, 0 edge-on. Its sign says which side of the hand faces the camera. */
  cPalm: number;
  /** Cross product of the unit index and thumb directions: opposite sign to cPalm in an L. */
  cL: number;
  /** This result's vote for which side faces the camera (0 = no opinion). */
  facing: 1 | -1 | 0;
  /** The thumb–index ring of an OK sign: centre in stage space, equivalent radius in frame heights. */
  ring: { center: Vec2; rEq: number; openness: number } | null;
  /** Result time, ms. */
  at: number;
}

/** One tracked hand for one tracking result. */
export interface HandSample {
  id: number;
  role: HandRole;
  fresh: boolean;
  /** How long this track id has existed, ms. */
  ageMs: number;
  /** 21 landmarks, stage space (mirrored like the display). */
  points: Vec3[];
  palm: Vec2;
  pose: HandPose;
}

/** Render-rate view of one hand: landmarks glided between tracking results. */
export interface HandKinematics {
  id: number;
  role: HandRole;
  fresh: boolean;
  /** 21 glided landmarks, stage space. */
  points: Vec2[];
  /** Thumb, index, middle, ring, pinky tips: stage units per second. */
  tipVel: Vec2[];
  palm: Vec2;
  /** Palm speed in label pixels per second (250 ms average). */
  speedPx: number;
  /** Hand scale, frame heights (see HandPose.s2). */
  s2: number;
}

/** Stage space. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/** Normalised to the unmirrored camera frame. */
export interface RawFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface LoupeSnapshot {
  handId: number;
  /** Stage space. */
  center: Vec2;
  /** Frame heights. */
  radius: number;
  zoom: number;
  /** 0..1, already eased. */
  visibility: number;
}

export type PlateState = "none" | "countdown" | "capturing" | "ready";

/**
 * Line segments to stamp into an offscreen target (ink, or the fog wipe mask).
 * Per stamp: ax, ay, bx, by (stage space), radius (frame heights), r, g, b, a (0..1, not premultiplied).
 */
export class StampBuffer {
  static readonly STRIDE = 9;
  readonly data: Float32Array;
  count = 0;

  constructor(readonly capacity = 256) {
    this.data = new Float32Array(capacity * StampBuffer.STRIDE);
  }

  /** Returns false (and stores nothing) when the buffer is full. */
  push(ax: number, ay: number, bx: number, by: number, radius: number, rgba: readonly [number, number, number, number]): boolean {
    if (this.count >= this.capacity) return false;
    const o = this.count * StampBuffer.STRIDE;
    const d = this.data;
    d[o] = ax;
    d[o + 1] = ay;
    d[o + 2] = bx;
    d[o + 3] = by;
    d[o + 4] = radius;
    d[o + 5] = rgba[0];
    d[o + 6] = rgba[1];
    d[o + 7] = rgba[2];
    d[o + 8] = rgba[3];
    this.count++;
    return true;
  }

  reset() {
    this.count = 0;
  }
}

/** Everything the GL renderer needs for one frame of the toy. */
export interface ToyScene {
  effect: EffectId;
  /** Seconds, monotonic. */
  time: number;
  /** Seconds since the previous scene. */
  dt: number;
  /**
   * The hand frame (effects "frame" and "vanish"). Corners in stage space, in the fixed
   * order [A index, B index, B thumb, A thumb]; crossed and concave quads are drawn as given.
   * `arm` is the bracket arm as a fraction of its edge: 0..1/6, or 0.5 when locked (full outline).
   */
  frame: { quad: Quad; visibility: number; arm: number; locked: boolean } | null;
  loupes: LoupeSnapshot[];
  /**
   * What is shown inside the frame and the loupes. Rows index the filter lookup texture; -1 = no filter.
   * `anime*` is the AI mix (0 or 1) before and after the running transition; progress 1 = idle.
   */
  treatment: { rowFrom: number; rowTo: number; animeFrom: number; animeTo: number; progress: number; seed: number; tiles: boolean };
  /** Vanish: `mix` 1 = show the remembered room instead of the camera; `capture` asks the renderer to store the current camera frame. */
  plate: { mix: number; capture: "none" | "replace" | "blend" };
  /** Draw: segments to add to the paint layer this frame. */
  ink: { stamps: StampBuffer; clear: boolean } | null;
  /** Fog: wipe segments, how many decay steps are due, whether to re-fog at once, overall fog amount 0..1. */
  fog: { stamps: StampBuffer; decaySteps: number; reset: boolean; density: number } | null;
  /** Particles. Per spark (stride 5): x, y (stage space), size (frame heights), life 0..1, hue 0..1. */
  sparks: { data: Float32Array; count: number } | null;
}

export interface TrackerHand {
  role: HandRole;
  /** A = "L" (screen left), B = "R". */
  side: "L" | "R";
  fresh: boolean;
  /** 21 glided landmarks, stage space. */
  points: Vec2[];
  pose: PoseName | null;
  speedPx: number;
  /** Reticles and the wrist caption are drawn for engaged hands only (pose L, OK, point or fist). */
  engaged: boolean;
  /** 0..1 progress of a hold gesture (fist to clear), 0 = none. */
  hold: number;
  debugText: string | null;
}

/** Everything the 2D tracker overlay needs for one frame. */
export interface TrackerScene {
  /** The `trackers` switch. Hold rings and the countdown are drawn even when it is off. */
  enabled: boolean;
  debug: boolean;
  /** Pixel space of the coordinate labels (the camera frame). */
  space: { w: number; h: number };
  hands: TrackerHand[];
  face: (FaceBox & { alpha: number }) | null;
  /** Small caption next to corner 0 of the frame naming what is inside it. `swatch` is a CSS colour or null. */
  frameTag: { at: Vec2; text: string; tone: "camera" | "busy" | "live"; swatch: string | null } | null;
  loupes: LoupeSnapshot[];
  /** Vanish capture countdown, seconds left; null = none. */
  countdown: number | null;
}

export interface ToyStatus {
  effect: EffectId;
  gate: "idle" | "arming" | "open";
  frameVisible: boolean;
  crossed: boolean;
  locked: boolean;
  loupes: number;
  /** The stored filter and the one actually applied (see filters.effectiveFilter). */
  filter: FilterId;
  effectiveFilter: FilterId;
  poseA: PoseName | null;
  poseB: PoseName | null;
  handsFresh: number;
  /** No fresh hand for at least 1.5 s. */
  handsIdle: boolean;
  /** Exactly one hand has held an L for at least 600 ms while the frame is closed. */
  oneL: boolean;
  plate: PlateState;
  /** Seconds left of the vanish countdown, 0 = none. */
  countdown: number;
  /** null = the face detector is not running. */
  face: boolean | null;
  /** A frame or loupe that shows the AI picture is on screen (effect "frame" only). Input of the billing guard. */
  aiConsumerVisible: boolean;
  /** A fresh hand is in an L or OK pose in effect "frame". Input of the billing guard (resume). */
  poseIntent: boolean;
  simCaption: string;
}

/** Corner order of the hand frame. */
export const FRAME_CORNERS = ["A index", "B index", "B thumb", "A thumb"] as const;

export type { Quad, Vec2, Vec3, HandRole };
