import { describe, expect, it } from "vitest";
import { HAND_MOTION_T, HandMotion, TIP_LANDMARKS } from "../src/tracking/handMotion";
import type { HandRole, TrackedHand } from "../src/tracking/handAssignment";
import { LM, palmCenter, type HandObservation } from "../src/tracking/landmarks";
import { framePose, syntheticHand } from "../src/tracking/syntheticHand";

const ASPECT = 16 / 9;
const SPACE = { w: 1280, h: 720 };

/** One tracked hand as the assigner would report it, with its palm centre at (x, y). */
function hand(id: number, role: HandRole, x: number, y: number, time: number, fresh = true, obs?: HandObservation): TrackedHand {
  const o = obs ?? syntheticHand(framePose(role, { x, y }), ASPECT);
  return { id, role, obs: o, palm: palmCenter(o.points), fresh, lastSeen: time, chirality: role === "A" ? -1 : 1 };
}

/** The isotropic hand scale of HandPose.s2 computed straight from an observation. */
function s2Of(points: { x: number; y: number }[]) {
  const d = (a: number, b: number) => Math.hypot((points[a].x - points[b].x) * ASPECT, points[a].y - points[b].y);
  return Math.max(d(LM.WRIST, LM.INDEX_MCP), d(LM.INDEX_MCP, LM.PINKY_MCP), d(LM.PINKY_MCP, LM.WRIST));
}

interface Motion {
  /** Tracking rate. */
  hz: number;
  /** Palm velocity, stage units per second. */
  vx: number;
  vy?: number;
  /** ms */
  duration: number;
  /** Render rate. */
  fps?: number;
  x0?: number;
  y0?: number;
  space?: { w: number; h: number };
}

/**
 * Plays one hand (id 1, role A) moving at constant velocity through a tracker and a
 * renderer; returns every snapshot with its render time.
 */
function play(m: Motion, motion = new HandMotion()) {
  const interval = 1000 / m.hz;
  const fps = m.fps ?? 60;
  const x0 = m.x0 ?? 0.3;
  const y0 = m.y0 ?? 0.5;
  const frames: { t: number; hands: ReturnType<HandMotion["snapshot"]> }[] = [];
  let nextResult = 0;
  for (let j = 0; (j * 1000) / fps <= m.duration; j++) {
    const t = (j * 1000) / fps;
    while (nextResult <= t) {
      const x = x0 + (m.vx / 1000) * nextResult;
      const y = y0 + ((m.vy ?? 0) / 1000) * nextResult;
      motion.update(nextResult, [hand(1, "A", x, y, nextResult)], ASPECT, m.space ?? SPACE);
      nextResult += interval;
    }
    frames.push({ t, hands: motion.snapshot(t) });
  }
  return { frames, motion };
}

describe("HandMotion", () => {
  it("reports nothing before the first result", () => {
    const m = new HandMotion();
    expect(m.snapshot(0)).toEqual([]);
    expect(m.ageMs(1, 0)).toBe(0);
  });

  it("snaps a new hand to where it is first seen and describes it completely", () => {
    const m = new HandMotion();
    const h = hand(7, "B", 0.6, 0.45, 1000);
    m.update(1000, [h], ASPECT, SPACE);
    const [k] = m.snapshot(1000);
    expect(k.id).toBe(7);
    expect(k.role).toBe("B");
    expect(k.fresh).toBe(true);
    expect(k.points).toHaveLength(21);
    for (let i = 0; i < 21; i++) {
      expect(k.points[i].x).toBeCloseTo(h.obs.points[i].x, 12);
      expect(k.points[i].y).toBeCloseTo(h.obs.points[i].y, 12);
    }
    expect(k.tipVel).toHaveLength(5);
    expect(TIP_LANDMARKS).toEqual([LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP]);
    for (const v of k.tipVel) expect(v).toEqual({ x: 0, y: 0 });
    expect(k.palm.x).toBeCloseTo(h.palm.x, 12);
    expect(k.palm.y).toBeCloseTo(h.palm.y, 12);
    expect(k.speedPx).toBe(0);
    // s2 is the HandPose definition: longest side of the wrist / index-knuckle / pinky-knuckle triangle, frame heights.
    expect(k.s2).toBeCloseTo(s2Of(h.obs.points), 12);
    expect(k.s2).toBeGreaterThan(0.1);
    expect(k.s2).toBeLessThan(0.3);
    // Still the same a long time later: nothing moves on its own.
    const [later] = m.snapshot(9000);
    expect(later.points[LM.INDEX_TIP]).toEqual(k.points[LM.INDEX_TIP]);
    expect(later.speedPx).toBe(0);
  });

  it("measures palm speed in label pixels per second and track age for a hand moving at a known speed", () => {
    // 0.3 stage/s across a 1280 px picture = 384 px/s; 0.1 stage/s down a 720 px picture = 72 px/s.
    const { frames, motion } = play({ hz: 10, vx: 0.3, vy: 0.1, duration: 3000 });
    const expected = Math.hypot(0.3 * SPACE.w, 0.1 * SPACE.h);
    const settled = frames.filter((f) => f.t >= 1500);
    expect(settled.length).toBeGreaterThan(80);
    for (const f of settled) {
      expect(f.hands).toHaveLength(1);
      expect(f.hands[0].speedPx).toBeGreaterThan(expected * 0.9);
      expect(f.hands[0].speedPx).toBeLessThan(expected * 1.1);
    }
    const mean = settled.reduce((s, f) => s + f.hands[0].speedPx, 0) / settled.length;
    expect(mean).toBeCloseTo(expected, -1); // within 5 px/s
    // The track has existed since the first result at time 0.
    expect(motion.ageMs(1, 3000)).toBe(3000);
    expect(motion.ageMs(1, 3250)).toBe(3250);
    expect(motion.ageMs(2, 3000)).toBe(0);
  });

  it("speed follows the label space, and the average spans 250 ms", () => {
    const big = play({ hz: 10, vx: 0.4, duration: 2500 }).frames;
    const small = play({ hz: 10, vx: 0.4, duration: 2500, space: { w: 640, h: 360 } }).frames;
    const last = big.length - 1;
    // The window spans 2.5 tracking intervals at 10 Hz, so the follower's ripple leaves a few percent of phase error.
    expect(big[last].hands[0].speedPx).toBeGreaterThan(0.4 * 1280 * 0.95);
    expect(big[last].hands[0].speedPx).toBeLessThan(0.4 * 1280 * 1.05);
    expect(small[last].hands[0].speedPx).toBeCloseTo(big[last].hands[0].speedPx / 2, 6);

    // A hand that stops: the reading falls to zero over about the window, not at once and not much later.
    // Results and render frames are interleaved as in the app (0.3 stage/s to x = 0.9 at 2000 ms, then still).
    const { frames, motion: m } = play({ hz: 10, vx: 0.3, duration: 2000 });
    expect(frames[frames.length - 1].hands[0].speedPx).toBeGreaterThan(300);
    const trace: number[] = [];
    let next = 2100;
    for (let r = 2000 + 1000 / 60; r <= 4000; r += 1000 / 60) {
      while (next <= r) {
        m.update(next, [hand(1, "A", 0.9, 0.5, next)], ASPECT, SPACE);
        next += 100;
      }
      trace.push(m.snapshot(r)[0].speedPx);
    }
    // 100 ms after the last moving result the glided palm is still arriving, so the reading is still well above zero.
    expect(trace[6]).toBeGreaterThan(50);
    // Well after the window plus the follower's settling time, it has stopped.
    expect(trace[trace.length - 1]).toBeLessThan(1);
    expect(HAND_MOTION_T.speedWindowMs).toBe(250);
  });

  it("glides every landmark between results: at 5, 10 and 17 Hz no render frame steps more than 3x the ideal step, and none stands still", () => {
    for (const hz of [5, 10, 17]) {
      const { frames } = play({ hz, vx: 0.5, duration: 6000 });
      const ideal = 0.5 / 60;
      let max = 0;
      let min = Infinity;
      for (let i = 1; i < frames.length; i++) {
        if (frames[i].t < 2000) continue;
        for (const lm of [LM.WRIST, LM.INDEX_TIP, LM.THUMB_TIP, LM.PINKY_TIP]) {
          const d = frames[i].hands[0].points[lm].x - frames[i - 1].hands[0].points[lm].x;
          max = Math.max(max, d / ideal);
          min = Math.min(min, d / ideal);
        }
      }
      expect(max).toBeLessThan(3);
      expect(min).toBeGreaterThan(0.3);
    }
  });

  it("reports fingertip velocities in stage units per second", () => {
    const { frames } = play({ hz: 10, vx: 0.4, vy: -0.2, duration: 3000 });
    const settled = frames.filter((f) => f.t >= 1500);
    let sx = 0;
    let sy = 0;
    for (const f of settled) {
      for (let k = 0; k < 5; k++) {
        const v = f.hands[0].tipVel[k];
        // Every tip of a rigidly moving hand has the hand's velocity, give or take the follower's ripple.
        expect(v.x).toBeGreaterThan(0.4 * 0.5);
        expect(v.x).toBeLessThan(0.4 * 1.5);
        expect(v.y).toBeLessThan(-0.2 * 0.5);
        expect(v.y).toBeGreaterThan(-0.2 * 1.5);
      }
      sx += f.hands[0].tipVel[1].x;
      sy += f.hands[0].tipVel[1].y;
    }
    expect(sx / settled.length).toBeCloseTo(0.4, 2);
    expect(sy / settled.length).toBeCloseTo(-0.2, 2);
  });

  it("a new id snaps instead of gliding from the old hand's position", () => {
    const m = new HandMotion();
    for (let t = 0; t <= 1000; t += 100) m.update(t, [hand(1, "A", 0.3, 0.5, t)], ASPECT, SPACE);
    m.snapshot(1000);
    expect(m.ageMs(1, 1000)).toBe(1000);

    // The assigner lost hand 1 and found a hand on the other side of the picture: a different id.
    const far = hand(2, "A", 0.75, 0.4, 1100);
    m.update(1100, [far], ASPECT, SPACE);
    const [k] = m.snapshot(1100);
    expect(k.id).toBe(2);
    expect(k.points[LM.INDEX_TIP].x).toBeCloseTo(far.obs.points[LM.INDEX_TIP].x, 12);
    expect(k.points[LM.WRIST].y).toBeCloseTo(far.obs.points[LM.WRIST].y, 12);
    expect(k.tipVel[1]).toEqual({ x: 0, y: 0 });
    expect(k.speedPx).toBe(0);
    // Mid-frame, still there: no glide in progress.
    const [mid] = m.snapshot(1150);
    expect(mid.points[LM.INDEX_TIP].x).toBeCloseTo(far.obs.points[LM.INDEX_TIP].x, 12);
    expect(m.ageMs(2, 1150)).toBe(50);
    expect(m.ageMs(1, 1150)).toBe(0);

    // The same id moving the same distance does glide.
    const g = new HandMotion();
    for (let t = 0; t <= 1000; t += 100) g.update(t, [hand(1, "A", 0.3, 0.5, t)], ASPECT, SPACE);
    g.snapshot(1000);
    const moved = hand(1, "A", 0.75, 0.4, 1100);
    g.update(1100, [moved], ASPECT, SPACE);
    const [glided] = g.snapshot(1150);
    expect(glided.points[LM.INDEX_TIP].x).toBeGreaterThan(0.3);
    expect(glided.points[LM.INDEX_TIP].x).toBeLessThan(moved.obs.points[LM.INDEX_TIP].x - 0.05);
  });

  it("drops an id that is no longer tracked, and keeps the others in result order", () => {
    const m = new HandMotion();
    const a = (t: number) => hand(1, "A", 0.3, 0.5, t);
    const b = (t: number) => hand(2, "B", 0.7, 0.5, t);
    m.update(0, [a(0), b(0)], ASPECT, SPACE);
    expect(m.snapshot(0).map((k) => k.id)).toEqual([1, 2]);
    m.update(100, [b(100), a(100)], ASPECT, SPACE);
    expect(m.snapshot(100).map((k) => k.id)).toEqual([2, 1]);
    m.update(200, [b(200)], ASPECT, SPACE);
    expect(m.snapshot(200).map((k) => k.id)).toEqual([2]);
    expect(m.ageMs(1, 200)).toBe(0);
    expect(m.ageMs(2, 200)).toBe(200);
    // The same id twice in one result counts once.
    m.update(300, [b(300), b(300)], ASPECT, SPACE);
    expect(m.snapshot(300)).toHaveLength(1);
    m.update(400, [], ASPECT, SPACE);
    expect(m.snapshot(400)).toEqual([]);
  });

  it("a coasting hand is marked, settles on its last observation and gets no lead", () => {
    const m = new HandMotion();
    let t = 0;
    for (; t <= 500; t += 100) m.update(t, [hand(1, "A", 0.3 + t * 0.0005, 0.5, t)], ASPECT, SPACE);
    m.snapshot(500);
    // The assigner repeats the last observation while the hand is coasting.
    const last = hand(1, "A", 0.3 + 500 * 0.0005, 0.5, 500);
    for (t = 600; t <= 900; t += 100) m.update(t, [{ ...last, fresh: false, lastSeen: 500 }], ASPECT, SPACE);
    const [k] = m.snapshot(600);
    expect(k.fresh).toBe(false);
    // Rendered every frame, as in the app. A point that stops being seen does not run on past
    // its last observation: no lead is added, and the momentum already in the follower's first
    // pole carries it at most a fraction of a pixel further before it settles.
    let rest = k;
    for (let r = 600; r <= 3000; r += 1000 / 60) {
      [rest] = m.snapshot(r);
      expect(rest.points[LM.INDEX_TIP].x).toBeLessThanOrEqual(last.obs.points[LM.INDEX_TIP].x + 1e-3);
    }
    for (let i = 0; i < 21; i++) {
      expect(rest.points[i].x).toBeCloseTo(last.obs.points[i].x, 9);
      expect(rest.points[i].y).toBeCloseTo(last.obs.points[i].y, 9);
    }
    expect(Math.abs(rest.tipVel[1].x)).toBeLessThan(1e-6);
    expect(rest.speedPx).toBeLessThan(1e-6);
  });

  it("snapshot returns fresh objects the caller may keep", () => {
    const { motion } = play({ hz: 10, vx: 0.2, duration: 1000 });
    const a = motion.snapshot(1000);
    const b = motion.snapshot(1000);
    expect(a).not.toBe(b);
    expect(a[0].points).not.toBe(b[0].points);
    expect(a[0].points[3]).toEqual(b[0].points[3]);
    expect(a[0].speedPx).toBe(b[0].speedPx);
    // Mutating what was returned does not affect the next snapshot.
    a[0].points[LM.INDEX_TIP].x = 99;
    expect(motion.snapshot(1000)[0].points[LM.INDEX_TIP].x).toBeLessThan(1);
  });

  it("ignores a hand with incomplete or non-finite landmarks", () => {
    const m = new HandMotion();
    const h = hand(1, "A", 0.3, 0.5, 0);
    const broken: TrackedHand = { ...h, id: 2, obs: { ...h.obs, points: h.obs.points.slice(0, 20) } };
    const nan: TrackedHand = { ...h, id: 3, obs: { ...h.obs, points: h.obs.points.map((p, i) => (i === 8 ? { x: Number.NaN, y: p.y, z: p.z } : p)) } };
    m.update(0, [h, broken, nan], ASPECT, SPACE);
    expect(m.snapshot(0).map((k) => k.id)).toEqual([1]);
  });

  it("reset forgets every hand, and a hand seen again afterwards starts clean even on an earlier clock", () => {
    const m = new HandMotion();
    for (let t = 0; t <= 5000; t += 100) m.update(t, [hand(1, "A", 0.3, 0.5, t), hand(2, "B", 0.7, 0.5, t)], ASPECT, SPACE);
    m.snapshot(5000);
    m.reset();
    expect(m.snapshot(5000)).toEqual([]);
    expect(m.ageMs(1, 5000)).toBe(0);

    // A replay from time 0 (the clock of a new recording, or a test): the recycled followers must glide, not stay frozen.
    m.update(0, [hand(1, "A", 0.3, 0.5, 0)], ASPECT, SPACE);
    const before = hand(1, "A", 0.3, 0.5, 0).obs.points[LM.WRIST].x;
    const after = hand(1, "A", 0.4, 0.5, 100).obs.points[LM.WRIST].x;
    expect(m.snapshot(0)[0].points[LM.WRIST].x).toBeCloseTo(before, 12);
    m.update(100, [hand(1, "A", 0.4, 0.5, 100)], ASPECT, SPACE);
    const [k] = m.snapshot(150);
    expect(k.points[LM.WRIST].x).toBeGreaterThan(before + 0.01);
    expect(k.points[LM.WRIST].x).toBeLessThan(after - 0.01);
    expect(m.ageMs(1, 150)).toBe(150);
  });
});
