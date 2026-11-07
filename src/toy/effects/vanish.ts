/**
 * Effect 5, "vanish": the frame shows a remembered picture of the empty room, so whoever
 * stands inside it is gone. This is the state of that remembered picture (the "plate"):
 *
 *   none ──requestCapture──► countdown ──deadline──► capturing ──10 frames──► ready
 *     ▲                                                                        │
 *     └──────────────────────── invalidate (camera restart, resize) ◄──────────┘
 *
 * Capturing asks the renderer, once per render frame through `consumeCapture`, to store the
 * camera frame: "replace" for the first, "blend" for the next nine (an average, so sensor
 * noise is not remembered). A capture also starts by itself when the face detector is
 * running, sees nobody, and no hand has been tracked for 1.5 s; never when the detector is
 * off (face === null), because then nobody can say the room is empty.
 *
 * Pure: time is an argument.
 */
import type { PlateState } from "../types";

export const VANISH = {
  /** Default countdown before a requested capture, ms: time to step out of the picture. */
  countdownMs: 3000,
  /** Camera frames averaged into the plate. */
  captureFrames: 10,
  /** Nobody seen for this long starts an automatic capture, ms. */
  autoClearMs: 1500,
} as const;

export class VanishEffect {
  private plate: PlateState = "none";
  /** The state a cancelled countdown goes back to. */
  private before: PlateState = "none";
  /** End of the running countdown, ms. */
  private deadline = 0;
  /** Frames stored so far in the running capture. */
  private frames = 0;
  /** Since when nobody (no hand, face === false) has been seen, ms; null while someone is or the detector is off. */
  private clearSince: number | null = null;

  get state(): PlateState {
    return this.plate;
  }

  /**
   * One tracking (or face) result: how many hands are tracked and whether a face is seen
   * (`null` = the detector is not running). Starts the automatic capture when the room has
   * been empty for long enough and there is no plate yet.
   */
  update(time: number, seen: { hands: number; face: boolean | null }): void {
    const empty = seen.face === false && seen.hands === 0;
    if (!empty) {
      this.clearSince = null;
      return;
    }
    if (this.clearSince === null || time < this.clearSince) this.clearSince = time;
    // Only while there is no plate: a refresh of a good plate on a missed face would store the person.
    if (this.plate === "none" && time - this.clearSince >= VANISH.autoClearMs) this.beginCapture();
  }

  /** The `c` key: count down (the user steps out), then capture. A second request restarts the countdown. */
  requestCapture(time: number, countdownMs: number = VANISH.countdownMs): void {
    if (this.plate !== "countdown") this.before = this.plate;
    if (countdownMs <= 0) {
      this.beginCapture();
      return;
    }
    this.plate = "countdown";
    this.deadline = time + countdownMs;
  }

  /** Stop a countdown (back to what was there before) or a running capture (what is stored so far is the plate). */
  cancel(): void {
    if (this.plate === "countdown") this.plate = this.before;
    else if (this.plate === "capturing") this.plate = this.frames > 0 ? "ready" : this.before;
  }

  /** The plate no longer matches the camera (restart, resize): forget it. */
  invalidate(): void {
    this.plate = "none";
    this.before = "none";
    this.frames = 0;
  }

  /**
   * Once per render frame: what the renderer should do with the current camera frame.
   * "replace" starts the plate, "blend" averages into it; after ten the plate is ready.
   */
  consumeCapture(time: number): "none" | "replace" | "blend" {
    if (this.plate === "countdown" && time >= this.deadline) this.beginCapture();
    if (this.plate !== "capturing") return "none";
    this.frames++;
    const op = this.frames === 1 ? "replace" : "blend";
    if (this.frames >= VANISH.captureFrames) this.plate = "ready";
    return op;
  }

  /** Seconds left of the countdown, 0 when none is running. */
  countdown(time: number): number {
    return this.plate === "countdown" ? Math.max(0, (this.deadline - time) / 1000) : 0;
  }

  private beginCapture(): void {
    this.plate = "capturing";
    this.frames = 0;
  }
}
