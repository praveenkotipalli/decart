import type { Vec2 } from "../geometry/vec";
import type { HandShape } from "./classifier";

export type GestureKind = "pinch-middle" | "pinch-index" | "fist" | "open-palm" | "open-palm-solo" | "none";
export type GestureAction = "lock" | "reset";

export const GESTURE_LABELS: Record<GestureKind, string> = {
  "pinch-middle": "Pinch thumb + middle finger",
  "pinch-index": "Pinch thumb + index finger",
  fist: "Make a fist",
  "open-palm": "Open palm, fingers spread",
  "open-palm-solo": "One open palm (other hand down)",
  none: "Disabled",
};

export interface GestureBindings {
  lock: GestureKind;
  reset: GestureKind;
  lockHoldMs: number;
  resetHoldMs: number;
}

export interface GestureHand {
  id: number;
  shape: HandShape;
  /** Where to draw the hold-progress ring, stage space. */
  anchor: Vec2;
}

export interface GestureEvent {
  action: GestureAction;
  /** When the gesture first became true — lets lock restore the pose from before the pinch. */
  startedAt: number;
  handId: number;
}

export interface GestureProgress {
  action: GestureAction;
  progress: number;
  anchor: Vec2;
}

const COOLDOWN_MS = 700;

export function matchesGesture(kind: GestureKind, shape: HandShape, handCount: number): boolean {
  switch (kind) {
    case "pinch-middle":
      return shape.pinchMiddle;
    case "pinch-index":
      return shape.pinchIndex;
    case "fist":
      return shape.fist;
    case "open-palm":
      return shape.openPalm;
    case "open-palm-solo":
      return shape.openPalm && handCount === 1;
    case "none":
      return false;
  }
}

/**
 * Turns per-frame hand shapes into discrete actions. A gesture must be held for
 * its hold time to fire, fires once, and must be released before it can fire
 * again — so a held pinch toggles the lock exactly once.
 */
export class GestureMachine {
  private holds = new Map<GestureAction, { since: number; handId: number; fired: boolean }>();
  private cooldownUntil = 0;

  reset() {
    this.holds.clear();
  }

  update(time: number, hands: GestureHand[], bindings: GestureBindings) {
    const events: GestureEvent[] = [];
    const progress: GestureProgress[] = [];
    const actions: [GestureAction, GestureKind, number][] = [
      ["reset", bindings.reset, bindings.resetHoldMs],
      ["lock", bindings.lock, bindings.lockHoldMs],
    ];

    for (const [action, kind, holdMs] of actions) {
      const hand = hands.find((h) => matchesGesture(kind, h.shape, hands.length));
      const hold = this.holds.get(action);
      if (!hand) {
        this.holds.delete(action);
        continue;
      }
      const current = hold && hold.handId === hand.id ? hold : { since: time, handId: hand.id, fired: false };
      this.holds.set(action, current);
      if (current.fired) continue;

      const p = holdMs <= 0 ? 1 : (time - current.since) / holdMs;
      if (p >= 1 && time >= this.cooldownUntil) {
        current.fired = true;
        this.cooldownUntil = time + COOLDOWN_MS;
        events.push({ action, startedAt: current.since, handId: hand.id });
      } else {
        progress.push({ action, progress: Math.min(p, 1), anchor: hand.anchor });
      }
    }
    return { events, progress };
  }
}
