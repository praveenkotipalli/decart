import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/geometry/vec";
import type { Vec3 } from "../src/tracking/landmarks";
import type { HandKinematics, HandPose, HandRole, HandSample, PoseName } from "../src/toy/types";
import { StampBuffer } from "../src/toy/types";
import { DrawEffect, PEN } from "../src/toy/effects/draw";
import { FOG, FogEffect } from "../src/toy/effects/fog";
import { HoldGesture } from "../src/toy/effects/hold";
import { SPARK, SparkField, SparksEffect } from "../src/toy/effects/sparks";
import { INK, INK_A, INK_CORE, WIPE } from "../src/toy/effects/stamps";
import { VANISH, VanishEffect } from "../src/toy/effects/vanish";

// ── fixtures ────────────────────────────────────────────────────────────────────────────

const ASPECT = 16 / 9;
const FRAME = 1000 / 60;
const S2 = 0.2;

function pose(o: Partial<HandPose> = {}): HandPose {
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
    curlDeg: [175, 175, 175],
    phiDeg: 20,
    pinchRatio: 2,
    worldOk: true,
    uncertain: false,
    s2: S2,
    cPalm: 0.77,
    cL: -0.9,
    facing: 1,
    ring: null,
    at: 0,
    ...o,
  };
}
const POINT = () => pose({ name: "point", point: true, indexOut: true, curled: [true, true, true], curlDeg: [60, 55, 50] });
const L = () => pose({ name: "L", l: true, indexOut: true, thumbOut: true, phiDeg: 95, curled: [true, true, true], curlDeg: [80, 55, 40] });
const PALM = () => pose({ name: "palm", palm: true, indexOut: true, thumbOut: true, phiDeg: 46 });
const FIST = () => pose({ name: "fist", fist: true, curled: [true, true, true], curlDeg: [50, 50, 50] });
const NONE = () => pose();

/** One tracking result for one hand: every landmark at the palm except the index tip. */
function sample(id: number, role: HandRole, tip: Vec2, p: HandPose, time: number, fresh = true): HandSample {
  const palm = { x: tip.x, y: tip.y + 0.12 };
  const points: Vec3[] = Array.from({ length: 21 }, () => ({ x: palm.x, y: palm.y, z: 0 }));
  points[8] = { x: tip.x, y: tip.y, z: 0 };
  return { id, role, fresh, ageMs: 500, points, palm, pose: { ...p, at: time } };
}

/** Render-rate view of one hand: fingertips at the palm except the index tip. */
function kin(id: number, role: HandRole, tip: Vec2, o: Partial<HandKinematics> = {}): HandKinematics {
  const palm = o.palm ?? { x: tip.x, y: tip.y + 0.12 };
  const points: Vec2[] = Array.from({ length: 21 }, () => ({ ...palm }));
  points[8] = { ...tip };
  const zero = () => ({ x: 0, y: 0 });
  return { id, role, fresh: true, points, tipVel: [zero(), zero(), zero(), zero(), zero()], palm, speedPx: 0, s2: S2, ...o };
}

/** Float32 storage rounds: compare channel by channel. */
function expectRgba(actual: number[], expected: readonly number[]) {
  expect(actual).toHaveLength(4);
  for (let i = 0; i < 4; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
}

function expectDot(s: { ax: number; ay: number; bx: number; by: number }, x: number, y: number) {
  expect(s.ax).toBeCloseTo(x, 6);
  expect(s.ay).toBeCloseTo(y, 6);
  expect(s.bx).toBeCloseTo(x, 6);
  expect(s.by).toBeCloseTo(y, 6);
}

/** The stamps of a buffer as objects. */
function stamps(out: StampBuffer) {
  const list = [];
  for (let i = 0; i < out.count; i++) {
    const o = i * StampBuffer.STRIDE;
    const d = out.data;
    list.push({ ax: d[o], ay: d[o + 1], bx: d[o + 2], by: d[o + 3], r: d[o + 4], rgba: [d[o + 5], d[o + 6], d[o + 7], d[o + 8]] });
  }
  return list;
}

/** Puts hand `id`'s pen down at `tip`: two pointing results and a render frame. */
function penDown(d: DrawEffect, out: StampBuffer, id: number, tip: Vec2, t0: number): number {
  d.update(t0, [sample(id, "A", tip, POINT(), t0)], ASPECT);
  d.advance(t0 + 10, [kin(id, "A", tip)], out);
  d.update(t0 + 100, [sample(id, "A", tip, POINT(), t0 + 100)], ASPECT);
  d.advance(t0 + 110, [kin(id, "A", tip)], out);
  return t0 + 110;
}

const centroid = (f: SparkField) => {
  let x = 0;
  let y = 0;
  for (let i = 0; i < f.count; i++) {
    x += f.data[i * SPARK.stride];
    y += f.data[i * SPARK.stride + 1];
  }
  return { x: x / f.count, y: y / f.count };
};

const meanDist = (f: SparkField, c: Vec2) => {
  let s = 0;
  for (let i = 0; i < f.count; i++) s += Math.hypot((f.data[i * SPARK.stride] - c.x) * ASPECT, f.data[i * SPARK.stride + 1] - c.y);
  return s / f.count;
};

// ── hold ────────────────────────────────────────────────────────────────────────────────

describe("HoldGesture", () => {
  it("fires once when the hold is up, shows progress on the way, and re-arms on release", () => {
    const h = new HoldGesture(700);
    expect(h.update(0, true)).toEqual({ progress: 0, fired: false });
    expect(h.update(350, true).progress).toBeCloseTo(0.5);
    expect(h.update(699, true).fired).toBe(false);
    expect(h.update(700, true)).toEqual({ progress: 1, fired: true });
    // Holding on does not fire again, and the ring is gone (its wipe has happened).
    expect(h.update(1400, true)).toEqual({ progress: 0, fired: false });
    expect(h.update(1500, false)).toEqual({ progress: 0, fired: false });
    expect(h.update(1600, true).fired).toBe(false);
    expect(h.update(2300, true).fired).toBe(true);
  });
});

// ── draw ────────────────────────────────────────────────────────────────────────────────

describe("DrawEffect", () => {
  it("puts the pen down on the second pointing result and back-fills the stroke from the first", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(512);
    d.update(0, [sample(1, "A", { x: 0.3, y: 0.5 }, POINT(), 0)], ASPECT);
    // Render frames between the first and the confirming result: nothing is ink yet.
    for (let i = 1; i <= 5; i++) d.advance(i * FRAME, [kin(1, "A", { x: 0.3 + i * 0.004, y: 0.5 })], out);
    expect(out.count).toBe(0);
    expect(d.strokes).toBe(0);

    d.update(100, [sample(1, "A", { x: 0.33, y: 0.5 }, POINT(), 100)], ASPECT);
    d.advance(110, [kin(1, "A", { x: 0.33, y: 0.5 })], out);
    expect(d.strokes).toBe(1);
    const s = stamps(out);
    expect(s.length).toBeGreaterThanOrEqual(2);
    // The ink starts where the finger was at the first qualifying result, as a dot...
    expect(s[0].ax).toBeCloseTo(0.304, 5);
    expect(s[0].ay).toBeCloseTo(0.5, 5);
    expect(s[0].bx).toBeCloseTo(0.304, 5);
    // ...in two passes: hand A's blue at the design radius, then the ice-white core at 0.4 of it.
    expectRgba(s[0].rgba, INK_A);
    expect(s[0].r).toBeCloseTo(INK.radius);
    expectRgba(s[1].rgba, INK_CORE);
    expect(s[1].r).toBeCloseTo(INK.radius * INK.core);
    // ...and has moved on since.
    expect(Math.max(...s.map((x) => x.bx))).toBeGreaterThan(0.31);
  });

  it("stays pending through a null pose only if the results are consecutive", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(512);
    d.update(0, [sample(1, "A", { x: 0.3, y: 0.5 }, POINT(), 0)], ASPECT);
    d.advance(10, [kin(1, "A", { x: 0.3, y: 0.5 })], out);
    d.update(100, [sample(1, "A", { x: 0.3, y: 0.5 }, NONE(), 100)], ASPECT);
    d.advance(110, [kin(1, "A", { x: 0.3, y: 0.5 })], out);
    d.update(200, [sample(1, "A", { x: 0.3, y: 0.5 }, POINT(), 200)], ASPECT);
    d.advance(210, [kin(1, "A", { x: 0.3, y: 0.5 })], out);
    expect(out.count).toBe(0);
    expect(d.strokes).toBe(0);
  });

  it("lifts the pen 250 ms after the last pointing result, and at once on an open hand or a fist", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(512);
    let t = penDown(d, out, 1, { x: 0.3, y: 0.5 }, 0);
    expect(d.strokes).toBe(1);

    // A result without the pose, 100 ms after the last pointing one: still down.
    d.update(200, [sample(1, "A", { x: 0.32, y: 0.5 }, NONE(), 200)], ASPECT);
    out.reset();
    d.advance((t = 210), [kin(1, "A", { x: 0.32, y: 0.5 })], out);
    expect(out.count).toBeGreaterThan(0);

    // 300 ms after it: up. Moving the finger leaves nothing.
    d.update(400, [sample(1, "A", { x: 0.36, y: 0.5 }, NONE(), 400)], ASPECT);
    out.reset();
    d.advance((t = 410), [kin(1, "A", { x: 0.36, y: 0.5 })], out);
    d.advance((t = 426), [kin(1, "A", { x: 0.4, y: 0.5 })], out);
    expect(out.count).toBe(0);

    // Down again (two results), then an open hand lifts it on the spot.
    t = penDown(d, out, 1, { x: 0.5, y: 0.5 }, 500);
    expect(d.strokes).toBe(2);
    d.update(620, [sample(1, "A", { x: 0.5, y: 0.5 }, PALM(), 620)], ASPECT);
    out.reset();
    d.advance(630, [kin(1, "A", { x: 0.52, y: 0.5 })], out);
    expect(out.count).toBe(0);

    t = penDown(d, out, 1, { x: 0.6, y: 0.5 }, 700);
    d.update(820, [sample(1, "A", { x: 0.6, y: 0.5 }, FIST(), 820)], ASPECT);
    out.reset();
    d.advance(830, [kin(1, "A", { x: 0.62, y: 0.5 })], out);
    expect(out.count).toBe(0);
    expect(d.strokes).toBe(3);
  });

  it("keeps drawing through a coasting result and lifts when the hand leaves the picture", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(512);
    penDown(d, out, 1, { x: 0.3, y: 0.5 }, 0);
    // Coasting (the assigner's grace period) 100 ms after the last fresh pointing result: still down.
    d.update(200, [sample(1, "A", { x: 0.3, y: 0.5 }, POINT(), 200, false)], ASPECT);
    out.reset();
    d.advance(210, [kin(1, "A", { x: 0.31, y: 0.5 }, { fresh: false })], out);
    expect(out.count).toBeGreaterThan(0);
    // Still coasting 400 ms later: up.
    d.update(500, [sample(1, "A", { x: 0.3, y: 0.5 }, POINT(), 500, false)], ASPECT);
    out.reset();
    d.advance(510, [kin(1, "A", { x: 0.33, y: 0.5 }, { fresh: false })], out);
    expect(out.count).toBe(0);

    // Gone from the results entirely: no pen, no hold, nothing stamped for that id.
    penDown(d, out, 1, { x: 0.3, y: 0.5 }, 600);
    d.update(800, [], ASPECT);
    out.reset();
    d.advance(810, [], out);
    expect(out.count).toBe(0);
    expect(d.holdProgress(1)).toBe(0);
  });

  it("breaks the stroke on a jump of more than a quarter frame height and restarts where the hand reappears", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(1024);
    let t = penDown(d, out, 1, { x: 0.3, y: 0.5 }, 0);
    for (let i = 1; i <= 6; i++) d.advance((t += FRAME), [kin(1, "A", { x: 0.3 + i * 0.005, y: 0.5 })], out);
    expect(d.strokes).toBe(1);

    // The tracker finds the hand far below (0.35 frame heights): the observation jumps.
    d.update(300, [sample(1, "A", { x: 0.33, y: 0.85 }, POINT(), 300)], ASPECT);
    // The followers are still on their way: no ink along the transit.
    const before = out.count;
    d.advance(310, [kin(1, "A", { x: 0.33, y: 0.62 })], out);
    expect(out.count).toBe(before);
    // Arrived: a new stroke starts there.
    d.advance(326, [kin(1, "A", { x: 0.33, y: 0.85 })], out);
    d.advance(342, [kin(1, "A", { x: 0.34, y: 0.85 })], out);
    expect(d.strokes).toBe(2);
    for (const s of stamps(out)) expect(Math.abs(s.ay - s.by)).toBeLessThan(PEN.jumpBreak);
  });

  it("breaks the stroke when the glided tip itself steps a quarter frame height in one frame", () => {
    // The tracker has stalled (no update) and one render frame took 400 ms while the hand flew:
    // the follower steps. No ink joins the two places; the pen waits out the settle time, then restarts.
    const d = new DrawEffect();
    const out = new StampBuffer(1024);
    let t = penDown(d, out, 1, { x: 0.3, y: 0.5 }, 0);
    d.advance((t += FRAME), [kin(1, "A", { x: 0.31, y: 0.5 })], out);
    d.update(200, [sample(1, "A", { x: 0.31, y: 0.5 }, POINT(), 200)], ASPECT);
    d.advance((t = 210), [kin(1, "A", { x: 0.31, y: 0.9 })], out);
    const before = out.count;
    d.advance((t = 400), [kin(1, "A", { x: 0.31, y: 0.9 })], out);
    expect(out.count).toBe(before);
    expect(d.strokes).toBe(1);
    d.advance((t = 210 + PEN.settleMaxMs), [kin(1, "A", { x: 0.31, y: 0.9 })], out);
    d.advance((t += FRAME), [kin(1, "A", { x: 0.32, y: 0.9 })], out);
    expect(d.strokes).toBe(2);
    for (const s of stamps(out)) expect(Math.abs(s.ay - s.by)).toBeLessThan(PEN.jumpBreak);
  });

  it("draws one continuous stroke at 5 Hz tracking, bridges one dropped result and breaks on two", () => {
    const run = (dropAt: number[]) => {
      const d = new DrawEffect();
      const out = new StampBuffer(4096);
      const tipAt = (t: number) => ({ x: 0.3 + (t / 1000) * 0.15, y: 0.5 + 0.05 * Math.sin(t / 300) });
      let nextResult = 0;
      for (let t = 0; t <= 3000; t += FRAME) {
        if (t >= nextResult) {
          // Results every 200 ms, stamped with the time of their camera frame (160 ms ago).
          if (!dropAt.includes(nextResult)) d.update(nextResult - 160, [sample(1, "A", tipAt(nextResult - 160), POINT(), nextResult - 160)], ASPECT);
          nextResult += 200;
        }
        d.advance(t, [kin(1, "A", tipAt(t - 100))], out);
      }
      let longest = 0;
      for (const s of stamps(out)) longest = Math.max(longest, Math.hypot((s.bx - s.ax) * ASPECT, s.by - s.ay));
      return { strokes: d.strokes, stamps: out.count, longest };
    };
    const steady = run([]);
    expect(steady.strokes).toBe(1);
    expect(steady.stamps).toBeGreaterThan(100);
    expect(steady.longest).toBeLessThan(0.02); // pieces of a continuous line, not steps between results
    expect(run([1400]).strokes).toBe(1); // one lost result (400 ms gap) does not end the stroke
    expect(run([1400, 1600]).strokes).toBe(2); // two in a row do
  });

  it("clears once after a fist held 700 ms, shows the hold, and can clear again after a release", () => {
    const d = new DrawEffect();
    const fired: number[] = [];
    for (let t = 0; t <= 1200; t += 100) {
      d.update(t, [sample(1, "A", { x: 0.5, y: 0.5 }, FIST(), t)], ASPECT);
      if (d.consumeClear()) fired.push(t);
      if (t === 300) expect(d.holdProgress(1)).toBeCloseTo(300 / PEN.clearHoldMs);
    }
    expect(fired).toEqual([700]);
    expect(d.consumeClear()).toBe(false);
    // The ring is gone once the wipe has happened.
    expect(d.holdProgress(1)).toBe(0);

    // Open the hand, make a fist again: a second wipe.
    d.update(1300, [sample(1, "A", { x: 0.5, y: 0.5 }, PALM(), 1300)], ASPECT);
    expect(d.holdProgress(1)).toBe(0);
    for (let t = 1400; t <= 2200; t += 100) {
      d.update(t, [sample(1, "A", { x: 0.5, y: 0.5 }, FIST(), t)], ASPECT);
      if (d.consumeClear()) fired.push(t);
    }
    expect(fired).toEqual([700, 2100]);
  });

  it("advances the hold ring between tracking results and the explicit clear is reported once", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(64);
    d.update(0, [sample(1, "A", { x: 0.5, y: 0.5 }, FIST(), 0)], ASPECT);
    d.advance(350, [kin(1, "A", { x: 0.5, y: 0.5 })], out);
    expect(d.holdProgress(1)).toBeCloseTo(0.5);
    d.advance(700, [kin(1, "A", { x: 0.5, y: 0.5 })], out);
    expect(d.consumeClear()).toBe(true);
    expect(d.consumeClear()).toBe(false);
    d.clear();
    expect(d.consumeClear()).toBe(true);
    expect(d.consumeClear()).toBe(false);
  });

  it("draws with an L too, in hand B's violet, and never when the hand pinches", () => {
    const d = new DrawEffect();
    const out = new StampBuffer(512);
    d.update(0, [sample(2, "B", { x: 0.7, y: 0.5 }, L(), 0)], ASPECT);
    d.advance(10, [kin(2, "B", { x: 0.7, y: 0.5 })], out);
    d.update(100, [sample(2, "B", { x: 0.7, y: 0.5 }, L(), 100)], ASPECT);
    d.advance(110, [kin(2, "B", { x: 0.7, y: 0.5 })], out);
    expect(d.strokes).toBe(1);
    expect(stamps(out)[0].rgba[2]).toBeCloseTo(1); // #8c66ff: blue channel full
    expect(stamps(out)[0].rgba[0]).toBeCloseTo(0x8c / 255);

    const ok = pose({ name: "OK", ok: true, point: true, indexOut: true, pinchRatio: 0.2 });
    const d2 = new DrawEffect();
    const out2 = new StampBuffer(512);
    d2.update(0, [sample(1, "A", { x: 0.3, y: 0.5 }, ok, 0)], ASPECT);
    d2.advance(10, [kin(1, "A", { x: 0.3, y: 0.5 })], out2);
    d2.update(100, [sample(1, "A", { x: 0.3, y: 0.5 }, ok, 100)], ASPECT);
    d2.advance(110, [kin(1, "A", { x: 0.3, y: 0.5 })], out2);
    expect(out2.count).toBe(0);
  });

  it("delays ink rather than dropping it when the stamp buffer is full", () => {
    const d = new DrawEffect();
    const tiny = new StampBuffer(2);
    d.update(0, [sample(1, "A", { x: 0.3, y: 0.5 }, POINT(), 0)], ASPECT);
    let t = 0;
    for (let i = 1; i <= 8; i++) d.advance((t += FRAME), [kin(1, "A", { x: 0.3 + i * 0.01, y: 0.5 })], tiny);
    d.update(200, [sample(1, "A", { x: 0.38, y: 0.5 }, POINT(), 200)], ASPECT);
    d.advance(210, [kin(1, "A", { x: 0.38, y: 0.5 })], tiny);
    expect(tiny.count).toBe(2); // the dot only
    let total = 2;
    for (let i = 0; i < 12; i++) {
      tiny.reset();
      d.advance(220 + i * FRAME, [kin(1, "A", { x: 0.38, y: 0.5 })], tiny);
      total += tiny.count;
    }
    expect(total).toBeGreaterThan(2); // the back-filled pieces came out over the next frames
  });
});

// ── sparks ──────────────────────────────────────────────────────────────────────────────

describe("SparkField", () => {
  it("emits at the given rate on average and is reproducible with a seed", () => {
    const run = (seed: number) => {
      const f = new SparkField(640, seed);
      const em = [{ x: 0.5, y: 0.5, vx: 0, vy: 0, rate: 30 }];
      for (let i = 0; i < 120; i++) f.step(1 / 60, ASPECT, em, []);
      return f;
    };
    const a = run(5);
    const b = run(5);
    const c = run(6);
    expect(a.spawned).toBeGreaterThan(40);
    expect(a.spawned).toBeLessThan(80);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.data.subarray(0, a.count * SPARK.stride))).toEqual(Array.from(b.data.subarray(0, b.count * SPARK.stride)));
    expect(Array.from(c.data.subarray(0, 20))).not.toEqual(Array.from(a.data.subarray(0, 20)));
  });

  it("keeps every spark inside its bounds: size 2–6 px, life 0..1, hue 0..1, lives 0.7–1.6 s", () => {
    const f = new SparkField(640, 2);
    const em = [{ x: 0.5, y: 0.5, vx: 0, vy: 0, rate: 400, hue: SPARK.hueB }];
    f.step(1 / 60, ASPECT, em, []);
    const born = f.count;
    expect(born).toBeGreaterThan(3);
    for (let i = 0; i < f.count; i++) {
      const o = i * SPARK.stride;
      expect(f.data[o + 2]).toBeGreaterThanOrEqual(SPARK.sizeMinPx / SPARK.pxPerFrameHeight);
      expect(f.data[o + 2]).toBeLessThanOrEqual(SPARK.sizeMaxPx / SPARK.pxPerFrameHeight);
      expect(f.data[o + 3]).toBe(0);
      expect(f.data[o + 4]).toBeGreaterThanOrEqual(SPARK.hueB - SPARK.hueSpread);
      expect(f.data[o + 4]).toBeLessThanOrEqual(1);
    }
    for (let t = 0; t < 0.69; t += 1 / 60) f.step(1 / 60, ASPECT, [], []);
    expect(f.count).toBe(born); // none can die before 0.7 s
    for (let t = 0; t < 1; t += 1 / 60) f.step(1 / 60, ASPECT, [], []);
    expect(f.count).toBe(0); // none lives past 1.6 s
  });

  it("drifts upward under drag", () => {
    const f = new SparkField(64, 3);
    f.step(1 / 60, ASPECT, [{ x: 0.5, y: 0.5, vx: 0, vy: 0, rate: 3000 }], []);
    const c0 = centroid(f);
    for (let i = 0; i < 30; i++) f.step(1 / 60, ASPECT, [], []);
    const c1 = centroid(f);
    expect(c1.y).toBeLessThan(c0.y); // y down: up is smaller
  });

  it("respects the cap, including a lowered one", () => {
    const f = new SparkField(640, 4);
    const em = Array.from({ length: 10 }, () => ({ x: 0.5, y: 0.5, vx: 0, vy: 0, rate: 200 }));
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      f.step(1 / 60, ASPECT, em, []);
      expect(f.count).toBeLessThanOrEqual(640);
      peak = Math.max(peak, f.count);
    }
    expect(peak).toBe(640);
    f.setCap(320);
    f.step(1 / 60, ASPECT, em, []);
    expect(f.count).toBeLessThanOrEqual(320);
    f.clear();
    expect(f.count).toBe(0);
  });

  it("is pulled toward an attractor within its radius and thrown outward by a kick", () => {
    const seed = 8;
    const make = () => {
      const f = new SparkField(640, seed);
      f.step(1 / 60, ASPECT, [{ x: 0.5, y: 0.5, vx: 0, vy: 0, rate: 6000 }], []);
      return f;
    };
    const free = make();
    const pulled = make();
    const at = { x: 0.5, y: 0.7, strength: SPARK.attractStrength, radius: SPARK.attractRadius };
    for (let i = 0; i < 24; i++) {
      free.step(1 / 60, ASPECT, [], []);
      pulled.step(1 / 60, ASPECT, [], [at]);
    }
    expect(centroid(pulled).y).toBeGreaterThan(centroid(free).y + 0.05);
    // Out of range: nothing happens.
    const far = make();
    const beyond = make();
    for (let i = 0; i < 6; i++) {
      far.step(1 / 60, ASPECT, [], []);
      beyond.step(1 / 60, ASPECT, [], [{ x: 0.5, y: 0.95, strength: 2.2, radius: 0.35 }]);
    }
    expect(centroid(beyond).y).toBeCloseTo(centroid(far).y, 6);

    const still = make();
    const kicked = make();
    kicked.kick(0.5, 0.5, SPARK.attractRadius, SPARK.kickSpeed);
    for (let i = 0; i < 6; i++) {
      still.step(1 / 60, ASPECT, [], []);
      kicked.step(1 / 60, ASPECT, [], []);
    }
    const c = { x: 0.5, y: 0.5 };
    expect(meanDist(kicked, c)).toBeGreaterThan(meanDist(still, c) + 0.05);
  });
});

describe("SparksEffect", () => {
  const steps = (fx: SparksEffect, hand: HandKinematics, frames: number, lowFps = false) => {
    for (let i = 0; i < frames; i++) fx.advance(i * FRAME, 1 / 60, ASPECT, [hand], lowFps);
  };

  it("sheds more sparks from a fast fingertip than from a still one", () => {
    const slow = new SparksEffect(7);
    const fast = new SparksEffect(7);
    const tip = { x: 0.5, y: 0.5 };
    slow.update(0, [sample(1, "A", tip, PALM(), 0)]);
    fast.update(0, [sample(1, "A", tip, PALM(), 0)]);
    const v = () => ({ x: 0.5, y: 0 }); // 640 px/s on a 1280×720 frame: the top rate
    steps(slow, kin(1, "A", tip), 120);
    steps(fast, kin(1, "A", tip, { tipVel: [v(), v(), v(), v(), v()] }), 120);
    // Five tips for two seconds: about 40 at the floor rate against about 360 at the ceiling.
    expect(slow.field.spawned).toBeGreaterThan(20);
    expect(slow.field.spawned).toBeLessThan(70);
    expect(fast.field.spawned).toBeGreaterThan(slow.field.spawned * 4);
  });

  it("emits nothing from a coasting hand, colours by hand, and halves the cap when rendering is slow", () => {
    const fx = new SparksEffect(9);
    fx.update(0, [sample(1, "A", { x: 0.5, y: 0.5 }, PALM(), 0)]);
    steps(fx, kin(1, "A", { x: 0.5, y: 0.5 }, { fresh: false }), 30);
    expect(fx.field.spawned).toBe(0);

    const b = new SparksEffect(9);
    b.update(0, [sample(2, "B", { x: 0.5, y: 0.5 }, PALM(), 0)]);
    steps(b, kin(2, "B", { x: 0.5, y: 0.5 }), 30);
    expect(b.field.count).toBeGreaterThan(0);
    for (let i = 0; i < b.field.count; i++) expect(b.field.data[i * SPARK.stride + 4]).toBeGreaterThan(0.5);

    const busy = new SparksEffect(10);
    busy.update(0, [sample(1, "A", { x: 0.5, y: 0.5 }, PALM(), 0)]);
    const fastHand = kin(1, "A", { x: 0.5, y: 0.5 }, { tipVel: Array.from({ length: 5 }, () => ({ x: 2, y: 0 })) });
    steps(busy, fastHand, 240, true);
    expect(busy.field.count).toBeLessThanOrEqual(SPARK.lowCap);
    busy.clear();
    expect(busy.field.count).toBe(0);
  });

  it("gathers sparks with a fist and throws them when the fist opens within 400 ms, not when it opens slowly", () => {
    const run = (openAt: number) => {
      const fx = new SparksEffect(11);
      const palm = { x: 0.5, y: 0.6 };
      const tip = { x: 0.5, y: 0.48 };
      // A fist for a while: its fingertips still shed sparks, which it holds.
      fx.update(0, [sample(1, "A", tip, FIST(), 0)]);
      for (let i = 0; i < 30; i++) fx.advance(i * FRAME, 1 / 60, ASPECT, [kin(1, "A", tip, { palm })], false);
      const held = meanDist(fx.field, palm);
      fx.update(openAt, [sample(1, "A", tip, PALM(), openAt)]);
      for (let i = 0; i < 6; i++) fx.advance(openAt + i * FRAME, 1 / 60, ASPECT, [kin(1, "A", tip, { palm, fresh: false })], false);
      return { held, after: meanDist(fx.field, palm) };
    };
    const quick = run(300);
    const slow = run(900);
    expect(quick.held).toBeLessThan(0.1);
    expect(quick.after).toBeGreaterThan(quick.held + 0.05);
    expect(slow.after).toBeLessThan(slow.held + 0.03);
  });
});

// ── fog ─────────────────────────────────────────────────────────────────────────────────

describe("FogEffect", () => {
  const none = new Map<number, PoseName | null>();

  it("reports one decay step per 110 ms whatever the frame rate: full recovery in about 7 s", () => {
    for (const interval of [FRAME, 33.3, 200, 330]) {
      const fog = new FogEffect();
      const out = new StampBuffer(16);
      fog.enter(0);
      expect(fog.advance(0, [], none, out).reset).toBe(true);
      let sum = 0;
      let t = 0;
      while (t < 7100) {
        t += interval;
        sum += fog.advance(t, [], none, out).decaySteps;
      }
      expect(sum, `interval ${interval}`).toBe(Math.floor(t / FOG.decayStepMs));
      expect(sum * FOG.decayPerStep).toBeGreaterThanOrEqual(1); // the mask is back to full fog
      expect(sum).toBeLessThanOrEqual(FOG.maxStepsPerFrame + 2);
    }
  });

  it("catches up after a stall but never stamps more steps than a full recovery", () => {
    const fog = new FogEffect();
    const out = new StampBuffer(16);
    fog.enter(0);
    fog.advance(0, [], none, out);
    fog.advance(100, [], none, out);
    expect(fog.advance(60100, [], none, out).decaySteps).toBe(FOG.maxStepsPerFrame);
    expect(fog.advance(60200, [], none, out).decaySteps).toBe(0); // the backlog is gone, not carried
    expect(fog.advance(60320, [], none, out).decaySteps).toBe(2); // 220 ms since the catch-up: the normal cadence again
  });

  it("fades in over 0.8 s after enter(), re-fogs at once on reset(), and reports each once", () => {
    const fog = new FogEffect();
    const out = new StampBuffer(16);
    fog.enter(1000);
    const a = fog.advance(1000, [], none, out);
    expect(a.density).toBe(0);
    expect(a.reset).toBe(true);
    const b = fog.advance(1400, [], none, out);
    expect(b.density).toBeCloseTo(0.5);
    expect(b.reset).toBe(false);
    let last = b.density;
    for (let t = 1416; t <= 1800; t += 16) {
      const d = fog.advance(t, [], none, out).density;
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
    expect(fog.advance(1801, [], none, out).density).toBe(1);
    expect(fog.advance(5000, [], none, out).density).toBe(1);
    fog.reset();
    const r = fog.advance(5016, [], none, out);
    expect(r.reset).toBe(true);
    expect(r.decaySteps).toBe(0);
    expect(r.density).toBe(1);
    expect(fog.advance(5032, [], none, out).reset).toBe(false);
  });

  it("wipes along the palm's path at half the hand scale, or along the index tip at 0.02 when pointing", () => {
    const fog = new FogEffect();
    const out = new StampBuffer(64);
    fog.enter(0);
    const palmPose = new Map<number, PoseName | null>([[1, "palm"]]);
    fog.advance(0, [kin(1, "A", { x: 0.3, y: 0.4 }, { palm: { x: 0.3, y: 0.5 } })], palmPose, out);
    let s = stamps(out);
    expect(s).toHaveLength(1);
    expectDot(s[0], 0.3, 0.5); // the first frame is a dot
    expect(s[0].r).toBeCloseTo(FOG.palmRadius * S2);
    expectRgba(s[0].rgba, WIPE);

    out.reset();
    fog.advance(16, [kin(1, "A", { x: 0.32, y: 0.4 }, { palm: { x: 0.32, y: 0.5 } })], palmPose, out);
    s = stamps(out);
    expect(s[0].ax).toBeCloseTo(0.3);
    expect(s[0].bx).toBeCloseTo(0.32); // joined to last frame's end

    // Pointing: the tip, thinner, and a fresh dot because the kind of wipe changed.
    out.reset();
    const pointPose = new Map<number, PoseName | null>([[1, "point"]]);
    fog.advance(32, [kin(1, "A", { x: 0.34, y: 0.4 }, { palm: { x: 0.34, y: 0.5 } })], pointPose, out);
    s = stamps(out);
    expect(s).toHaveLength(1);
    expectDot(s[0], 0.34, 0.4);
    expect(s[0].r).toBeCloseTo(FOG.tipRadius);

    // A coasting hand does not wipe; a hand that jumped starts over with a dot.
    out.reset();
    fog.advance(48, [kin(1, "A", { x: 0.36, y: 0.4 }, { fresh: false })], pointPose, out);
    expect(out.count).toBe(0);
    out.reset();
    fog.advance(64, [kin(1, "A", { x: 0.9, y: 0.9 })], pointPose, out);
    s = stamps(out);
    expectDot(s[0], 0.9, 0.9);
  });
});

// ── vanish ──────────────────────────────────────────────────────────────────────────────

describe("VanishEffect", () => {
  it("goes none → countdown → capturing (replace, then nine blends) → ready on request", () => {
    const v = new VanishEffect();
    expect(v.state).toBe("none");
    expect(v.consumeCapture(0)).toBe("none");
    v.requestCapture(1000);
    expect(v.state).toBe("countdown");
    expect(v.countdown(1000)).toBeCloseTo(VANISH.countdownMs / 1000);
    expect(v.countdown(2500)).toBeCloseTo(1.5);
    expect(v.consumeCapture(2500)).toBe("none");
    expect(v.state).toBe("countdown");
    expect(v.consumeCapture(4000)).toBe("replace");
    expect(v.state).toBe("capturing");
    expect(v.countdown(4000)).toBe(0);
    for (let i = 1; i < VANISH.captureFrames - 1; i++) {
      expect(v.consumeCapture(4000 + i * 16)).toBe("blend");
      expect(v.state).toBe("capturing");
    }
    expect(v.consumeCapture(4200)).toBe("blend");
    expect(v.state).toBe("ready");
    expect(v.consumeCapture(4216)).toBe("none");
    expect(v.state).toBe("ready");
  });

  it("captures by itself only when the detector sees nobody and no hand for 1.5 s, never without a detector", () => {
    const v = new VanishEffect();
    v.update(0, { hands: 0, face: false });
    v.update(1400, { hands: 0, face: false });
    expect(v.state).toBe("none");
    v.update(1500, { hands: 0, face: false });
    expect(v.state).toBe("capturing");
    expect(v.consumeCapture(1510)).toBe("replace");

    const off = new VanishEffect();
    for (let t = 0; t <= 10000; t += 100) off.update(t, { hands: 0, face: null });
    expect(off.state).toBe("none");

    const face = new VanishEffect();
    for (let t = 0; t <= 10000; t += 100) face.update(t, { hands: 0, face: true });
    expect(face.state).toBe("none");

    // A hand restarts the clock.
    const hands = new VanishEffect();
    hands.update(0, { hands: 0, face: false });
    hands.update(1000, { hands: 1, face: false });
    hands.update(2000, { hands: 0, face: false });
    hands.update(3000, { hands: 0, face: false });
    expect(hands.state).toBe("none");
    hands.update(3500, { hands: 0, face: false });
    expect(hands.state).toBe("capturing");
  });

  it("does not replace a ready plate by itself, and a countdown ignores who is in view", () => {
    const v = new VanishEffect();
    v.requestCapture(0, 0);
    for (let i = 0; i < VANISH.captureFrames; i++) v.consumeCapture(i * 16);
    expect(v.state).toBe("ready");
    for (let t = 0; t <= 5000; t += 100) v.update(t, { hands: 0, face: false });
    expect(v.state).toBe("ready");

    v.requestCapture(6000);
    v.update(7000, { hands: 2, face: true });
    expect(v.state).toBe("countdown");
    expect(v.consumeCapture(9000)).toBe("replace");
  });

  it("cancel returns to what was there, invalidate forgets the plate, a second request restarts the countdown", () => {
    const v = new VanishEffect();
    v.requestCapture(0);
    v.cancel();
    expect(v.state).toBe("none");
    expect(v.countdown(100)).toBe(0);

    v.requestCapture(0, 0);
    for (let i = 0; i < VANISH.captureFrames; i++) v.consumeCapture(i * 16);
    expect(v.state).toBe("ready");
    v.requestCapture(1000);
    expect(v.state).toBe("countdown");
    v.requestCapture(2000);
    expect(v.countdown(2000)).toBeCloseTo(3);
    v.cancel();
    expect(v.state).toBe("ready");

    // Cancelled mid-capture: what was stored is the plate.
    v.requestCapture(3000, 0);
    expect(v.consumeCapture(3000)).toBe("replace");
    v.cancel();
    expect(v.state).toBe("ready");

    v.invalidate();
    expect(v.state).toBe("none");
    expect(v.consumeCapture(4000)).toBe("none");
  });
});
