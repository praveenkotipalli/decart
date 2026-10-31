import { describe, expect, it } from "vitest";
import { classifyHand, type HandShape } from "../src/gestures/classifier";
import { GestureMachine, type GestureBindings } from "../src/gestures/GestureMachine";
import { RELAXED_POSE, framePose, syntheticHand, type SyntheticHandPose } from "../src/tracking/syntheticHand";

const shape = (p: Partial<SyntheticHandPose>, prev?: HandShape) =>
  classifyHand(syntheticHand({ ...RELAXED_POSE, ...p }).world, prev);

describe("classifyHand", () => {
  it("reads a spread open palm", () => {
    const s = shape({ spread: 1.6 });
    expect(s.extended).toEqual([true, true, true, true, true]);
    expect(s.openPalm).toBe(true);
    expect(s.fist).toBe(false);
    expect(s.pinchIndex).toBe(false);
  });

  it("does not call fingers held together an open palm", () => {
    expect(shape({ spread: 0.2 }).openPalm).toBe(false);
  });

  it("reads a fist", () => {
    const s = shape({ curls: [1, 1, 1, 1, 1] });
    expect(s.fist).toBe(true);
    expect(s.openPalm).toBe(false);
    expect(s.extended.slice(1)).toEqual([false, false, false, false]);
  });

  it("tells a thumb–index pinch from a thumb–middle pinch", () => {
    const idx = shape({ thumbTo: "index" });
    expect(idx.pinchIndex).toBe(true);
    expect(idx.pinchMiddle).toBe(false);
    const mid = shape({ thumbTo: "middle" });
    expect(mid.pinchMiddle).toBe(true);
    expect(mid.pinchIndex).toBe(false);
  });

  it("does not see a pinch in the portal frame pose", () => {
    const s = classifyHand(syntheticHand(framePose("B")).world);
    expect(s.pinchIndex).toBe(false);
    expect(s.pinchMiddle).toBe(false);
    expect(s.fist).toBe(false);
  });

  it("is invariant to distance, rotation and mirroring", () => {
    const base = shape({ curls: [1, 1, 1, 1, 1] });
    const moved = shape({ curls: [1, 1, 1, 1, 1], size: 0.05, rotation: 2.4, chirality: -1 });
    expect(moved.fist).toBe(base.fist);
    expect(moved.pinchIndexRatio).toBeCloseTo(base.pinchIndexRatio, 6);
  });

  it("applies hysteresis: a half-curled finger keeps its previous state", () => {
    const straight = shape({ curls: [0, 0, 0, 0, 0] });
    const curled = shape({ curls: [0, 1, 1, 1, 1] });
    // Straightness ≈ 0.78: between the exit (0.76) and enter (0.86) thresholds.
    const half = { curls: [0, 0.55, 0.55, 0.55, 0.55] as SyntheticHandPose["curls"] };
    expect(shape(half, straight).extended[1]).toBe(true);
    expect(shape(half, curled).extended[1]).toBe(false);
  });
});

describe("GestureMachine", () => {
  const bindings: GestureBindings = { lock: "pinch-middle", reset: "open-palm-solo", lockHoldMs: 300, resetHoldMs: 1000 };
  const pinch = classifyHand(syntheticHand({ ...RELAXED_POSE, thumbTo: "middle" }).world);
  const open = classifyHand(syntheticHand({ ...RELAXED_POSE, spread: 1.6 }).world);
  const frame = classifyHand(syntheticHand(framePose("A")).world);
  const at = { x: 0.5, y: 0.5 };

  it("fires lock once after the hold time, and only once while held", () => {
    const m = new GestureMachine();
    const fired: number[] = [];
    for (let t = 0; t <= 1500; t += 33) {
      const { events } = m.update(t, [{ id: 1, shape: pinch, anchor: at }], bindings);
      events.forEach((e) => fired.push(t));
      if (events.length) expect(events[0]).toMatchObject({ action: "lock", startedAt: 0 });
    }
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeGreaterThanOrEqual(300);
    expect(fired[0]).toBeLessThan(340);
  });

  it("re-arms after release (pinch again to unlock)", () => {
    const m = new GestureMachine();
    let count = 0;
    const run = (from: number, to: number, s = pinch) => {
      for (let t = from; t <= to; t += 33) count += m.update(t, [{ id: 1, shape: s, anchor: at }], bindings).events.length;
    };
    run(0, 400);
    run(433, 900, frame); // release
    run(933, 1400);
    expect(count).toBe(2);
  });

  it("reports hold progress before firing", () => {
    const m = new GestureMachine();
    m.update(0, [{ id: 1, shape: pinch, anchor: at }], bindings);
    const { progress } = m.update(150, [{ id: 1, shape: pinch, anchor: at }], bindings);
    expect(progress[0].action).toBe("lock");
    expect(progress[0].progress).toBeCloseTo(0.5, 2);
  });

  it("open-palm-solo only resets when a single hand is visible", () => {
    const m = new GestureMachine();
    let resets = 0;
    for (let t = 0; t <= 1500; t += 33) {
      const two = [
        { id: 1, shape: open, anchor: at },
        { id: 2, shape: frame, anchor: at },
      ];
      resets += m.update(t, two, bindings).events.filter((e) => e.action === "reset").length;
    }
    expect(resets).toBe(0);
    for (let t = 1533; t <= 3000; t += 33) {
      resets += m.update(t, [{ id: 1, shape: open, anchor: at }], bindings).events.filter((e) => e.action === "reset").length;
    }
    expect(resets).toBe(1);
  });

  it("ignores disabled bindings", () => {
    const m = new GestureMachine();
    let n = 0;
    for (let t = 0; t < 2000; t += 33)
      n += m.update(t, [{ id: 1, shape: pinch, anchor: at }], { ...bindings, lock: "none" }).events.length;
    expect(n).toBe(0);
  });
});
