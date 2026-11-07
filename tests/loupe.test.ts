/**
 * The OK-sign loupe, driven by real poses: synthetic hands → classifyHand → classifyPose →
 * LoupeController, at 5, 10 and 17 Hz.
 */
import { describe, expect, it } from "vitest";
import { classifyHand, type HandShape } from "../src/gestures/classifier";
import { classifyPose } from "../src/gestures/poses";
import type { HandRole } from "../src/tracking/handAssignment";
import { LM, palmCenter, type HandObservation } from "../src/tracking/landmarks";
import { syntheticHand, type SyntheticHandPose } from "../src/tracking/syntheticHand";
import { lPose, okPose, openPose } from "../src/tracking/syntheticPoses";
import { LOUPE_T, LoupeController } from "../src/toy/LoupeController";
import type { HandPose, HandSample } from "../src/toy/types";

const ASPECT = 16 / 9;
const RATES = [5, 10, 17];
type Src = SyntheticHandPose | HandObservation;
const obsOf = (s: Src): HandObservation => ("points" in s ? s : syntheticHand(s, ASPECT));

interface HandIn {
  id: number;
  role: HandRole;
  src: Src;
  fresh?: boolean;
}

/** Plays tracking results through the classifier chain (one history per hand id) and the loupe controller. */
class Rig {
  t = 0;
  readonly dt: number;
  readonly loupes: LoupeController;
  private readonly shapes = new Map<number, HandShape>();
  private readonly poses = new Map<number, HandPose>();
  private readonly born = new Map<number, number>();

  constructor(hz: number, loupes = new LoupeController()) {
    this.dt = 1000 / hz;
    this.loupes = loupes;
  }

  samples(hands: HandIn[]): HandSample[] {
    const t = this.t;
    const seen = new Set<number>();
    const out = hands.map((h) => {
      seen.add(h.id);
      const fresh = h.fresh ?? true;
      const obs = obsOf(h.src);
      if (!this.born.has(h.id)) this.born.set(h.id, t);
      let pose = this.poses.get(h.id);
      if (fresh || !pose) {
        const shape = classifyHand(obs.world, this.shapes.get(h.id));
        this.shapes.set(h.id, shape);
        pose = classifyPose(obs, shape, ASPECT, t, pose);
        this.poses.set(h.id, pose);
      }
      return { id: h.id, role: h.role, fresh, ageMs: t - this.born.get(h.id)!, points: obs.points, palm: palmCenter(obs.points), pose };
    });
    for (const id of [...this.born.keys()]) {
      if (!seen.has(id)) {
        this.born.delete(id);
        this.shapes.delete(id);
        this.poses.delete(id);
      }
    }
    return out;
  }

  /** One result at the current time (plus a render frame at that time); advances the clock. */
  step(hands: HandIn[], enabled = true) {
    const t = this.t;
    const samples = this.samples(hands);
    this.loupes.update(t, samples, enabled, ASPECT);
    const snap = this.loupes.snapshot(t);
    this.t += this.dt;
    return { t, samples, snap };
  }

  /** Results of the same input for `ms`, rendering at 60 fps in between. Returns the last snapshot. */
  holdMs(hands: HandIn[], ms: number, enabled = true) {
    const until = this.t + ms;
    let snap = this.loupes.snapshot(this.t);
    let render = this.t;
    while (this.t < until) {
      const r = this.step(hands, enabled);
      snap = r.snap;
      for (render = r.t + 1000 / 60; render < this.t && render < until; render += 1000 / 60) snap = this.loupes.snapshot(render);
    }
    return snap;
  }
}

const OK_B: HandIn = { id: 2, role: "B", src: okPose("B") };
const L_A: HandIn = { id: 1, role: "A", src: lPose("A") };

describe("switching", () => {
  it("comes on after two consecutive OK results at 5 / 10 / 17 Hz", () => {
    for (const hz of RATES) {
      const rig = new Rig(hz);
      rig.holdMs([L_A, { id: 2, role: "B", src: lPose("B") }], 600);
      expect(rig.step([L_A, OK_B]).snap, `${hz} Hz: one OK result`).toHaveLength(0);
      const second = rig.step([L_A, OK_B]);
      // Switched on at this result: visible from the next render frame on.
      const next = rig.loupes.snapshot(second.t + 16);
      expect(next, `${hz} Hz`).toHaveLength(1);
      expect(next[0].handId).toBe(2);
      expect(next[0].visibility).toBeGreaterThan(0);
      expect(next[0].zoom).toBe(LOUPE_T.zoom);
      const settled = rig.holdMs([L_A, OK_B], 600);
      expect(settled).toHaveLength(1);
      expect(settled[0].visibility).toBe(1);
    }
  });

  it("goes off after two results with the pinch opened", () => {
    for (const hz of RATES) {
      const rig = new Rig(hz);
      rig.holdMs([L_A, OK_B], 1000);
      const open: HandIn = { id: 2, role: "B", src: openPose("B") };
      const one = rig.step([L_A, open]);
      expect(rig.loupes.snapshot(one.t + 10)[0]?.visibility, `${hz} Hz: one open result`).toBe(1);
      const two = rig.step([L_A, open]);
      const fading = rig.loupes.snapshot(two.t + 16);
      expect(fading, `${hz} Hz`).toHaveLength(1);
      expect(fading[0].visibility).toBeLessThan(1);
      expect(rig.holdMs([L_A, open], 700)).toHaveLength(0);
    }
  });

  it("goes off 250 ms after the last OK when the hand is not seen", () => {
    for (const hz of RATES) {
      const rig = new Rig(hz);
      rig.holdMs([L_A, OK_B], 1000);
      const lastOk = rig.t - rig.dt;
      const coasting: HandIn = { ...OK_B, fresh: false };
      let offAt = -1;
      while (rig.t < lastOk + 1000) {
        const { t } = rig.step([L_A, coasting]);
        const s = rig.loupes.snapshot(t + 1);
        if (s.length === 0 || s[0].visibility < 1) {
          offAt = t;
          break;
        }
      }
      expect(offAt, `${hz} Hz`).toBeGreaterThanOrEqual(lastOk + LOUPE_T.offMs);
      expect(offAt, `${hz} Hz`).toBeLessThan(lastOk + LOUPE_T.offMs + rig.dt);
    }
  });

  it("goes off and is forgotten when the track is gone", () => {
    const rig = new Rig(10);
    rig.holdMs([L_A, OK_B], 1000);
    const { t } = rig.step([L_A]);
    expect(rig.loupes.snapshot(t + 16)[0].visibility).toBeLessThan(1);
    expect(rig.holdMs([L_A], 600)).toHaveLength(0);
    // A new track with the same id starts from scratch: two OK results again.
    expect(rig.step([L_A, OK_B]).snap).toHaveLength(0);
  });

  it("a single OK result between other poses does nothing", () => {
    const rig = new Rig(10);
    const l: HandIn = { id: 2, role: "B", src: lPose("B") };
    rig.holdMs([L_A, l], 500);
    rig.step([L_A, OK_B]);
    expect(rig.holdMs([L_A, l], 500)).toHaveLength(0);
  });

  it("is off outside effect frame and needs two OK results again when re-enabled", () => {
    const rig = new Rig(10);
    rig.holdMs([L_A, OK_B], 1000);
    expect(rig.holdMs([L_A, OK_B], 600, false)).toHaveLength(0);
    expect(rig.step([L_A, OK_B]).snap).toHaveLength(0);
    rig.step([L_A, OK_B]);
    expect(rig.loupes.snapshot(rig.t)).toHaveLength(1);
  });

  it("one loupe per OK hand, at most two", () => {
    const rig = new Rig(10);
    const okA: HandIn = { id: 1, role: "A", src: okPose("A") };
    const snap = rig.holdMs([okA, OK_B], 800);
    expect(snap).toHaveLength(2);
    expect(snap.map((l) => l.handId).sort()).toEqual([1, 2]);
    const three = rig.holdMs([okA, OK_B, { id: 3, role: "B", src: okPose("B", { x: 0.8 }) }], 800);
    expect(three).toHaveLength(2);
  });
});

describe("geometry", () => {
  it("centre is the ring centroid, settled from the first result", () => {
    const rig = new Rig(10);
    rig.holdMs([L_A, OK_B], 600);
    const { samples, snap } = rig.step([L_A, OK_B]);
    const ring = samples[1].pose.ring!.center;
    expect(snap[0].center.x).toBeCloseTo(ring.x, 9);
    expect(snap[0].center.y).toBeCloseTo(ring.y, 9);
    // The ring sits inside the outline of thumb and index finger.
    const p = samples[1].points;
    const outline = [LM.THUMB_TIP, LM.THUMB_IP, LM.THUMB_MCP, LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP];
    expect(snap[0].center.x).toBeGreaterThan(Math.min(...outline.map((i) => p[i].x)));
    expect(snap[0].center.x).toBeLessThan(Math.max(...outline.map((i) => p[i].x)));
    expect(snap[0].center.y).toBeGreaterThan(Math.min(...outline.map((i) => p[i].y)));
    expect(snap[0].center.y).toBeLessThan(Math.max(...outline.map((i) => p[i].y)));
  });

  it("falls back to the middle of the pinch point and the web when the pose has no ring", () => {
    const lc = new LoupeController();
    const rig = new Rig(10, lc);
    const samples = rig.samples([OK_B]);
    const stripped: HandSample = { ...samples[0], pose: { ...samples[0].pose, ring: null } };
    lc.update(0, [stripped], true, ASPECT);
    lc.snapshot(0);
    lc.update(100, [{ ...stripped, pose: { ...stripped.pose, at: 100 } }], true, ASPECT);
    const [l] = lc.snapshot(116);
    expect(l).toBeDefined();
    const p = stripped.points;
    const want = {
      x: (p[LM.THUMB_TIP].x + p[LM.INDEX_TIP].x + p[LM.THUMB_MCP].x + p[LM.INDEX_MCP].x) / 4,
      y: (p[LM.THUMB_TIP].y + p[LM.INDEX_TIP].y + p[LM.THUMB_MCP].y + p[LM.INDEX_MCP].y) / 4,
    };
    expect(l.center.x).toBeCloseTo(want.x, 9);
    expect(l.center.y).toBeCloseTo(want.y, 9);
  });

  it("radius is 0.9 × hand size, clamped to 0.08–0.22 frame heights", () => {
    const radiusFor = (size: number) => {
      const rig = new Rig(10);
      const snap = rig.holdMs([{ id: 2, role: "B", src: okPose("B", { size }) }], 800);
      expect(snap).toHaveLength(1);
      return snap[0].radius;
    };
    // The synthetic hand's s2 is 0.9994 × its size.
    expect(radiusFor(0.16)).toBeCloseTo(0.9 * 0.16, 3);
    expect(radiusFor(0.05)).toBeCloseTo(LOUPE_T.radiusMin, 9);
    expect(radiusFor(0.3)).toBeCloseTo(LOUPE_T.radiusMax, 9);
  });

  it("radius follows a size change through a 120 ms low-pass", () => {
    const rig = new Rig(10);
    rig.holdMs([{ id: 2, role: "B", src: okPose("B", { size: 0.16 }) }], 800);
    const t0 = rig.t;
    rig.step([{ id: 2, role: "B", src: okPose("B", { size: 0.22 }) }]);
    const r0 = 0.9 * 0.16;
    const r1 = 0.9 * 0.22;
    const after = rig.loupes.snapshot(t0 + LOUPE_T.radiusTauMs)[0].radius;
    const k = (after - r0) / (r1 - r0);
    expect(k).toBeGreaterThan(0.55);
    expect(k).toBeLessThan(0.7);
    expect(rig.holdMs([{ id: 2, role: "B", src: okPose("B", { size: 0.22 }) }], 1000)[0].radius).toBeCloseTo(r1, 3);
  });

  it("centre glides: render frames between results move without jumping", () => {
    const rig = new Rig(10);
    rig.holdMs([{ id: 2, role: "B", src: okPose("B", { x: 0.5 }) }], 800);
    const xs: number[] = [];
    const speed = 0.3 / 1000;
    const t0 = rig.t;
    let next = t0;
    for (let t = t0; t <= t0 + 1500; t += 1000 / 60) {
      while (next <= t) {
        rig.t = next;
        rig.step([{ id: 2, role: "B", src: okPose("B", { x: 0.5 + speed * (next - t0) }) }]);
        next += rig.dt;
      }
      xs.push(rig.loupes.snapshot(t)[0].center.x);
    }
    const steps = xs.slice(20).map((x, i) => x - xs[i + 19]);
    const ideal = (speed * 1000) / 60;
    for (const s of steps) {
      expect(s).toBeGreaterThanOrEqual(-1e-9);
      expect(s).toBeLessThan(3 * ideal);
    }
  });
});

describe("fades, zoom and reset", () => {
  it("visibility rises and falls monotonically", () => {
    const rig = new Rig(10);
    rig.holdMs([L_A, { id: 2, role: "B", src: lPose("B") }], 500);
    rig.step([L_A, OK_B]);
    const { t } = rig.step([L_A, OK_B]);
    const up: number[] = [];
    for (let tt = t + 16; tt < t + 100; tt += 16) up.push(rig.loupes.snapshot(tt)[0].visibility);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThan(up[i - 1]);
    expect(up[up.length - 1]).toBeGreaterThan(0.9);
    rig.holdMs([L_A, OK_B], 300);
    const open: HandIn = { id: 2, role: "B", src: openPose("B") };
    rig.step([L_A, open]);
    const off = rig.step([L_A, open]).t;
    const down: number[] = [];
    for (let tt = off + 16; tt < off + 140; tt += 16) down.push(rig.loupes.snapshot(tt)[0].visibility);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThan(down[i - 1]);
  });

  it("zoom defaults to 2, is settable and clamped to the setting's range", () => {
    const lc = new LoupeController();
    const rig = new Rig(10, lc);
    expect(rig.holdMs([OK_B], 600)[0].zoom).toBe(2);
    lc.setZoom(2.5);
    expect(lc.snapshot(rig.t)[0].zoom).toBe(2.5);
    lc.setZoom(10);
    expect(lc.snapshot(rig.t)[0].zoom).toBe(LOUPE_T.zoomMax);
    lc.setZoom(0.2);
    expect(lc.snapshot(rig.t)[0].zoom).toBe(LOUPE_T.zoomMin);
    lc.setZoom(Number.NaN);
    expect(lc.snapshot(rig.t)[0].zoom).toBe(LOUPE_T.zoomMin);
    const custom = new Rig(10, new LoupeController({ zoom: 1.8 }));
    expect(custom.holdMs([OK_B], 600)[0].zoom).toBe(1.8);
  });

  it("reset() forgets every loupe", () => {
    const lc = new LoupeController();
    const rig = new Rig(10, lc);
    rig.holdMs([OK_B], 600);
    lc.reset();
    expect(lc.snapshot(rig.t)).toHaveLength(0);
    expect(rig.step([OK_B]).snap).toHaveLength(0);
  });
});
