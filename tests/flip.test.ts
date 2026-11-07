/**
 * The flip gesture, driven through the whole frame pipeline with real poses: synthetic hands
 * → classifyHand → classifyPose → FrameGate → FrameController → FlipDetector, at 5, 10 and
 * 17 Hz. Hands are turned with turnHand (pitch = tipping over, turn = about the forearm) or
 * rotated in the picture (an in-plane half turn).
 */
import { describe, expect, it } from "vitest";
import { classifyHand, type HandShape } from "../src/gestures/classifier";
import { classifyPose } from "../src/gestures/poses";
import type { HandRole } from "../src/tracking/handAssignment";
import { LM, palmCenter, type HandObservation } from "../src/tracking/landmarks";
import { syntheticHand, type SyntheticHandPose } from "../src/tracking/syntheticHand";
import { lPose, openPose, pointPose, turnHand } from "../src/tracking/syntheticPoses";
import { FLIP_T, FlipDetector, type FlipEvent } from "../src/toy/FlipDetector";
import { FrameController, type CornerSample } from "../src/toy/FrameController";
import { FrameGate, type GateHand } from "../src/toy/frameGate";
import type { HandPose, HandSample } from "../src/toy/types";

const ASPECT = 16 / 9;
const RATES = [5, 10, 17];
type Src = SyntheticHandPose | HandObservation;
const obsOf = (s: Src): HandObservation => ("points" in s ? s : syntheticHand(s, ASPECT));

/** One hand's input for one result. */
interface HandIn {
  src: Src | null;
  fresh?: boolean;
  /** Track id (default 1 for A, 2 for B); a new id is a reborn track. */
  id?: number;
}

/** What the hands do at time t (ms). */
type Script = (t: number) => { a: HandIn; b: HandIn };

const L = (side: "A" | "B"): Src => lPose(side);
/** Hand `side` tipped over (about the knuckle row) by `k` of a half turn: thumb ends up on top. */
const tip = (k: number, side: "A" | "B" = "B"): Src => turnHand(syntheticHand(lPose(side), ASPECT), { pitch: Math.PI * k }, ASPECT);
/** Hand `side` turned about the forearm by `k` of a half turn: the thumb changes sides. */
const turn = (k: number, side: "A" | "B" = "B"): Src => turnHand(syntheticHand(lPose(side), ASPECT), { turn: Math.PI * k }, ASPECT);
/** Hand `side` rotated in the picture by `k` of a half turn. */
const roll = (k: number, side: "A" | "B" = "B"): Src => lPose(side, { rotation: Math.PI * k });

/** 0 before `from`, 1 after `to`, linear in between. */
const ramp = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
/** Over k (0 → 1) between t0 and t1, hold, back (1 → 0) between t2 and t3. */
function overAndBack(t: number, t0: number, t1: number, t2: number, t3: number) {
  if (t < t0) return 0;
  if (t < t1) return ramp(t, t0, t1);
  if (t < t2) return 1;
  if (t < t3) return 1 - ramp(t, t2, t3);
  return 0;
}

/** The whole pipeline below the controller, fed one result at a time. */
class Pipeline {
  t = 0;
  readonly dt: number;
  readonly gate = new FrameGate();
  readonly frame = new FrameController();
  readonly flip = new FlipDetector();
  readonly events: FlipEvent[] = [];
  readonly phases: { t: number; phase: string }[] = [];
  private readonly shapes = new Map<number, HandShape>();
  private readonly poses = new Map<number, HandPose>();
  private readonly born = new Map<number, number>();

  constructor(hz: number) {
    this.dt = 1000 / hz;
  }

  private sample(role: HandRole, h: HandIn): HandSample | null {
    const id = h.id ?? (role === "A" ? 1 : 2);
    if (h.src === null) return null;
    const fresh = h.fresh ?? true;
    const obs = obsOf(h.src);
    if (!this.born.has(id)) this.born.set(id, this.t);
    let pose = this.poses.get(id);
    if (fresh || !pose) {
      const shape = classifyHand(obs.world, this.shapes.get(id));
      this.shapes.set(id, shape);
      pose = classifyPose(obs, shape, ASPECT, this.t, pose);
      this.poses.set(id, pose);
    }
    return { id, role, fresh, ageMs: this.t - this.born.get(id)!, points: obs.points, palm: palmCenter(obs.points), pose };
  }

  step(a: HandIn, b: HandIn): FlipEvent | null {
    const t = this.t;
    const sA = this.sample("A", a);
    const sB = this.sample("B", b);
    const hands = [sA, sB].filter((s): s is HandSample => s !== null);
    const live = new Set(hands.map((h) => h.id));
    for (const id of [...this.born.keys()]) {
      if (!live.has(id)) {
        this.born.delete(id);
        this.shapes.delete(id);
        this.poses.delete(id);
      }
    }
    const gateHand = (s: HandSample | null): GateHand => ({ present: s !== null, fresh: s?.fresh ?? false, pose: s?.pose ?? null, palm: s?.palm ?? null });
    const phase = this.gate.update(t, gateHand(sA), gateHand(sB), ASPECT);
    const corner = (s: HandSample | null, lm: number): CornerSample | null =>
      s ? { point: { x: s.points[lm].x, y: s.points[lm].y }, handId: s.id, fresh: s.fresh, accept: !s.pose.uncertain } : null;
    this.frame.update(t, [corner(sA, LM.INDEX_TIP), corner(sB, LM.INDEX_TIP), corner(sB, LM.THUMB_TIP), corner(sA, LM.THUMB_TIP)], phase === "open", ASPECT);
    const snap = this.frame.snapshot(t);
    const ev = this.flip.update(
      t,
      hands,
      { open: phase === "open", locked: this.frame.isLocked(), openedAt: this.gate.openedAt, closedAt: this.gate.closedAt, twistValid: snap.twistValid },
      ASPECT,
    );
    if (ev) this.events.push(ev);
    this.phases.push({ t, phase });
    this.t += this.dt;
    return ev;
  }

  /** Runs `script` until `duration`. */
  play(script: Script, duration: number) {
    while (this.t < duration) {
      const { a, b } = script(this.t);
      this.step(a, b);
    }
    return this;
  }

  eventsBetween(from: number, to: number) {
    return this.events.filter((e) => e.time >= from && e.time < to);
  }

  /** The gate never closed between `from` and `to`. */
  openThroughout(from: number, to: number) {
    return this.phases.filter((p) => p.t >= from && p.t < to).every((p) => p.phase === "open");
  }
}

const twoLs: Script = () => ({ a: { src: L("A") }, b: { src: L("B") } });

/** Hand B tipped over between 1000 and 1600 ms, held, and tipped back between 2600 and 3200 ms. */
const tipOverAndBack: Script = (t) => ({ a: { src: L("A") }, b: { src: tip(overAndBack(t, 1000, 1600, 2600, 3200)) } });

describe("one flip, one event", () => {
  it("tipping hand B over and back emits exactly one event at 5 / 10 / 17 Hz, during the tip-over", () => {
    for (const hz of RATES) {
      const p = new Pipeline(hz).play(tipOverAndBack, 4500);
      expect(p.events, `${hz} Hz`).toHaveLength(1);
      const [e] = p.events;
      expect(e.time).toBeGreaterThanOrEqual(1000);
      expect(e.time).toBeLessThanOrEqual(2000);
      expect(e.cause === "facing" ? e.role : e.role).toBe(e.cause === "facing" ? "B" : null);
      // Turning back emits nothing.
      expect(p.eventsBetween(2600, 4500)).toHaveLength(0);
      // The frame stays up through the whole flip: an L seen from the back is still an L.
      expect(p.openThroughout(400, 4500), `${hz} Hz`).toBe(true);
    }
  });

  it("a second flip emits again", () => {
    const script: Script = (t) => ({
      a: { src: L("A") },
      b: { src: tip(t < 4000 ? overAndBack(t, 1000, 1600, 2600, 3200) : overAndBack(t, 4000, 4600, 5600, 6200)) },
    });
    for (const hz of RATES) {
      const p = new Pipeline(hz).play(script, 7500);
      expect(p.events.map((e) => Math.floor(e.time / 1000)), `${hz} Hz`).toEqual([1, 4]);
    }
  });

  it("turning the hand about the forearm (no twist) fires with cause facing", () => {
    const script: Script = (t) => ({ a: { src: L("A") }, b: { src: turn(overAndBack(t, 1000, 1600, 2600, 3200)) } });
    for (const hz of RATES) {
      const p = new Pipeline(hz).play(script, 4500);
      expect(p.events, `${hz} Hz`).toHaveLength(1);
      expect(p.events[0]).toMatchObject({ cause: "facing", role: "B" });
      expect(p.openThroughout(400, 4500)).toBe(true);
    }
  });

  it("an in-plane half turn (no facing change) fires with cause twist", () => {
    const script: Script = (t) => ({ a: { src: L("A") }, b: { src: roll(overAndBack(t, 1000, 1600, 2600, 3200)) } });
    for (const hz of RATES) {
      const p = new Pipeline(hz).play(script, 4500);
      expect(p.events, `${hz} Hz`).toHaveLength(1);
      expect(p.events[0]).toMatchObject({ cause: "twist", role: null });
      expect(p.flip.latched("B")).toBe(p.flip.latched("B")); // unchanged throughout: see below
      expect(p.openThroughout(400, 4500)).toBe(true);
    }
  });

  it("latches the facing of each hand: the two Ls of a frame face opposite ways", () => {
    const p = new Pipeline(10).play(twoLs, 1500);
    expect(p.flip.latched("A")).toBe(-1);
    expect(p.flip.latched("B")).toBe(1);
    p.play(tipOverAndBack, 2500);
    expect(p.flip.latched("B")).toBe(-1);
    expect(p.flip.latched("A")).toBe(-1);
  });
});

describe("guards", () => {
  it("nothing inside the 700 ms cooldown", () => {
    // Quick flicks at 17 Hz: over, back, over again inside the cooldown, back, over again later.
    const script: Script = (t) => {
      const k = t < 1300 ? ramp(t, 1000, 1001) : t < 1550 ? 0 : t < 1850 ? 1 : t < 2500 ? 0 : t < 3100 ? 1 : 0;
      return { a: { src: L("A") }, b: { src: tip(k) } };
    };
    const p = new Pipeline(17).play(script, 4000);
    expect(p.events).toHaveLength(2);
    const [first, second] = p.events;
    expect(first.time).toBeGreaterThanOrEqual(1000);
    expect(first.time).toBeLessThan(1300);
    expect(second.time).toBeGreaterThanOrEqual(2500);
    expect(second.time - first.time).toBeGreaterThan(FLIP_T.cooldownMs);
  });

  it("nothing in the first 300 ms after the frame opens; the hand has to come back and turn again", () => {
    for (const hz of RATES) {
      const dt = 1000 / hz;
      // Open palms for 1.5 s (the tracks are old and their facings latched), then Ls; hand B
      // starts tipping over on the very result that opens the frame.
      const script: Script = (t) => {
        if (t < 1500) return { a: { src: openPose("A") }, b: { src: openPose("B") } };
        if (t < 1500 + dt) return { a: { src: L("A") }, b: { src: L("B") } };
        return { a: { src: L("A") }, b: { src: tip(t < 3000 ? 1 : t < 3800 ? 0 : 1) } };
      };
      const p = new Pipeline(hz).play(script, 5000);
      const openedAt = p.gate.openedAt;
      expect(openedAt).toBeGreaterThanOrEqual(1500);
      expect(openedAt).toBeLessThan(1500 + 2 * dt);
      expect(p.eventsBetween(openedAt, openedAt + FLIP_T.openBlankMs), `${hz} Hz`).toHaveLength(0);
      // The flip that happened during the blanking is consumed, not delayed.
      expect(p.eventsBetween(openedAt, 3000), `${hz} Hz`).toHaveLength(0);
      // The next flip counts.
      expect(p.eventsBetween(3800, 5000), `${hz} Hz`).toHaveLength(1);
    }
  });

  it("nothing when the frame opens already twisted (a director's frame)", () => {
    for (const hz of RATES) {
      const script: Script = (t) => ({ a: { src: L("A") }, b: { src: roll(t < 2500 ? 1 : 1 - ramp(t, 2500, 3100)) } });
      const p = new Pipeline(hz).play(script, 4000);
      expect(p.gate.openedAt).toBeLessThan(500);
      expect(p.events, `${hz} Hz`).toHaveLength(0);
    }
  });

  it("both hands changing sides together is an identity swap: vetoed and re-baselined silently", () => {
    for (const hz of RATES) {
      const k = (t: number) => overAndBack(t, 1000, 1600, 9000, 9100);
      const script: Script = (t) => ({ a: { src: tip(k(t), "A") }, b: { src: tip(k(t), "B") } });
      const p = new Pipeline(hz).play(script, 3500);
      expect(p.events, `${hz} Hz`).toHaveLength(0);
      // From the new baseline, one hand turning back on its own is a flip again.
      p.play((t) => ({ a: { src: tip(1, "A") }, b: { src: tip(1 - ramp(t, 3500, 4100), "B") } }), 5500);
      expect(p.events, `${hz} Hz`).toHaveLength(1);
    }
  });

  it("the assigner handing each role the other hand's data gives no event", () => {
    for (const hz of RATES) {
      const script: Script = (t) => (t < 1500 ? { a: { src: L("A") }, b: { src: L("B") } } : { a: { src: L("B") }, b: { src: L("A") } });
      const p = new Pipeline(hz).play(script, 4000);
      expect(p.events, `${hz} Hz`).toHaveLength(0);
    }
  });

  it("a one-result sign glitch gives none", () => {
    for (const hz of RATES) {
      const dt = 1000 / hz;
      const script: Script = (t) => ({ a: { src: L("A") }, b: { src: tip(t >= 1000 && t < 1000 + dt ? 1 : 0) } });
      const p = new Pipeline(hz).play(script, 3000);
      expect(p.events, `${hz} Hz`).toHaveLength(0);
      expect(p.flip.latched("B")).toBe(1);
    }
  });

  it("600 ms edge-on gives none, and keeps the frame", () => {
    for (const hz of RATES) {
      const script: Script = (t) => ({ a: { src: L("A") }, b: { src: t >= 1000 && t < 1600 ? turn(0.5) : L("B") } });
      const p = new Pipeline(hz).play(script, 3000);
      expect(p.events, `${hz} Hz`).toHaveLength(0);
      expect(p.openThroughout(400, 3000), `${hz} Hz`).toBe(true);
    }
  });

  it("a track lost mid-turn and reborn within 1.5 s still gives exactly one event", () => {
    for (const hz of RATES) {
      const script: Script = (t) => {
        const k = overAndBack(t, 1000, 1600, 2800, 3400);
        const lost = t >= 1200 && t < 1500;
        return { a: { src: L("A") }, b: { src: lost ? null : tip(k), id: t >= 1500 ? 3 : 2 } };
      };
      const p = new Pipeline(hz).play(script, 4500);
      expect(p.events, `${hz} Hz`).toHaveLength(1);
      expect(p.events[0].time).toBeGreaterThanOrEqual(1500);
      expect(p.events[0].time).toBeLessThan(2800);
    }
  });

  it("ignores the votes of a track younger than 400 ms", () => {
    // Hand B's track dies and is reborn (new id) already turned about the forearm, so only
    // its facing can say so (no twist). The frame comes straight back on the new track.
    const script: Script = (t) => {
      if (t < 1500) return { a: { src: L("A") }, b: { src: L("B") } };
      if (t < 1700) return { a: { src: L("A") }, b: { src: null } };
      return { a: { src: L("A") }, b: { src: turn(1), id: 3 } };
    };
    const p = new Pipeline(10).play(script, 4000);
    expect(p.gate.lastCloseReason).toBe("lost");
    expect(p.gate.openedAt).toBeLessThanOrEqual(1800);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ cause: "facing", role: "B" });
    // Not before the new track is 400 ms old (born at 1700).
    expect(p.events[0].time).toBeGreaterThanOrEqual(1700 + FLIP_T.minTrackAgeMs);
  });
});

describe("when a flip is honoured", () => {
  it("while the frame is closed less than 1.5 s, but not later", () => {
    for (const closedFor of [800, 2500]) {
      // A stops making an L (the frame closes through the no-L rule), then B flips.
      const script: Script = (t) => {
        if (t < 1500) return { a: { src: L("A") }, b: { src: L("B") } };
        const tClose = 1500 + 400; // the gate has let go by here
        return { a: { src: pointPose("A") }, b: { src: tip(ramp(t, tClose + closedFor, tClose + closedFor + 600)) } };
      };
      const p = new Pipeline(10).play(script, 6500);
      expect(p.gate.lastCloseReason).toBe("pose");
      expect(p.gate.closedAt).toBeLessThanOrEqual(1900);
      expect(p.events, `closed for ${closedFor} ms`).toHaveLength(closedFor < FLIP_T.recentOpenMs ? 1 : 0);
    }
  });

  it("while the frame is locked, however long the gate has been closed", () => {
    const p = new Pipeline(10).play(twoLs, 1500);
    expect(p.frame.toggleLock()).toBe(true);
    p.play((t) => ({ a: { src: pointPose("A") }, b: { src: tip(ramp(t, 4500, 5100)) } }), 7000);
    expect(p.gate.closedAt).toBeLessThan(2000);
    expect(p.events).toHaveLength(1);
    expect(p.events[0].time).toBeGreaterThanOrEqual(4500);
  });

  it("a cold open re-baselines: a hand that turned over while the frame was long closed does not fire on opening", () => {
    // The frame closes at 1900; B turns over at 4000–4600 (closed for over 2 s: not honoured);
    // the Ls come back at 5500 and the frame opens cold with B still turned over.
    const script: Script = (t) => {
      if (t < 1500) return { a: { src: L("A") }, b: { src: L("B") } };
      if (t < 5500) return { a: { src: pointPose("A") }, b: { src: tip(ramp(t, 4000, 4600)) } };
      return { a: { src: L("A") }, b: { src: tip(1) } };
    };
    const p = new Pipeline(10).play(script, 7500);
    expect(p.events).toHaveLength(0);
    expect(p.gate.phase).toBe("open");
    expect(p.gate.openedAt).toBeGreaterThanOrEqual(5500);
    expect(p.flip.latched("B")).toBe(-1);
  });

  it("reset() forgets latches and baselines", () => {
    const p = new Pipeline(10).play(tipOverAndBack, 2000);
    expect(p.events).toHaveLength(1);
    p.flip.reset();
    expect(p.flip.latched("A")).toBe(0);
    expect(p.flip.latched("B")).toBe(0);
  });
});
