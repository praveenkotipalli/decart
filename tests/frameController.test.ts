/**
 * The frame controller: corners bound to fingertips in the fixed order, filtered and glided;
 * crossed quads passed through; lock; visibility and bracket-arm animation.
 */
import { describe, expect, it } from "vitest";
import type { Quad, Vec2 } from "../src/geometry/vec";
import { LM, type HandObservation } from "../src/tracking/landmarks";
import { syntheticHand } from "../src/tracking/syntheticHand";
import { lPose } from "../src/tracking/syntheticPoses";
import { FLIP_T } from "../src/toy/FlipDetector";
import { DEFAULT_FRAME, FrameController, quadTwist, type CornerSample } from "../src/toy/FrameController";

const ASPECT = 16 / 9;
const ARM_OPEN = 1 / 6;

const tip = (obs: HandObservation, lm: number): Vec2 => ({ x: obs.points[lm].x, y: obs.points[lm].y });
const A = syntheticHand(lPose("A"), ASPECT);
const B = syntheticHand(lPose("B"), ASPECT);

interface CornerOpts {
  idA?: number;
  idB?: number;
  freshA?: boolean;
  freshB?: boolean;
  acceptA?: boolean;
  acceptB?: boolean;
}

/** Corners in the fixed order [A index, B index, B thumb, A thumb]; null where a hand is missing. */
function cornersOf(a: HandObservation | null, b: HandObservation | null, o: CornerOpts = {}): (CornerSample | null)[] {
  const c = (obs: HandObservation | null, lm: number, id: number, fresh: boolean, accept: boolean): CornerSample | null =>
    obs ? { point: tip(obs, lm), handId: id, fresh, accept } : null;
  const idA = o.idA ?? 1;
  const idB = o.idB ?? 2;
  return [
    c(a, LM.INDEX_TIP, idA, o.freshA ?? true, o.acceptA ?? true),
    c(b, LM.INDEX_TIP, idB, o.freshB ?? true, o.acceptB ?? true),
    c(b, LM.THUMB_TIP, idB, o.freshB ?? true, o.acceptB ?? true),
    c(a, LM.THUMB_TIP, idA, o.freshA ?? true, o.acceptA ?? true),
  ];
}

/** Four points as corner samples of one hand id each (A corners id 1, B corners id 2). */
function cornersAt(q: Quad, accept = true): CornerSample[] {
  const ids = [1, 2, 2, 1];
  return q.map((p, i) => ({ point: { ...p }, handId: ids[i], fresh: true, accept }));
}

const expectedQuad = (a: HandObservation, b: HandObservation): Quad => [
  tip(a, LM.INDEX_TIP),
  tip(b, LM.INDEX_TIP),
  tip(b, LM.THUMB_TIP),
  tip(a, LM.THUMB_TIP),
];

const dist = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
function expectQuadNear(got: Quad | null, want: Quad, eps = 1e-6) {
  expect(got).not.toBeNull();
  for (let i = 0; i < 4; i++) expect(dist(got![i], want[i]), `corner ${i}`).toBeLessThanOrEqual(eps);
}

/**
 * Feeds the same corners for `ms` at `hz` with render frames at 60 fps in between, from
 * time `t0`. Returns the time of the last render frame.
 */
function settle(fc: FrameController, corners: (CornerSample | null)[], ms: number, o: { hz?: number; open?: boolean; t0?: number } = {}) {
  const hz = o.hz ?? 10;
  const open = o.open ?? true;
  const t0 = o.t0 ?? 0;
  const interval = 1000 / hz;
  let next = t0;
  let t = t0;
  for (t = t0; t <= t0 + ms; t += 1000 / 60) {
    while (next <= t) {
      fc.update(next, corners, open, ASPECT);
      next += interval;
    }
    fc.snapshot(t);
  }
  return t - 1000 / 60;
}

describe("corners", () => {
  it("equal the fingertips at rest, in the fixed order [A index, B index, B thumb, A thumb]", () => {
    const fc = new FrameController();
    fc.update(0, cornersOf(A, B), true, ASPECT);
    expectQuadNear(fc.snapshot(0).quad, expectedQuad(A, B));
    const t = settle(fc, cornersOf(A, B), 1000);
    expectQuadNear(fc.snapshot(t).quad, expectedQuad(A, B), 1e-9);
  });

  it("returns a crossed quad unchanged, with crossed = true", () => {
    const rolled = syntheticHand(lPose("B", { rotation: Math.PI }), ASPECT);
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, rolled), 500);
    const s = fc.snapshot(t);
    expectQuadNear(s.quad, expectedQuad(A, rolled), 1e-9);
    expect(s.crossed).toBe(true);
    expect(s.visibility).toBe(1);
  });

  it("passes a concave quad through as well", () => {
    const concave: Quad = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.3 },
      { x: 0.45, y: 0.45 },
      { x: 0.3, y: 0.7 },
    ];
    const fc = new FrameController();
    const t = settle(fc, cornersAt(concave), 300);
    const s = fc.snapshot(t);
    expectQuadNear(s.quad, concave, 1e-9);
    expect(s.crossed).toBe(false);
  });

  it("a rejected sample (accept false) does not move its corner", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    const moved = syntheticHand(lPose("B", { x: 0.9, y: 0.2 }), ASPECT);
    const t2 = settle(fc, cornersOf(A, moved, { acceptB: false }), 500, { t0: t + 100 });
    expectQuadNear(fc.snapshot(t2).quad, expectedQuad(A, B), 1e-9);
    // Accepted again: it moves.
    const t3 = settle(fc, cornersOf(A, moved), 1500, { t0: t2 + 100 });
    expectQuadNear(fc.snapshot(t3).quad, expectedQuad(A, moved), 1e-3);
  });

  it("clamps a tip outside the picture to the 0.02 margin", () => {
    const fc = new FrameController();
    const q: Quad = [
      { x: -0.3, y: 0.2 },
      { x: 1.3, y: -0.1 },
      { x: 1.1, y: 1.4 },
      { x: 0.2, y: 0.8 },
    ];
    fc.update(0, cornersAt(q), true, ASPECT);
    const got = fc.snapshot(0).quad!;
    expect(got[0]).toEqual({ x: -0.02, y: 0.2 });
    expect(got[1]).toEqual({ x: 1.02, y: -0.02 });
    expect(got[2]).toEqual({ x: 1.02, y: 1.02 });
    expect(got[3]).toEqual({ x: 0.2, y: 0.8 });
  });

  it("a different hand id on a corner snaps instead of gliding", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    const moved = syntheticHand(lPose("B", { x: 0.85 }), ASPECT);
    fc.update(t + 100, cornersOf(A, moved, { idB: 7 }), true, ASPECT);
    expectQuadNear(fc.snapshot(t + 100).quad, expectedQuad(A, moved), 1e-9);
  });

  it("the same hand id glides: render frames between results move smoothly without overshoot", () => {
    const fc = new FrameController();
    const hz = 10;
    const speed = 0.2 / 1000; // stage units per ms, in x: hand B crosses from 0.3 to 0.7
    const frames: { t: number; x: number }[] = [];
    let next = 0;
    for (let t = 0; t <= 2000; t += 1000 / 60) {
      while (next <= t) {
        const b = syntheticHand(lPose("B", { x: 0.3 + speed * next }), ASPECT);
        fc.update(next, cornersOf(A, b), true, ASPECT);
        next += 1000 / hz;
      }
      frames.push({ t, x: fc.snapshot(t).quad![1].x });
    }
    const steady = frames.filter((f) => f.t > 600);
    const steps = steady.slice(1).map((f, i) => f.x - steady[i].x);
    const ideal = (speed * 1000) / 60;
    for (const s of steps) {
      expect(s).toBeGreaterThan(0); // never backwards
      expect(s).toBeLessThan(3 * ideal); // never a jump of a whole result
    }
    // Lag behind the fingertip stays small (a fraction of one tracking interval).
    const last = steady[steady.length - 1];
    const truth = tip(syntheticHand(lPose("B", { x: 0.3 + speed * last.t }), ASPECT), LM.INDEX_TIP).x;
    expect(Math.abs(truth - last.x)).toBeLessThan(speed * 1000 * 0.15);
  });

  it("holds a coasting corner and reports coasting", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    const moved = syntheticHand(lPose("B", { x: 0.9 }), ASPECT);
    fc.update(t + 100, cornersOf(A, moved, { freshB: false }), true, ASPECT);
    const s = fc.snapshot(t + 100);
    expect(s.coasting).toBe(true);
    expectQuadNear(s.quad, expectedQuad(A, B), 1e-9);
    fc.update(t + 200, cornersOf(A, B), true, ASPECT);
    expect(fc.snapshot(t + 200).coasting).toBe(false);
  });

  it("filters run while the gate is closed, so the quad is settled when it opens", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500, { open: false });
    expect(fc.snapshot(t).visibility).toBe(0);
    fc.update(t + 50, cornersOf(A, B), true, ASPECT);
    expectQuadNear(fc.snapshot(t + 50).quad, expectedQuad(A, B), 1e-9);
  });
});

describe("twist", () => {
  const bowTie: Quad = [
    { x: 0.3, y: 0.3 },
    { x: 0.7, y: 0.7 },
    { x: 0.7, y: 0.3 },
    { x: 0.3, y: 0.7 },
  ];

  it("a central crossing with long chords is a valid twist", () => {
    expect(quadTwist(bowTie, ASPECT)).toEqual({ crossed: true, valid: true });
    const fc = new FrameController();
    fc.update(0, cornersAt(bowTie), true, ASPECT);
    const s = fc.snapshot(0);
    expect(s.crossed).toBe(true);
    expect(s.twistValid).toBe(true);
  });

  it("a crossing near the end of an edge is crossed but not a valid twist", () => {
    const q: Quad = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.3 },
      { x: 0.32, y: 0.2 },
      { x: 0.3, y: 0.7 },
    ];
    const tw = quadTwist(q, ASPECT);
    expect(tw.crossed).toBe(true);
    expect(tw.valid).toBe(false);
  });

  it("short side chords do not count", () => {
    const chord = (FLIP_T.minChord * 0.5) / ASPECT; // in stage x, half the minimum in frame heights
    const q: Quad = [
      { x: 0.3, y: 0.5 - 0.001 },
      { x: 0.7, y: 0.5 + 0.001 },
      { x: 0.7 - chord, y: 0.5 - 0.001 },
      { x: 0.3 + chord, y: 0.5 + 0.001 },
    ];
    const tw = quadTwist(q, ASPECT);
    expect(tw.crossed).toBe(true);
    expect(tw.valid).toBe(false);
  });

  it("an uncrossed quad is neither", () => {
    expect(quadTwist(expectedQuad(A, B), ASPECT)).toEqual({ crossed: false, valid: false });
  });

  it("is judged on the live fingertips even while locked", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 300);
    expect(fc.toggleLock()).toBe(true);
    fc.update(t + 100, cornersAt(bowTie), true, ASPECT);
    const s = fc.snapshot(t + 100);
    expect(s.twistValid).toBe(true);
    expect(s.crossed).toBe(false); // the frozen quad on screen is not crossed
  });
});

describe("visibility", () => {
  it("rises monotonically to 1 when the gate opens and falls monotonically to 0 when it closes", () => {
    const fc = new FrameController();
    const corners = cornersOf(A, B);
    fc.update(0, corners, true, ASPECT);
    const up: number[] = [];
    for (let t = 0; t <= 400; t += 16) {
      if (t % 100 === 0) fc.update(t, corners, true, ASPECT);
      up.push(fc.snapshot(t).visibility);
    }
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1]);
    expect(up[Math.ceil(DEFAULT_FRAME.fadeInMs / 16)]).toBeGreaterThan(0.9);
    expect(up[up.length - 1]).toBe(1);

    fc.update(400, corners, false, ASPECT);
    const down: number[] = [];
    for (let t = 416; t <= 900; t += 16) {
      if (t % 100 === 0) fc.update(t, corners, false, ASPECT);
      down.push(fc.snapshot(t).visibility);
    }
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThanOrEqual(down[i - 1]);
    expect(down[down.length - 1]).toBe(0);
  });

  it("a tiny quad is not shown", () => {
    const fc = new FrameController();
    const tiny: Quad = [
      { x: 0.5, y: 0.5 },
      { x: 0.51, y: 0.5 },
      { x: 0.51, y: 0.51 },
      { x: 0.5, y: 0.51 },
    ];
    const t = settle(fc, cornersAt(tiny), 500);
    expect(fc.snapshot(t).visibility).toBe(0);
    expect(fc.snapshot(t).quad).not.toBeNull(); // the geometry is still reported
  });

  it("keeps the last quad while fading out after a hand is lost, then returns null", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    fc.update(t + 50, cornersOf(A, null), false, ASPECT);
    const fading = fc.snapshot(t + 60);
    expect(fading.visibility).toBeGreaterThan(0);
    expectQuadNear(fading.quad, expectedQuad(A, B), 1e-9);
    const gone = settle(fc, cornersOf(A, null), 800, { open: false, t0: t + 100 });
    const s = fc.snapshot(gone);
    expect(s.visibility).toBe(0);
    expect(s.quad).toBeNull();
  });

  it("reports the gate state it was given", () => {
    const fc = new FrameController();
    fc.update(0, cornersOf(A, B), false, ASPECT);
    expect(fc.snapshot(0).open).toBe(false);
    fc.update(100, cornersOf(A, B), true, ASPECT);
    expect(fc.snapshot(100).open).toBe(true);
  });
});

describe("bracket arms", () => {
  it("grow from 0 to 1/6 over 180 ms with an ease-out", () => {
    const fc = new FrameController();
    fc.update(0, cornersOf(A, B), true, ASPECT);
    expect(fc.snapshot(0).arm).toBe(0);
    const half = fc.snapshot(90).arm;
    expect(half).toBeGreaterThan(ARM_OPEN * 0.5); // ease-out: ahead of linear
    expect(half).toBeLessThan(ARM_OPEN);
    expect(fc.snapshot(180).arm).toBeCloseTo(ARM_OPEN, 9);
    expect(fc.snapshot(1000).arm).toBeCloseTo(ARM_OPEN, 9);
  });

  it("keep their length while the frame fades out and grow again on the next open", () => {
    const fc = new FrameController();
    const corners = cornersOf(A, B);
    const t = settle(fc, corners, 500);
    fc.update(t + 10, corners, false, ASPECT);
    expect(fc.snapshot(t + 30).arm).toBeCloseTo(ARM_OPEN, 9);
    const closed = settle(fc, corners, 600, { open: false, t0: t + 40 });
    expect(fc.snapshot(closed).visibility).toBe(0);
    fc.update(closed + 10, corners, true, ASPECT);
    expect(fc.snapshot(closed + 10).arm).toBe(0);
  });
});

describe("lock", () => {
  it("freezes the displayed quad, ignores the gate and draws a full outline", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    expect(fc.isLocked()).toBe(false);
    expect(fc.toggleLock()).toBe(true);
    expect(fc.isLocked()).toBe(true);
    const moved = syntheticHand(lPose("B", { x: 0.9, y: 0.3 }), ASPECT);
    const t2 = settle(fc, cornersOf(A, moved), 600, { open: false, t0: t + 100 });
    const s = fc.snapshot(t2);
    expect(s.locked).toBe(true);
    expectQuadNear(s.quad, expectedQuad(A, B), 1e-9);
    expect(s.visibility).toBe(1);
    expect(s.arm).toBeCloseTo(0.5, 9);
  });

  it("unlocking glides back to the fingertips", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    fc.toggleLock();
    const moved = syntheticHand(lPose("B", { x: 0.9, y: 0.3 }), ASPECT);
    const t2 = settle(fc, cornersOf(A, moved), 600, { t0: t + 100 });
    expect(fc.toggleLock()).toBe(false);
    expect(fc.isLocked()).toBe(false);
    const target = expectedQuad(A, moved);
    const frozen = expectedQuad(A, B);
    // The first frame after unlocking still sits (essentially) at the frozen position, a quarter
    // of a stage away from the live tips …
    expectQuadNear(fc.snapshot(t2 + 1).quad, frozen, 1e-3);
    expect(dist(frozen[1], target[1])).toBeGreaterThan(0.2);
    // … then moves towards the live tips without ever moving away from them.
    let lastGap = Infinity;
    let next = t2 + 100;
    for (let tt = t2 + 16; tt <= t2 + 1500; tt += 16) {
      while (next <= tt) {
        fc.update(next, cornersOf(A, moved), true, ASPECT);
        next += 100;
      }
      const gap = dist(fc.snapshot(tt).quad![1], target[1]);
      expect(gap).toBeLessThanOrEqual(lastGap + 1e-9);
      lastGap = gap;
    }
    expect(lastGap).toBeLessThan(1e-3);
    expect(fc.snapshot(t2 + 1500).arm).toBeCloseTo(ARM_OPEN, 6);
  });

  it("unlocking with the gate closed lets the frame fade", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    fc.toggleLock();
    const t2 = settle(fc, cornersOf(A, B), 300, { open: false, t0: t + 100 });
    fc.toggleLock();
    const t3 = settle(fc, cornersOf(A, B), 600, { open: false, t0: t2 + 100 });
    expect(fc.snapshot(t3).visibility).toBe(0);
  });

  it("cannot lock before a quad exists", () => {
    const fc = new FrameController();
    expect(fc.toggleLock()).toBe(false);
    expect(fc.isLocked()).toBe(false);
  });
});

describe("options and reset", () => {
  it("setOptions changes what is shown without moving the corners", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    fc.setOptions({ minDiag: 10 });
    const t2 = settle(fc, cornersOf(A, B), 500, { t0: t + 100 });
    expect(fc.snapshot(t2).visibility).toBe(0);
    fc.setOptions({ minDiag: DEFAULT_FRAME.minDiag, glide: { ...DEFAULT_FRAME.glide, tauMaxMs: 60 }, smoothing: { minCutoff: 2, beta: 1, dCutoff: 1 } });
    expectQuadNear(fc.snapshot(t2 + 1).quad, expectedQuad(A, B), 1e-9);
    const t3 = settle(fc, cornersOf(A, B), 500, { t0: t2 + 100 });
    expect(fc.snapshot(t3).visibility).toBe(1);
  });

  it("reset() clears everything", () => {
    const fc = new FrameController();
    const t = settle(fc, cornersOf(A, B), 500);
    fc.toggleLock();
    fc.reset();
    const s = fc.snapshot(t + 100);
    expect(s.quad).toBeNull();
    expect(s.visibility).toBe(0);
    expect(s.locked).toBe(false);
    expect(s.arm).toBe(0);
    expect(fc.isLocked()).toBe(false);
  });
});
