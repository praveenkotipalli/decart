/**
 * The two-L gate, driven by real poses: synthetic hands → classifyHand → classifyPose →
 * FrameGate, the same path the app takes, at 5, 10 and 17 Hz.
 */
import { describe, expect, it } from "vitest";
import { classifyHand, type HandShape } from "../src/gestures/classifier";
import { classifyPose } from "../src/gestures/poses";
import type { HandRole } from "../src/tracking/handAssignment";
import { palmCenter, type HandObservation } from "../src/tracking/landmarks";
import { syntheticHand, type SyntheticHandPose } from "../src/tracking/syntheticHand";
import { lPose, okPose, openPose, pointPose, turnHand } from "../src/tracking/syntheticPoses";
import { DEFAULT_GATE, FrameGate, type GateHand } from "../src/toy/frameGate";
import type { HandPose } from "../src/toy/types";

const ASPECT = 16 / 9;
const RATES = [5, 10, 17];
type Src = SyntheticHandPose | HandObservation;
const obsOf = (s: Src): HandObservation => ("points" in s ? s : syntheticHand(s, ASPECT));

/** One hand's input for one result: a pose (or observation), absent (null), or coasting (fresh false). */
interface HandIn {
  src: Src | null;
  fresh?: boolean;
}

/**
 * Plays tracking results through the classifier chain exactly as the controller does: one
 * shape and pose history per hand id, the previous pose fed back for hysteresis, a coasting
 * hand keeping its last pose.
 */
class Rig {
  t = 0;
  readonly dt: number;
  readonly gate: FrameGate;
  private readonly shapes = new Map<HandRole, HandShape>();
  private readonly poses = new Map<HandRole, HandPose>();

  constructor(hz: number, gate = new FrameGate()) {
    this.dt = 1000 / hz;
    this.gate = gate;
  }

  private hand(role: HandRole, h: HandIn): GateHand {
    if (h.src === null) {
      this.shapes.delete(role);
      this.poses.delete(role);
      return { present: false, fresh: false, pose: null, palm: null };
    }
    const fresh = h.fresh ?? true;
    const obs = obsOf(h.src);
    let pose = this.poses.get(role);
    if (fresh || !pose) {
      const shape = classifyHand(obs.world, this.shapes.get(role));
      this.shapes.set(role, shape);
      pose = classifyPose(obs, shape, ASPECT, this.t, pose);
      this.poses.set(role, pose);
    }
    return { present: true, fresh, pose, palm: palmCenter(obs.points) };
  }

  /** One result at the current time; advances the clock by one interval. */
  step(a: HandIn, b: HandIn) {
    const t = this.t;
    const phase = this.gate.update(t, this.hand("A", a), this.hand("B", b), ASPECT);
    this.t += this.dt;
    return { t, phase };
  }

  /** `n` results of the same input. Returns the time of the last one. */
  hold(a: HandIn, b: HandIn, n: number) {
    let last = this.t;
    for (let i = 0; i < n; i++) last = this.step(a, b).t;
    return last;
  }

  /** Results of the same input until `ms` have passed. */
  holdMs(a: HandIn, b: HandIn, ms: number) {
    const until = this.t + ms;
    while (this.t < until) this.step(a, b);
  }
}

const L = (side: "A" | "B"): HandIn => ({ src: lPose(side) });
const PALM = (side: "A" | "B"): HandIn => ({ src: openPose(side) });
const POINT = (side: "A" | "B"): HandIn => ({ src: pointPose(side) });
const NONE: HandIn = { src: null };
/**
 * Hand B edge-on (a quarter turn about the forearm) and not an L: a pointing hand, whose
 * tucked thumb stays tucked. (The synthetic L turned the same way still reads as an L from its
 * metric landmarks, which real hands do not.)
 */
const EDGE_B: HandIn = { src: turnHand(syntheticHand(pointPose("B"), ASPECT), { turn: Math.PI / 2 }, ASPECT) };
/** Hand B's open palm shown with its back to the camera. */
const BACK_PALM_B: HandIn = { src: turnHand(syntheticHand(openPose("B"), ASPECT), { pitch: Math.PI }, ASPECT) };

/** A rig with the frame open for a while (past the minimum open time). */
function opened(hz: number) {
  const rig = new Rig(hz);
  rig.holdMs(L("A"), L("B"), 1000);
  expect(rig.gate.phase).toBe("open");
  return rig;
}

describe("opening", () => {
  it("opens at the second consecutive two-L result at 5 / 10 / 17 Hz", () => {
    for (const hz of RATES) {
      const rig = new Rig(hz);
      const first = rig.step(L("A"), L("B"));
      expect(first.phase, `${hz} Hz`).toBe("arming");
      const second = rig.step(L("A"), L("B"));
      expect(second.phase, `${hz} Hz`).toBe("open");
      expect(rig.gate.openedAt).toBe(second.t);
      expect(rig.gate.lastCloseReason).toBeNull();
    }
  });

  it("a bad result while arming starts over", () => {
    const rig = new Rig(10);
    rig.step(L("A"), L("B"));
    expect(rig.step(L("A"), POINT("B")).phase).toBe("idle");
    expect(rig.step(L("A"), L("B")).phase).toBe("arming");
    expect(rig.step(L("A"), L("B")).phase).toBe("open");
  });

  it("never opens for two open palms, two pointing hands or one L", () => {
    for (const [a, b] of [
      [PALM("A"), PALM("B")],
      [POINT("A"), POINT("B")],
      [L("A"), NONE],
      [L("A"), PALM("B")],
      [L("A"), POINT("B")],
    ]) {
      const rig = new Rig(10);
      rig.holdMs(a, b, 2000);
      expect(rig.gate.phase).toBe("idle");
    }
  });

  it("hands closer than 0.12 frame heights do not arm", () => {
    const rig = new Rig(10);
    // Palm centres 0.05 stage units apart = 0.089 frame heights at 16:9.
    rig.holdMs({ src: lPose("A", { x: 0.475 }) }, { src: lPose("B", { x: 0.525 }) }, 1000);
    expect(rig.gate.phase).toBe("idle");
    // 0.08 stage units = 0.142 frame heights (the measured palm centres sit a little closer): enough.
    const ok = new Rig(10);
    ok.holdMs({ src: lPose("A", { x: 0.46 }) }, { src: lPose("B", { x: 0.54 }) }, 1000);
    expect(ok.gate.phase).toBe("open");
  });

  it("a coasting or untrusted result is not a good one", () => {
    const rig = new Rig(10);
    rig.step(L("A"), L("B"));
    expect(rig.step(L("A"), { src: lPose("B"), fresh: false }).phase).toBe("idle");
  });
});

describe("staying open", () => {
  it("tolerates one bad result", () => {
    for (const hz of RATES) {
      const rig = opened(hz);
      expect(rig.step(L("A"), POINT("B")).phase, `${hz} Hz`).toBe("open");
      expect(rig.step(L("A"), L("B")).phase, `${hz} Hz`).toBe("open");
      rig.holdMs(L("A"), L("B"), 1000);
      expect(rig.gate.phase).toBe("open");
    }
  });

  it("tolerates a dropout while the assigner still tracks the hand", () => {
    const rig = opened(10);
    rig.holdMs(L("A"), { src: lPose("B"), fresh: false }, 440);
    expect(rig.gate.phase).toBe("open");
  });

  it("closes 350 ms after an L is dropped (reason pose)", () => {
    for (const hz of RATES) {
      const rig = opened(hz);
      const t0 = rig.t;
      let closedAt = -1;
      while (rig.t < t0 + 1000) {
        const { t, phase } = rig.step(L("A"), POINT("B"));
        if (phase !== "open") {
          closedAt = t;
          break;
        }
      }
      expect(closedAt, `${hz} Hz`).toBeGreaterThanOrEqual(t0 + DEFAULT_GATE.offMs);
      expect(closedAt, `${hz} Hz`).toBeLessThan(t0 + DEFAULT_GATE.offMs + rig.dt);
      expect(rig.gate.lastCloseReason).toBe("pose");
      expect(rig.gate.closedAt).toBe(closedAt);
    }
  });

  it("an edge-on hand holds the frame up to 900 ms, then lets go", () => {
    for (const hz of RATES) {
      const rig = opened(hz);
      const t0 = rig.t;
      rig.holdMs(L("A"), EDGE_B, 850);
      expect(rig.gate.phase, `${hz} Hz: still edge-on`).toBe("open");
      let closedAt = -1;
      while (rig.t < t0 + 1500) {
        const { t, phase } = rig.step(L("A"), EDGE_B);
        if (phase !== "open") {
          closedAt = t;
          break;
        }
      }
      expect(closedAt, `${hz} Hz`).toBeGreaterThanOrEqual(t0 + DEFAULT_GATE.edgeOnMs);
      expect(closedAt, `${hz} Hz`).toBeLessThan(t0 + DEFAULT_GATE.edgeOnMs + rig.dt);
      expect(rig.gate.lastCloseReason).toBe("pose");
    }
  });

  it("an edge-on hand that comes back as an L keeps the frame", () => {
    const rig = opened(5);
    rig.holdMs(L("A"), EDGE_B, 600);
    rig.holdMs(L("A"), L("B"), 1000);
    expect(rig.gate.phase).toBe("open");
    expect(rig.gate.lastCloseReason).toBeNull();
  });
});

describe("closing", () => {
  it("an open palm closes in 2 results (reason release)", () => {
    for (const hz of RATES) {
      const rig = opened(hz);
      expect(rig.step(L("A"), PALM("B")).phase, `${hz} Hz`).toBe("open");
      expect(rig.step(L("A"), PALM("B")).phase, `${hz} Hz`).toBe("idle");
      expect(rig.gate.lastCloseReason).toBe("release");
    }
  });

  it("an OK sign is a release too", () => {
    const rig = opened(10);
    rig.step(L("A"), { src: okPose("B") });
    expect(rig.step(L("A"), { src: okPose("B") }).phase).toBe("idle");
    expect(rig.gate.lastCloseReason).toBe("release");
  });

  it("a single palm result does not release", () => {
    const rig = opened(10);
    rig.step(L("A"), PALM("B"));
    rig.holdMs(L("A"), L("B"), 1000);
    expect(rig.gate.phase).toBe("open");
  });

  it("a palm seen from the back is not a deliberate release: the no-L rule closes the frame instead", () => {
    const rig = opened(10);
    const t0 = rig.t;
    rig.step(L("A"), BACK_PALM_B);
    expect(rig.step(L("A"), BACK_PALM_B).phase).toBe("open");
    rig.holdMs(L("A"), BACK_PALM_B, 500);
    expect(rig.gate.phase).toBe("idle");
    expect(rig.gate.lastCloseReason).toBe("pose");
    expect(rig.gate.closedAt).toBeGreaterThanOrEqual(t0 + DEFAULT_GATE.offMs);
  });

  it("a lost track closes (reason lost)", () => {
    for (const hz of RATES) {
      const rig = opened(hz);
      expect(rig.step(L("A"), NONE).phase, `${hz} Hz`).toBe("idle");
      expect(rig.gate.lastCloseReason).toBe("lost");
    }
  });

  it("a stall closes through tick()", () => {
    const rig = opened(10);
    const last = rig.t - rig.dt;
    expect(rig.gate.tick(last + 600)).toBe("open");
    expect(rig.gate.tick(last + DEFAULT_GATE.stallMs - 1)).toBe("open");
    expect(rig.gate.tick(last + DEFAULT_GATE.stallMs)).toBe("idle");
    expect(rig.gate.lastCloseReason).toBe("stall");
    expect(rig.gate.closedAt).toBe(last + DEFAULT_GATE.stallMs);
  });

  it("tick() is harmless while results keep coming", () => {
    const rig = opened(10);
    for (let i = 0; i < 20; i++) {
      rig.step(L("A"), L("B"));
      expect(rig.gate.tick(rig.t + 10)).toBe("open");
    }
  });
});

describe("floors and warm re-entry", () => {
  it("does not close before 250 ms open, even for a release", () => {
    const rig = new Rig(17);
    rig.step(L("A"), L("B"));
    const openedAt = rig.step(L("A"), L("B")).t;
    expect(rig.gate.phase).toBe("open");
    let closedAt = -1;
    while (rig.t < openedAt + 1000) {
      const { t, phase } = rig.step(L("A"), PALM("B"));
      if (phase !== "open") {
        closedAt = t;
        break;
      }
    }
    expect(closedAt).toBeGreaterThanOrEqual(openedAt + DEFAULT_GATE.minOpenMs);
    expect(closedAt).toBeLessThan(openedAt + DEFAULT_GATE.minOpenMs + rig.dt);
    expect(rig.gate.lastCloseReason).toBe("release");
  });

  it("does not re-open before 150 ms closed", () => {
    const rig = opened(17);
    rig.holdMs(L("A"), POINT("B"), 400);
    expect(rig.gate.phase).toBe("idle");
    const closedAt = rig.gate.closedAt;
    let reopenedAt = -1;
    while (rig.t < closedAt + 1000) {
      const { t, phase } = rig.step(L("A"), L("B"));
      if (phase === "open") {
        reopenedAt = t;
        break;
      }
    }
    expect(reopenedAt).toBeGreaterThanOrEqual(closedAt + DEFAULT_GATE.minClosedMs);
    expect(reopenedAt).toBeLessThan(closedAt + DEFAULT_GATE.minClosedMs + rig.dt);
  });

  it("re-opens on one good result within 1500 ms of a close that was not a release", () => {
    for (const hz of RATES) {
      const rig = opened(hz);
      rig.holdMs(L("A"), POINT("B"), 700);
      expect(rig.gate.phase, `${hz} Hz`).toBe("idle");
      expect(rig.gate.lastCloseReason).toBe("pose");
      rig.holdMs(NONE, NONE, 200); // past the closed floor, well inside the warm window
      expect(rig.step(L("A"), L("B")).phase, `${hz} Hz`).toBe("open");
    }
  });

  it("needs two results again after a release, or once the warm window has passed", () => {
    const released = opened(10);
    released.hold(L("A"), PALM("B"), 2);
    expect(released.gate.lastCloseReason).toBe("release");
    released.holdMs(NONE, NONE, 200);
    expect(released.step(L("A"), L("B")).phase).toBe("arming");
    expect(released.step(L("A"), L("B")).phase).toBe("open");

    const late = opened(10);
    late.holdMs(L("A"), POINT("B"), 700);
    expect(late.gate.lastCloseReason).toBe("pose");
    late.holdMs(NONE, NONE, DEFAULT_GATE.warmMs + 100);
    expect(late.step(L("A"), L("B")).phase).toBe("arming");
    expect(late.step(L("A"), L("B")).phase).toBe("open");
  });

  it("a lost hand that comes back brings the frame back in one result", () => {
    const rig = opened(5);
    rig.step(L("A"), NONE);
    expect(rig.gate.lastCloseReason).toBe("lost");
    rig.step(L("A"), NONE);
    expect(rig.step(L("A"), L("B")).phase).toBe("open");
  });
});

describe("reset and options", () => {
  it("reset() forgets everything, including the warm window", () => {
    const rig = opened(10);
    rig.holdMs(L("A"), POINT("B"), 400);
    rig.gate.reset();
    expect(rig.gate.phase).toBe("idle");
    expect(rig.gate.lastCloseReason).toBeNull();
    expect(rig.gate.openedAt).toBe(-Infinity);
    expect(rig.gate.closedAt).toBe(-Infinity);
    expect(rig.step(L("A"), L("B")).phase).toBe("arming");
    expect(rig.step(L("A"), L("B")).phase).toBe("open");
  });

  it("takes partial options over the defaults", () => {
    const gate = new FrameGate({ onResults: 3 });
    expect(gate.options.onResults).toBe(3);
    expect(gate.options.offMs).toBe(DEFAULT_GATE.offMs);
    const rig = new Rig(10, gate);
    rig.step(L("A"), L("B"));
    expect(rig.step(L("A"), L("B")).phase).toBe("arming");
    expect(rig.step(L("A"), L("B")).phase).toBe("open");
  });
});
