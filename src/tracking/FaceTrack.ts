import type { FaceBox, RawFace, Rect } from "../toy/types";
import { OneEuro2D, type OneEuroParams } from "./oneEuro";

/**
 * The face box on the main thread: shaping, smoothing, hold / fade and the start-stop policy.
 *
 * The detector itself runs in the tracker worker (`faceTask.ts`) a few times a second on a
 * small copy of the camera frame and reports plain boxes normalised to the unmirrored frame.
 * This module turns them into the one box the tracker overlay draws — stage space, mirrored
 * like the picture, hairline to chin — keeps it steady across missed results, fades it out
 * when the face is gone, and decides when the detector is worth running at all.
 *
 * Pure: time is an argument, nothing here touches the DOM, so it runs in Vitest's node
 * environment.
 */
export const FACE_T = {
  /** BlazeFace boxes run from the eyebrows to the chin: move the top up by this many box heights ... */
  hairlineUp: 0.12,
  /** ... and scale the height so the box reaches the hairline (and a little under the chin). */
  heightScale: 1.22,
  /** The box stays at full strength this long after the last detection, ms ... */
  holdMs: 900,
  /** ... then fades out over this long, ms. */
  fadeMs: 300,
  /**
   * The detector may run as slowly as every 1.2 s, slower than the base hold: the hold is also
   * at least this many detector intervals, so a single missed result never blinks the box.
   */
  holdIntervals: 1.5,
  holdMaxMs: 2400,
  /** Weight of a new interval measurement in the running estimate of the detector interval. */
  tickBlend: 0.3,
  /** A longer gap between detector results is a stall or a restart, not an interval, ms. */
  maxTickGapMs: 3000,
  /** One Euro parameters for the box centre (stage units) and size (stage units). */
  centre: { minCutoff: 0.8, beta: 4, dCutoff: 1.0 } satisfies OneEuroParams,
  size: { minCutoff: 0.6, beta: 2, dCutoff: 1.0 } satisfies OneEuroParams,

  // Policy (section 8): the detector is a luxury that only runs while hand tracking has headroom.
  /** Auto start once the hand inference time has been at or under this ... */
  startBelowMs: 120,
  /** ... continuously for this long, ms. */
  startAfterMs: 3000,
  /** Auto stop once the hand inference time has been above this ... */
  stopAboveMs: 160,
  /** ... continuously for this long, ms ... */
  stopAfterMs: 5000,
  /** ... and do not start again for this long, ms. */
  coolDownMs: 60_000,
  /** Detector interval = clamp(intervalFactor × hand inference time, min, max), ms. */
  intervalFactor: 4,
  intervalMinMs: 300,
  intervalMaxMs: 1200,
  /** Time constant of the hand inference time average the policy reasons about, ms. */
  loadTauMs: 1000,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Clamps a box to the stage, shrinking it rather than moving it. */
function clampBox(x: number, y: number, w: number, h: number): Rect {
  const x0 = clamp(x, 0, 1);
  const y0 = clamp(y, 0, 1);
  const x1 = clamp(x + w, 0, 1);
  const y1 = clamp(y + h, 0, 1);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * A detector box (normalised, unmirrored camera frame) as the stage shows it: mirrored with the
 * picture when `mirror` is set, then extended from the detector's eyebrow-to-chin box to
 * hairline-to-chin, and clamped to the stage.
 */
export function toStageFace(f: RawFace, mirror: boolean): FaceBox {
  const x = mirror ? 1 - (f.x + f.w) : f.x;
  const y = f.y - FACE_T.hairlineUp * f.h;
  const h = f.h * FACE_T.heightScale;
  return { ...clampBox(x, y, f.w, h), score: f.score };
}

/** The largest face by area; null when there is none. Ties keep the earlier one. */
function largest(faces: readonly RawFace[]): RawFace | null {
  let best: RawFace | null = null;
  for (const f of faces) if (!best || f.w * f.h > best.w * best.h) best = f;
  return best;
}

/**
 * The one face box the overlay draws.
 *
 * `update` takes every detector result (the faces of one camera frame, or `null` when the
 * detector is not running); `snapshot` is read every render frame. The largest face wins; its
 * centre and size go through One Euro filters; after the last detection the box holds for
 * `FACE_T.holdMs` (longer when the detector runs slowly) and then fades over `FACE_T.fadeMs`.
 */
export class FaceTrack {
  private running = false;
  /** Time of the last result that contained a face, ms; -Infinity = none yet. */
  private lastSeen = -Infinity;
  /** Time of the last detector result of any kind, ms. */
  private lastTick = NaN;
  /** Measured detector interval, ms. */
  private tickMs = NaN;
  /** Configured detector interval (see `setInterval`), ms. */
  private expectedMs = NaN;
  /** Hold in force for the current box, ms. */
  private hold: number = FACE_T.holdMs;
  private readonly centre = new OneEuro2D({ ...FACE_T.centre });
  private readonly size = new OneEuro2D({ ...FACE_T.size });
  private score = 0;

  /**
   * Tells the track how often the detector is asked to run, so the hold is right from the
   * first result instead of after the interval has been measured. Optional.
   */
  setInterval(intervalMs: number): void {
    this.expectedMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : NaN;
  }

  /**
   * @param faces the detector's boxes for one camera frame (possibly empty), or `null` when the
   *   detector is not running (stopped by the policy, failed, or never started)
   * @param mirror whether that camera frame is displayed mirrored
   */
  update(time: number, faces: RawFace[] | null, mirror: boolean): void {
    if (faces === null) {
      // The detector stopped: `present` says so at once, but a visible box fades rather than pops.
      this.running = false;
      if (this.alphaAt(time) > 0) this.lastSeen = Math.min(this.lastSeen, time - this.hold);
      this.lastTick = NaN;
      this.tickMs = NaN;
      return;
    }
    this.running = true;
    this.tick(time);
    const best = largest(faces);
    if (!best) return; // nobody in the picture: the box holds, then fades
    const box = toStageFace(best, mirror);
    // A face found after the box had gone is a new face (or the same one, somewhere else): jump
    // to it instead of gliding over from where the old box was.
    if (this.alphaAt(time) <= 0) {
      this.centre.reset();
      this.size.reset();
    }
    this.centre.filter({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, time);
    this.size.filter({ x: box.w, y: box.h }, time);
    this.score = box.score;
    this.lastSeen = time;
    this.hold = this.holdFor();
  }

  /** The smoothed box with its fade, or null when there is nothing to draw. */
  snapshot(time: number): (FaceBox & { alpha: number }) | null {
    const alpha = this.alphaAt(time);
    const c = this.centre.value;
    const s = this.size.value;
    if (alpha <= 0 || !c || !s) return null;
    return { ...clampBox(c.x - s.x / 2, c.y - s.y / 2, s.x, s.y), score: this.score, alpha };
  }

  /**
   * Is somebody there? `null` while the detector is not running (so callers cannot mistake
   * "not looking" for "nobody"), `true` while a face is held, `false` when the detector runs
   * and sees nobody (including while the box is only fading).
   */
  present(time: number): boolean | null {
    if (!this.running) return null;
    return time - this.lastSeen <= this.hold;
  }

  reset(): void {
    this.running = false;
    this.lastSeen = -Infinity;
    this.lastTick = NaN;
    this.tickMs = NaN;
    this.hold = FACE_T.holdMs;
    this.centre.reset();
    this.size.reset();
    this.score = 0;
  }

  /** 1 within the hold, then a linear fade to 0; 0 when no face was ever seen. */
  private alphaAt(time: number): number {
    const age = time - this.lastSeen;
    if (age <= this.hold) return 1;
    return clamp(1 - (age - this.hold) / FACE_T.fadeMs, 0, 1);
  }

  /** Records one detector result for the interval estimate. */
  private tick(time: number): void {
    const gap = time - this.lastTick;
    if (gap > 0 && gap <= FACE_T.maxTickGapMs) {
      this.tickMs = Number.isNaN(this.tickMs) ? gap : this.tickMs + FACE_T.tickBlend * (gap - this.tickMs);
    }
    this.lastTick = time;
  }

  private holdFor(): number {
    const interval = Math.max(this.tickMs || 0, this.expectedMs || 0);
    return clamp(FACE_T.holdIntervals * interval, FACE_T.holdMs, FACE_T.holdMaxMs);
  }
}

export type FaceMode = "auto" | "on" | "off";

export interface FacePolicyState {
  /** The detector is on (what was last asked of the tracker, `HandTracker.faceEnabled`). */
  running: boolean;
  /** No automatic start before this time, ms; 0 = none. */
  coolUntil: number;
}

export interface FacePolicyInput {
  now: number;
  /** The `faceBox` setting. */
  mode: FaceMode;
  /** Somebody would use the box: trackers are on, or the effect is vanish. */
  needed: boolean;
  /** Hand inference time, averaged over about a second (`InferenceLoad.sample`), ms. */
  handInferenceMs: number;
  /**
   * How long `handInferenceMs` has continuously been on its current side of the threshold that
   * matters in the current state, ms: at or under `FACE_T.startBelowMs` while the detector is
   * off, above `FACE_T.stopAboveMs` while it is on. It restarts from 0 whenever the average
   * crosses that threshold and whenever `running` changes. `InferenceLoad` computes it.
   */
  steadyMs: number;
}

export interface FacePolicyResult {
  /** The detector should be on. */
  want: boolean;
  /** How often it should run, ms. */
  intervalMs: number;
  /** New cool-down deadline (unchanged unless the policy stopped the detector for load). */
  coolUntil: number;
}

/** Detector interval for a hand inference time: 4× it, between 300 and 1200 ms. */
export function faceInterval(handInferenceMs: number): number {
  const ms = Number.isFinite(handInferenceMs) ? handInferenceMs : 0;
  return clamp(FACE_T.intervalFactor * ms, FACE_T.intervalMinMs, FACE_T.intervalMaxMs);
}

/**
 * Whether the face detector should run (section 8).
 *
 * - `off`: never.
 * - `on`: whenever it is needed, whatever the load and cool-down.
 * - `auto`: when needed, start once hand inference has been ≤ 120 ms for 3 s (and no cool-down
 *   is in force); stop once it has been > 160 ms for 5 s, and then do not start again for 60 s.
 *   Between 120 and 160 ms the current state is kept (hysteresis).
 *
 * The caller keeps `{ running, coolUntil }`, feeds the result back as the next state and acts
 * on `want` (`HandTracker.enableFace`) and `intervalMs` (`HandTracker.setFaceInterval`).
 */
export function facePolicy(s: FacePolicyState, i: FacePolicyInput): FacePolicyResult {
  const intervalMs = faceInterval(i.handInferenceMs);
  let coolUntil = s.coolUntil;
  let want = false;
  if (i.mode === "on") {
    want = i.needed;
  } else if (i.mode === "auto" && i.needed) {
    if (s.running) {
      const overloaded = i.handInferenceMs > FACE_T.stopAboveMs && i.steadyMs >= FACE_T.stopAfterMs;
      want = !overloaded;
      if (overloaded) coolUntil = i.now + FACE_T.coolDownMs;
    } else {
      want = i.now >= coolUntil && i.handInferenceMs <= FACE_T.startBelowMs && i.steadyMs >= FACE_T.startAfterMs;
    }
  }
  return { want, intervalMs, coolUntil };
}

/**
 * Produces the two load inputs of `facePolicy` from the stream of hand results: the inference
 * time averaged with a one-second time constant (one slow frame must not restart the clock),
 * and how long that average has stayed on the relevant side of the relevant threshold.
 *
 * Call `sample` once per hand result with the same `running` the policy state holds.
 */
export class InferenceLoad {
  private avg = NaN;
  private lastAt = NaN;
  private running: boolean | null = null;
  private side: boolean | null = null;
  private sideSince = NaN;

  sample(now: number, inferenceMs: number, running: boolean): { handInferenceMs: number; steadyMs: number } {
    if (Number.isFinite(inferenceMs) && inferenceMs >= 0) {
      if (Number.isNaN(this.avg)) {
        this.avg = inferenceMs;
      } else {
        const k = 1 - Math.exp(-Math.max(0, now - this.lastAt) / FACE_T.loadTauMs);
        this.avg += k * (inferenceMs - this.avg);
      }
      this.lastAt = now;
    }
    // Which side of the threshold the average is on; the threshold depends on the state.
    const side = running ? this.avg > FACE_T.stopAboveMs : this.avg <= FACE_T.startBelowMs;
    if (running !== this.running || side !== this.side || Number.isNaN(this.sideSince)) {
      this.running = running;
      this.side = side;
      this.sideSince = now;
    }
    return { handInferenceMs: this.avg, steadyMs: now - this.sideSince };
  }

  /** The current average, NaN before the first sample. */
  get value(): number {
    return this.avg;
  }

  reset(): void {
    this.avg = NaN;
    this.lastAt = NaN;
    this.running = null;
    this.side = null;
    this.sideSince = NaN;
  }
}
