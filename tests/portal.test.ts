import { describe, expect, it } from "vitest";
import type { Quad, Vec2 } from "../src/geometry/vec";
import type { ResolvedCorner } from "../src/portal/cornerMapping";
import { Calibrator, cutoffForNoise } from "../src/portal/Calibrator";
import { DEFAULT_HOME, PortalController } from "../src/portal/PortalController";

const RECT: Quad = [
  { x: 0.3, y: 0.3 },
  { x: 0.7, y: 0.3 },
  { x: 0.7, y: 0.7 },
  { x: 0.3, y: 0.7 },
];

const corners = (q: (Vec2 | null)[], fresh = true, ids = [1, 2, 2, 1]): (ResolvedCorner | null)[] =>
  q.map((p, i) => (p ? { point: p, handId: ids[i], fresh } : null));

/** Drive the controller with the same quad for `ms`. */
function hold(pc: PortalController, q: (Vec2 | null)[], from: number, ms: number, fresh = true) {
  let t = from;
  for (; t <= from + ms; t += 33) pc.update(t, corners(q, fresh));
  return t;
}

describe("PortalController", () => {
  it("starts hidden and opens when four corners are tracked", () => {
    const pc = new PortalController();
    expect(pc.snapshot(0).corners).toBeNull();
    const t = hold(pc, RECT, 0, 300);
    const s = pc.snapshot(t);
    expect(s.phase).toBe("tracking");
    expect(s.corners![0].x).toBeCloseTo(0.3, 3);
    let v = 0;
    for (let k = t; k < t + 800; k += 16) v = pc.snapshot(k).visibility;
    expect(v).toBe(1);
  });

  it("follows each corner independently (twisting one corner moves only that corner)", () => {
    const pc = new PortalController();
    let t = hold(pc, RECT, 0, 300);
    const twisted = [...RECT] as Quad;
    twisted[2] = { x: 0.8, y: 0.62 };
    t = hold(pc, twisted, t, 600);
    const s = pc.snapshot(t);
    expect(s.corners![2].x).toBeCloseTo(0.8, 2);
    expect(s.corners![0].x).toBeCloseTo(0.3, 3);
  });

  it("holds the last valid portal when the fingers cross (policy: hold)", () => {
    const pc = new PortalController({ invalidPolicy: "hold" });
    let t = hold(pc, RECT, 0, 300);
    const crossed: Quad = [RECT[1], RECT[0], RECT[2], RECT[3]];
    t = hold(pc, crossed, t, 600);
    const s = pc.snapshot(t);
    expect(s.validity).toBe("crossed");
    expect(s.corners![0].x).toBeCloseTo(0.3, 2); // still the last valid geometry
    expect(s.fingers[0]!.x).toBeCloseTo(0.7, 2); // markers follow the actual finger
  });

  it("untangles a crossed portal when asked to", () => {
    const pc = new PortalController({ invalidPolicy: "untangle" });
    hold(pc, [RECT[0], RECT[2], RECT[1], RECT[3]], 0, 600);
    expect(pc.snapshot(600).validity).toBe("crossed");
    expect(pc.snapshot(600).corners).not.toBeNull();
  });

  it("coasts through a brief dropout, then closes after the linger time", () => {
    const pc = new PortalController({ lingerMs: 1000 });
    let t = hold(pc, RECT, 0, 300);
    t = hold(pc, [RECT[0], null, null, RECT[3]], t, 500);
    expect(pc.snapshot(t).phase).toBe("tracking");
    t = hold(pc, [RECT[0], null, null, RECT[3]], t, 800);
    expect(pc.snapshot(t).phase).toBe("searching");
  });

  it("lock freezes the pose from before the lock gesture began", () => {
    const pc = new PortalController();
    let t = hold(pc, RECT, 0, 600);
    const gestureStart = t;
    // The pinch drags the thumb corner (P4) towards the middle finger.
    const pinching = [...RECT] as Quad;
    pinching[3] = { x: 0.45, y: 0.5 };
    t = hold(pc, pinching, t, 330);
    pc.update(t, corners(pinching), [{ action: "lock", startedAt: gestureStart, handId: 1 }]);
    const s = pc.snapshot(t);
    expect(s.locked).toBe(true);
    expect(s.corners![3].x).toBeCloseTo(0.3, 2);
    // Moving the hands no longer moves the portal.
    t = hold(pc, [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }], t, 400);
    expect(pc.snapshot(t).corners![0].x).toBeCloseTo(0.3, 2);
  });

  it("unlock flies smoothly back to the hands", () => {
    const pc = new PortalController();
    let t = hold(pc, RECT, 0, 300);
    pc.lock(t);
    const moved = RECT.map((p) => ({ x: p.x + 0.1, y: p.y })) as Quad;
    t = hold(pc, moved, t, 300);
    pc.unlock();
    const mid = pc.snapshot(t + 100).corners![0].x;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.4);
    t = hold(pc, moved, t, 600);
    expect(pc.snapshot(t).corners![0].x).toBeCloseTo(0.4, 2);
  });

  it("reset returns to home and stays there until hands return", () => {
    const pc = new PortalController();
    let t = hold(pc, RECT, 0, 300);
    pc.update(t, corners([null, null, null, null]), [{ action: "reset", startedAt: t, handId: 1 }]);
    t = hold(pc, [null, null, null, null], t, 3000);
    const s = pc.snapshot(t);
    expect(s.phase).toBe("home");
    expect(s.corners![0].x).toBeCloseTo(DEFAULT_HOME[0].x, 5);
  });

  it("scale expands the portal around its centre", () => {
    const pc = new PortalController({ scale: 1.5 });
    const t = hold(pc, RECT, 0, 300);
    expect(pc.snapshot(t).corners![0].x).toBeCloseTo(0.2, 2);
  });

  it("predicts between tracking samples so motion is smooth at render rate, within a bounded lead", () => {
    const pc = new PortalController();
    let t = 0;
    // Move the whole portal right at 0.3 stage units/s, sampled at 15 Hz.
    for (; t <= 1500; t += 66) pc.update(t, corners(RECT.map((p) => ({ x: p.x + 0.0003 * t, y: p.y }))));
    const last = t - 66;
    const atSample = pc.snapshot(last).corners![0].x;
    const between = pc.snapshot(last + 33).corners![0].x;
    const late = pc.snapshot(last + 500).corners![0].x;
    expect(between).toBeGreaterThan(atSample);
    // Lead is capped at 60 ms × gain: never more than 0.3 × 0.06 = 0.018 ahead.
    expect(late - atSample).toBeLessThanOrEqual(0.0181);
  });

  it("does not predict while locked", () => {
    const pc = new PortalController();
    let t = 0;
    for (; t <= 600; t += 66) pc.update(t, corners(RECT.map((p) => ({ x: p.x + 0.0003 * t, y: p.y }))));
    pc.lock(t);
    const a = pc.snapshot(t).corners![0].x;
    const b = pc.snapshot(t + 50).corners![0].x;
    expect(b).toBeCloseTo(a, 9);
  });

  it("snaps (no smoothing lag) when a different hand takes over a corner", () => {
    const pc = new PortalController();
    let t = hold(pc, RECT, 0, 300);
    const other = [{ x: 0.1, y: 0.1 }, RECT[1], RECT[2], RECT[3]];
    pc.update(t, other.map((p, i) => ({ point: p, handId: i === 0 ? 9 : [1, 2, 2, 1][i], fresh: true })));
    t += 33;
    expect(pc.snapshot(t).fingers[0]).toEqual({ x: 0.1, y: 0.1 });
  });
});

describe("Calibrator", () => {
  it("learns the home pose and jitter from a steady hold", () => {
    const c = new Calibrator();
    c.start(0);
    for (let t = 0; t <= 2500 && c.state !== "done"; t += 33) {
      const j = Math.sin(t) * 0.001;
      c.update(t, RECT.map((p) => ({ x: p.x + j, y: p.y - j })), "two-hand");
    }
    expect(c.state).toBe("done");
    expect(c.result!.home[0].x).toBeCloseTo(0.3, 2);
    expect(c.result!.swapA).toBe(false);
    expect(c.result!.noise).toBeLessThan(0.002);
  });

  it("detects a pose where a hand's top and bottom fingers are the other way round", () => {
    const c = new Calibrator();
    c.start(0);
    const flippedA = [RECT[3], RECT[1], RECT[2], RECT[0]];
    for (let t = 0; t <= 2500 && c.state !== "done"; t += 33) c.update(t, flippedA, "two-hand");
    expect(c.state).toBe("done");
    expect(c.result!.swapA).toBe(true);
    expect(c.result!.swapB).toBe(false);
  });

  it("restarts the hold when the hands move", () => {
    const c = new Calibrator();
    c.start(0);
    for (let t = 0; t <= 800; t += 33) c.update(t, RECT, "two-hand");
    expect(c.state).toBe("holding");
    c.update(833, RECT.map((p) => ({ x: p.x + 0.2, y: p.y })), "two-hand");
    expect(c.state).toBe("waiting");
    expect(c.progress).toBe(0);
  });

  it("maps jitter to a smoothing cutoff", () => {
    expect(cutoffForNoise(0.001)).toBe(1.6);
    expect(cutoffForNoise(0.01)).toBe(0.5);
    const mid = cutoffForNoise(0.0035);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1.6);
  });
});
