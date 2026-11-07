import { describe, expect, it } from "vitest";
import { FACE_T, FaceTrack, InferenceLoad, faceInterval, facePolicy, toStageFace } from "../src/tracking/FaceTrack";
import type { RawFace } from "../src/toy/types";

/** Small seeded PRNG, so jittered runs are the same every time. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const face = (x: number, y: number, w: number, h: number, score = 0.9): RawFace => ({ x, y, w, h, score });
const FACE = face(0.4, 0.3, 0.2, 0.3);
const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Feeds one detector result per interval from `from` to `to` inclusive. */
function run(ft: FaceTrack, from: number, to: number, interval: number, faces: RawFace[] | null, mirror = true) {
  for (let t = from; t <= to; t += interval) ft.update(t, faces, mirror);
}

describe("toStageFace", () => {
  it("mirrors x and keeps the width", () => {
    const b = toStageFace(face(0.1, 0.2, 0.2, 0.3), true);
    expect(b.x).toBeCloseTo(0.7, 9);
    expect(b.w).toBeCloseTo(0.2, 9);
    expect(toStageFace(face(0.1, 0.2, 0.2, 0.3), false).x).toBeCloseTo(0.1, 9);
  });

  it("extends the eyebrow-to-chin box up to the hairline (y -= 0.12 h, h *= 1.22)", () => {
    const b = toStageFace(face(0.1, 0.2, 0.2, 0.3), false);
    expect(b.y).toBeCloseTo(0.2 - 0.12 * 0.3, 9);
    expect(b.h).toBeCloseTo(0.3 * 1.22, 9);
    expect(b.y + b.h).toBeCloseTo(0.2 + 0.3 + 0.1 * 0.3, 9);
    expect(b.score).toBe(0.9);
  });

  it("clamps to the stage without moving the box", () => {
    const top = toStageFace(face(0.1, 0.02, 0.2, 0.3), false);
    expect(top.y).toBe(0);
    expect(top.h).toBeCloseTo(0.02 + 0.3 * 1.1, 9);
    const bottom = toStageFace(face(0.1, 0.8, 0.2, 0.3), false);
    expect(bottom.y + bottom.h).toBe(1);
    expect(bottom.y).toBeCloseTo(0.8 - 0.036, 9);
    const edge = toStageFace(face(0.95, 0.3, 0.2, 0.3), true);
    expect(edge.x).toBe(0);
    expect(edge.w).toBeCloseTo(0.05, 9);
  });
});

describe("FaceTrack", () => {
  it("passes the first box through and the largest face wins", () => {
    const ft = new FaceTrack();
    const small = face(0.1, 0.1, 0.1, 0.1, 0.95);
    const big = face(0.5, 0.4, 0.3, 0.3, 0.7);
    ft.update(0, [small, big], false);
    const s = ft.snapshot(0)!;
    const want = toStageFace(big, false);
    expect(s.score).toBe(0.7);
    expect(s.alpha).toBe(1);
    expect(s.x).toBeCloseTo(want.x, 9);
    expect(s.y).toBeCloseTo(want.y, 9);
    expect(s.w).toBeCloseTo(want.w, 9);
    expect(s.h).toBeCloseTo(want.h, 9);
    expect(ft.present(0)).toBe(true);
  });

  it("smoothing converges to a steady face", () => {
    const ft = new FaceTrack();
    ft.update(0, [face(0.1, 0.1, 0.1, 0.15)], true);
    run(ft, 300, 3000, 300, [FACE]);
    const want = toStageFace(FACE, true);
    const s = ft.snapshot(3000)!;
    expect(s.x).toBeCloseTo(want.x, 3);
    expect(s.y).toBeCloseTo(want.y, 3);
    expect(s.w).toBeCloseTo(want.w, 3);
    expect(s.h).toBeCloseTo(want.h, 3);
  });

  it("smoothing removes a good part of the detector's jitter at 3 Hz", () => {
    const ft = new FaceTrack();
    const r = mulberry32(11);
    const want = centre(toStageFace(FACE, true));
    const rawDev: number[] = [];
    const outDev: number[] = [];
    for (let i = 0; i < 80; i++) {
      const jx = (r() - 0.5) * 0.02;
      const jy = (r() - 0.5) * 0.02;
      const raw = face(FACE.x + jx, FACE.y + jy, FACE.w, FACE.h);
      ft.update(i * 300, [raw], true);
      if (i >= 10) {
        const c = centre(ft.snapshot(i * 300)!);
        rawDev.push(Math.hypot(jx, jy));
        outDev.push(Math.hypot(c.x - want.x, c.y - want.y));
      }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(outDev)).toBeLessThan(mean(rawDev) * 0.85);
  });

  it("holds the box 900 ms after the last detection, then fades over 300 ms", () => {
    const ft = new FaceTrack();
    run(ft, 0, 1500, 300, [FACE]);
    expect(ft.snapshot(1500 + 899)!.alpha).toBe(1);
    expect(ft.snapshot(1500 + 900)!.alpha).toBe(1);
    expect(ft.snapshot(1500 + 1050)!.alpha).toBeCloseTo(0.5, 6);
    expect(ft.snapshot(1500 + 1199)!.alpha).toBeGreaterThan(0);
    expect(ft.snapshot(1500 + 1200)).toBeNull();
    expect(ft.present(1500 + 900)).toBe(true);
    expect(ft.present(1500 + 901)).toBe(false);
    expect(ft.present(1500 + 1000)).toBe(false);
  });

  it("empty results while the detector runs do not shorten or extend the hold", () => {
    const ft = new FaceTrack();
    run(ft, 0, 1500, 300, [FACE]);
    run(ft, 1800, 3000, 300, []);
    expect(ft.snapshot(2400)!.alpha).toBe(1);
    expect(ft.snapshot(2550)!.alpha).toBeCloseTo(0.5, 6);
    expect(ft.snapshot(2700)).toBeNull();
    expect(ft.present(2400)).toBe(true);
    expect(ft.present(2401)).toBe(false);
  });

  it("one dropped result keeps the box and the smoothing continuous", () => {
    const ft = new FaceTrack();
    run(ft, 0, 600, 300, [FACE]);
    ft.update(900, [], true);
    ft.update(1200, [], true);
    expect(ft.snapshot(1499)!.alpha).toBe(1);
    const before = centre(ft.snapshot(1499)!);
    const moved = face(FACE.x + 0.1, FACE.y, FACE.w, FACE.h);
    ft.update(1500, [moved], true);
    const after = centre(ft.snapshot(1500)!);
    const target = centre(toStageFace(moved, true));
    // Glided towards the new place, not jumped: strictly between the old and the new centre.
    expect(after.x).toBeLessThan(before.x);
    expect(after.x).toBeGreaterThan(target.x);
  });

  it("the hold grows with a slow detector so the box never blinks between results", () => {
    const measured = new FaceTrack();
    run(measured, 0, 4800, 1200, [FACE]);
    // After the interval has been measured, the box is solid right up to the next result.
    expect(measured.snapshot(2400 + 1199)!.alpha).toBe(1);
    expect(measured.snapshot(4800 + 1199)!.alpha).toBe(1);
    expect(measured.present(4800 + 1199)).toBe(true);
    // Far beyond the longest interval it still goes away.
    expect(measured.snapshot(4800 + FACE_T.holdMaxMs + FACE_T.fadeMs)).toBeNull();

    // Told the interval up front, it is right from the first result.
    const told = new FaceTrack();
    told.setInterval(1200);
    told.update(0, [FACE], true);
    expect(told.snapshot(1199)!.alpha).toBe(1);
    expect(told.present(1199)).toBe(true);
  });

  it("a face found after the box had gone is shown where it is, without gliding", () => {
    const ft = new FaceTrack();
    const left = face(0.05, 0.3, 0.2, 0.3);
    const right = face(0.7, 0.4, 0.2, 0.3);
    ft.update(0, [left], false);
    expect(ft.snapshot(3000)).toBeNull();
    ft.update(3000, [right], false);
    const s = ft.snapshot(3000)!;
    const want = toStageFace(right, false);
    expect(s.x).toBeCloseTo(want.x, 9);
    expect(s.y).toBeCloseTo(want.y, 9);
    expect(s.alpha).toBe(1);
  });

  it("present() is null until the detector runs, false when it sees nobody, null again when it stops", () => {
    const ft = new FaceTrack();
    expect(ft.present(0)).toBeNull();
    expect(ft.snapshot(0)).toBeNull();
    ft.update(0, [], true);
    expect(ft.present(0)).toBe(false);
    ft.update(300, [FACE], true);
    expect(ft.present(300)).toBe(true);
    expect(ft.present(1200)).toBe(true);
    expect(ft.present(1201)).toBe(false);
    ft.update(600, null, true);
    expect(ft.present(600)).toBeNull();
    expect(ft.present(650)).toBeNull();
    // The stop does not pop the box: it fades out from the moment the detector went away.
    expect(ft.snapshot(600)!.alpha).toBe(1);
    expect(ft.snapshot(750)!.alpha).toBeCloseTo(0.5, 6);
    expect(ft.snapshot(900)).toBeNull();
  });

  it("reset forgets everything", () => {
    const ft = new FaceTrack();
    run(ft, 0, 900, 300, [FACE]);
    ft.reset();
    expect(ft.present(900)).toBeNull();
    expect(ft.snapshot(900)).toBeNull();
    ft.update(1000, [], true);
    expect(ft.present(1000)).toBe(false);
  });
});

describe("faceInterval", () => {
  it("is 4 × the hand inference time, clamped to 300..1200 ms", () => {
    expect(faceInterval(50)).toBe(300);
    expect(faceInterval(75)).toBe(300);
    expect(faceInterval(100)).toBe(400);
    expect(faceInterval(250)).toBe(1000);
    expect(faceInterval(400)).toBe(1200);
    expect(faceInterval(0)).toBe(300);
    expect(faceInterval(NaN)).toBe(300);
  });
});

describe("facePolicy", () => {
  const off = { running: false, coolUntil: 0 };
  const on = { running: true, coolUntil: 0 };
  const input = (over: Partial<Parameters<typeof facePolicy>[1]> = {}) => ({
    now: 10_000,
    mode: "auto" as const,
    needed: true,
    handInferenceMs: 100,
    steadyMs: 3000,
    ...over,
  });

  it("mode off never wants the detector but still reports the interval", () => {
    expect(facePolicy(off, input({ mode: "off" }))).toEqual({ want: false, intervalMs: 400, coolUntil: 0 });
    expect(facePolicy(on, input({ mode: "off", handInferenceMs: 300, steadyMs: 60_000 }))).toEqual({
      want: false,
      intervalMs: 1200,
      coolUntil: 0,
    });
  });

  it("mode on follows `needed` whatever the load or cool-down", () => {
    expect(facePolicy(off, input({ mode: "on", handInferenceMs: 400, steadyMs: 0 })).want).toBe(true);
    expect(facePolicy({ running: false, coolUntil: 99_999 }, input({ mode: "on" })).want).toBe(true);
    expect(facePolicy(on, input({ mode: "on", needed: false })).want).toBe(false);
    expect(facePolicy(on, input({ mode: "on", handInferenceMs: 400, steadyMs: 60_000 })).coolUntil).toBe(0);
  });

  it("auto starts once inference has been ≤ 120 ms for 3 s", () => {
    expect(facePolicy(off, input({ steadyMs: 2999 })).want).toBe(false);
    expect(facePolicy(off, input({ steadyMs: 3000 })).want).toBe(true);
    expect(facePolicy(off, input({ handInferenceMs: 120, steadyMs: 3000 })).want).toBe(true);
    expect(facePolicy(off, input({ handInferenceMs: 121, steadyMs: 30_000 })).want).toBe(false);
    expect(facePolicy(off, input({ needed: false })).want).toBe(false);
  });

  it("auto keeps running between 120 and 160 ms and stops after 5 s above 160 ms with a 60 s cool-down", () => {
    expect(facePolicy(on, input({ handInferenceMs: 150, steadyMs: 60_000 })).want).toBe(true);
    expect(facePolicy(on, input({ handInferenceMs: 170, steadyMs: 4999 })).want).toBe(true);
    const stopped = facePolicy(on, input({ handInferenceMs: 170, steadyMs: 5000 }));
    expect(stopped.want).toBe(false);
    expect(stopped.coolUntil).toBe(10_000 + 60_000);
    expect(stopped.intervalMs).toBe(680);
  });

  it("auto respects the cool-down and does not add one for a stop that was not about load", () => {
    const cooling = { running: false, coolUntil: 20_000 };
    expect(facePolicy(cooling, input({ now: 19_999 })).want).toBe(false);
    expect(facePolicy(cooling, input({ now: 20_000 })).want).toBe(true);
    expect(facePolicy(cooling, input({ now: 19_999 })).coolUntil).toBe(20_000);
    const notNeeded = facePolicy(on, input({ needed: false, handInferenceMs: 300, steadyMs: 60_000 }));
    expect(notNeeded.want).toBe(false);
    expect(notNeeded.coolUntil).toBe(0);
  });

  it("round trip: the detector starts, is overloaded, stops, cools down and starts again", () => {
    const load = new InferenceLoad();
    let state = { running: false, coolUntil: 0 };
    const step = (now: number, ms: number) => {
      const l = load.sample(now, ms, state.running);
      const r = facePolicy(state, { now, mode: "auto", needed: true, ...l });
      state = { running: r.want, coolUntil: r.coolUntil };
      return r;
    };
    let t = 0;
    // The first result at t = 0 starts the steady clock; 3 s later the detector may start.
    for (; t < 3000; t += 100) expect(step(t, 100).want).toBe(false);
    for (; t < 4000; t += 100) expect(step(t, 100).want).toBe(true);
    // Load climbs: the average needs a moment to follow, then 5 s above 160 ms stop it.
    let stoppedAt = -1;
    for (; t < 12_000; t += 100) {
      const r = step(t, 300);
      if (!r.want && stoppedAt < 0) stoppedAt = t;
    }
    expect(stoppedAt).toBeGreaterThan(4000 + 5000);
    expect(stoppedAt).toBeLessThan(4000 + 7000);
    expect(state.coolUntil).toBe(stoppedAt + 60_000);
    // Fast again at once, but the cool-down holds the start back until it expires.
    for (; t < stoppedAt + 60_000; t += 100) expect(step(t, 100).want).toBe(false);
    for (; t < stoppedAt + 60_300; t += 100) step(t, 100);
    expect(state.running).toBe(true);
  });
});

describe("InferenceLoad", () => {
  it("averages the inference time and counts how long it has stayed under the start threshold", () => {
    const load = new InferenceLoad();
    let out = load.sample(0, 100, false);
    expect(out.handInferenceMs).toBe(100);
    expect(out.steadyMs).toBe(0);
    for (let t = 100; t <= 3000; t += 100) out = load.sample(t, 100, false);
    expect(out.handInferenceMs).toBeCloseTo(100, 6);
    expect(out.steadyMs).toBe(3000);
  });

  it("one slow result does not restart the clock; a sustained rise does", () => {
    const load = new InferenceLoad();
    let t = 0;
    for (; t <= 2000; t += 100) load.sample(t, 100, false);
    let out = load.sample(t, 250, false);
    expect(out.handInferenceMs).toBeLessThan(FACE_T.startBelowMs);
    expect(out.steadyMs).toBe(2100);
    for (t += 100; t <= 4000; t += 100) out = load.sample(t, 300, false);
    expect(out.handInferenceMs).toBeGreaterThan(FACE_T.startBelowMs);
    expect(out.steadyMs).toBeLessThan(2000);
    const crossedAt = t - out.steadyMs;
    for (; t <= 8000; t += 100) out = load.sample(t, 100, false);
    expect(out.handInferenceMs).toBeLessThan(FACE_T.startBelowMs);
    expect(out.steadyMs).toBeLessThan(t - crossedAt);
  });

  it("switches thresholds with the running state and restarts the clock when it flips", () => {
    const load = new InferenceLoad();
    let t = 0;
    for (; t <= 3000; t += 100) load.sample(t, 140, false);
    // 140 ms is above the start threshold while off ...
    expect(load.sample(t, 140, false).steadyMs).toBe(3100);
    // ... but under the stop threshold once on: the clock restarts on the flip and counts "fine" time.
    let out = load.sample(t, 140, true);
    expect(out.steadyMs).toBe(0);
    for (t += 100; t <= 6000; t += 100) out = load.sample(t, 140, true);
    expect(facePolicy({ running: true, coolUntil: 0 }, { now: t, mode: "auto", needed: true, ...out }).want).toBe(true);
    for (; t <= 12_000; t += 100) out = load.sample(t, 200, true);
    expect(out.handInferenceMs).toBeGreaterThan(FACE_T.stopAboveMs);
    expect(out.steadyMs).toBeGreaterThanOrEqual(FACE_T.stopAfterMs);
    expect(facePolicy({ running: true, coolUntil: 0 }, { now: t, mode: "auto", needed: true, ...out }).want).toBe(false);
  });

  it("ignores samples that are not numbers and can be reset", () => {
    const load = new InferenceLoad();
    load.sample(0, 100, false);
    const out = load.sample(100, NaN, false);
    expect(out.handInferenceMs).toBe(100);
    expect(out.steadyMs).toBe(100);
    load.reset();
    expect(Number.isNaN(load.value)).toBe(true);
    expect(load.sample(200, 90, false).steadyMs).toBe(0);
  });
});
