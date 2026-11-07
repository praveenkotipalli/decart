import { describe, expect, it } from "vitest";
import { DEFAULT_GLIDE, GLIDE_T, PointGlide, type GlideOptions } from "../src/tracking/glide";

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

const Y = 0.5;
const X0 = 0.1;

interface Run {
  /** Tracking rate. */
  hz: number;
  /** Speed of the point along x, stage units per second. */
  speed: number;
  /** ms */
  duration: number;
  /** Render times; default a 60 fps grid. */
  times?: number[];
  /**
   * Inference latency as a fraction of the tracking interval. As in the engine, a result
   * is fed when it arrives but stamped with the time its camera frame was taken.
   */
  latency?: number;
  /** Random variation of intervals and latency, ± this fraction. */
  jitter?: number;
  /** The point stops dead at this time. */
  stopAt?: number;
  /** Results the tracker never delivers (by index). */
  drop?: (k: number) => boolean;
  /** Results in which the point was not observed (by index). */
  coasting?: (k: number) => boolean;
  options?: Partial<GlideOptions>;
  seed?: number;
}

const grid = (fps: number, duration: number) => {
  const times: number[] = [];
  for (let j = 0; (j * 1000) / fps <= duration; j++) times.push((j * 1000) / fps);
  return times;
};

/** Plays a point through a tracker and a renderer and returns the glided position at every render time. */
function play(run: Run) {
  const interval = 1000 / run.hz;
  const jitter = run.jitter ?? 0;
  const rand = mulberry32(run.seed ?? 1);
  const stopAt = run.stopAt ?? Infinity;
  const truth = (t: number) => X0 + (run.speed / 1000) * Math.min(t, stopAt);

  const results: { taken: number; arrives: number; x: number; fresh: boolean }[] = [];
  for (let taken = 3, k = 0; taken < run.duration; k++) {
    const latency = interval * (run.latency ?? 0) * (1 + jitter * (rand() * 2 - 1));
    if (!run.drop?.(k)) results.push({ taken, arrives: taken + latency, x: truth(taken), fresh: !run.coasting?.(k) });
    // The tracker takes its next frame when it is free again, never before.
    taken = Math.max(taken + interval * (1 + jitter * (rand() * 2 - 1)), taken + latency);
  }

  const glide = new PointGlide(run.options);
  const frames: { t: number; x: number; y: number }[] = [];
  let next = 0;
  for (const t of run.times ?? grid(60, run.duration)) {
    for (; next < results.length && results[next].arrives <= t; next++) {
      glide.sample({ x: results[next].x, y: Y }, results[next].taken, results[next].fresh);
    }
    const p = glide.at(t);
    if (p) frames.push({ t, x: p.x, y: p.y });
  }
  return { frames, truth, glide, results };
}

/** Movement per frame, in multiples of the ideal step, between two times. */
function stepRatios(run: Run, from: number, to = Infinity) {
  const { frames } = play(run);
  const ideal = run.speed / 60;
  const ratios: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].t > from && frames[i].t < to) ratios.push((frames[i].x - frames[i - 1].x) / ideal);
  }
  return { max: Math.max(...ratios), min: Math.min(...ratios) };
}

/** How far the glided point runs past where the real one stopped. */
function overshoot(run: Run & { stopAt: number }) {
  const { frames, truth } = play(run);
  const rest = truth(Infinity);
  let worst = -Infinity;
  for (const f of frames) if (f.t >= run.stopAt) worst = Math.max(worst, f.x - rest);
  return { worst, final: frames[frames.length - 1].x - rest };
}

describe("PointGlide", () => {
  it("has no position before the first result, and the first result snaps", () => {
    const g = new PointGlide();
    expect(g.at(0)).toBeNull();
    expect(g.velocity).toEqual({ x: 0, y: 0 });
    g.sample({ x: 0.3, y: 0.7 }, 100);
    expect(g.at(100)).toEqual({ x: 0.3, y: 0.7 });
    expect(g.at(5000)).toEqual({ x: 0.3, y: 0.7 });
  });

  it("snap jumps: no glide and no leftover motion", () => {
    const g = new PointGlide();
    g.snap({ x: 0.2, y: 0.2 }, 0);
    for (let t = 100; t <= 500; t += 100) g.sample({ x: 0.2 + t / 2000, y: 0.2 }, t);
    const moving = g.at(520)!;
    expect(moving.x).toBeGreaterThan(0.2);
    expect(Math.hypot(g.velocity.x, g.velocity.y)).toBeGreaterThan(0);

    g.snap({ x: 0.9, y: 0.1 }, 530);
    expect(g.at(530)).toEqual({ x: 0.9, y: 0.1 });
    expect(g.velocity).toEqual({ x: 0, y: 0 });
    expect(g.at(546)).toEqual({ x: 0.9, y: 0.1 });
    expect(g.at(3000)).toEqual({ x: 0.9, y: 0.1 });
  });

  describe("constant motion (0.5 stage units per second, drawn at 60 fps)", () => {
    for (const hz of [5, 10, 17]) {
      it(`glides at ${hz} Hz: no frame moves more than 3× the ideal step, and none stands still`, () => {
        // Results that take effect the instant they are taken (the simulated demo).
        const instant = stepRatios({ hz, speed: 0.5, duration: 8000 }, 2000);
        // Results that arrive most of an interval late, stamped with their capture time (the real tracker).
        const late = stepRatios({ hz, speed: 0.5, duration: 8000, latency: 0.85 }, 2000);
        for (const r of [instant, late]) {
          expect(r.max).toBeLessThan(3);
          expect(r.max).toBeLessThan(1.5);
          expect(r.min).toBeGreaterThan(0.5);
        }
      });

      it(`keeps gliding at ${hz} Hz when results come irregularly or go missing`, () => {
        for (const seed of [1, 2, 3]) {
          const jittered = stepRatios({ hz, speed: 0.5, duration: 8000, latency: 0.85, jitter: 0.25, seed }, 2000);
          expect(jittered.max).toBeLessThan(3);
          expect(jittered.min).toBeGreaterThan(0);
        }
        // Every fifth result never arrives: the point slows while it waits, but neither jumps nor goes back.
        const dropped = stepRatios({ hz, speed: 0.5, duration: 8000, latency: 0.85, drop: (k) => k % 5 === 4 }, 2000);
        expect(dropped.max).toBeLessThan(3);
        expect(dropped.min).toBeGreaterThan(0);
      });
    }
  });

  describe("dead stop", () => {
    for (const hz of [5, 10, 17]) {
      it(`overshoots by less than 0.03 stage units at ${hz} Hz, whatever the speed and wherever the stop falls`, () => {
        let worst = -Infinity;
        for (const latency of [0, 0.85]) {
          for (const speed of [0.25, 0.5, 1, 2, 4]) {
            for (let phase = 0; phase < 12; phase++) {
              const stopAt = 3000 + (phase * 1000) / hz / 12;
              const steady = overshoot({ hz, speed, duration: 5000, latency, stopAt });
              worst = Math.max(worst, steady.worst);
              expect(Math.abs(steady.final)).toBeLessThan(1e-6); // and it ends on the point
              worst = Math.max(worst, overshoot({ hz, speed, duration: 5000, latency, stopAt, jitter: 0.25, seed: phase + 1 }).worst);
            }
          }
        }
        expect(worst).toBeLessThan(0.03);
        expect(worst).toBeLessThan(0.025);
      });
    }

    it("stays within 25 px of a 1280 px stage at the design's speed of half a stage per second", () => {
      for (const hz of [5, 10, 17]) {
        for (let phase = 0; phase < 12; phase++) {
          const stopAt = 3000 + (phase * 1000) / hz / 12;
          for (const jitter of [0, 0.25]) {
            expect(overshoot({ hz, speed: 0.5, duration: 5000, latency: 0.85, stopAt, jitter, seed: phase + 1 }).worst * 1280).toBeLessThan(25);
          }
        }
      }
    });

    it("can never run further past than maxLead, even when the tracker stalls right after the stop", () => {
      for (const maxLead of [DEFAULT_GLIDE.maxLead, 0.01]) {
        const g = new PointGlide({ maxLead });
        // 2 stage units per second, then nothing: the last result still carries the full velocity.
        for (let t = 0; t <= 1000; t += 100) g.sample({ x: t * 0.002, y: Y }, t);
        let furthest = -Infinity;
        for (let t = 1000; t <= 4000; t += 1000 / 60) furthest = Math.max(furthest, g.at(t)!.x - 2);
        expect(furthest).toBeLessThanOrEqual(maxLead + 1e-12);
        expect(furthest).toBeGreaterThan(maxLead * 0.99); // it is the cap that holds it, not luck
      }
    });
  });

  describe("lead", () => {
    const ahead = (run: Run) => {
      const led = play(run).frames;
      const plain = play({ ...run, options: { ...run.options, leadGain: 0 } }).frames;
      return led.map((f, i) => f.x - plain[i].x);
    };

    it("puts the point ahead of a follower without lead, by velocity × time × gain", () => {
      // 0.3 stage units/s at 10 Hz: 0.5 × 0.0003 per ms × 100 ms = 0.015.
      const lead = ahead({ hz: 10, speed: 0.3, duration: 4000, latency: 0.85 });
      for (const d of lead) expect(d).toBeGreaterThanOrEqual(-1e-12);
      expect(lead[lead.length - 1]).toBeCloseTo(0.015, 3);
      // The lead time is never more than leadMaxMs: at 5 Hz it is 100 ms, not the 200 ms interval.
      const slow = ahead({ hz: 5, speed: 0.2, duration: 5000, latency: 0.85 });
      expect(slow[slow.length - 1]).toBeCloseTo(0.5 * 0.0002 * 100, 3);
    });

    it("is bounded by maxLead however fast the point moves", () => {
      const cases: Partial<GlideOptions>[] = [{}, { maxLead: 0.008 }, { maxLead: 0.05, leadGain: 1 }];
      for (const options of cases) {
        const maxLead = options.maxLead ?? DEFAULT_GLIDE.maxLead;
        for (const hz of [5, 10, 17]) {
          const lead = ahead({ hz, speed: 3, duration: 3000, latency: 0.85, jitter: 0.25, options });
          const most = Math.max(...lead);
          expect(most).toBeLessThanOrEqual(maxLead + 1e-9);
          expect(most).toBeGreaterThan(maxLead * 0.9);
          expect(Math.min(...lead)).toBeGreaterThanOrEqual(-1e-12);
        }
      }
    });

    it("a coasting result adds no lead", () => {
      // The target moved a long way, but nothing was observed: exactly the path of a follower without lead.
      const run: Run = { hz: 10, speed: 1.5, duration: 2000, latency: 0.85, coasting: () => true };
      const coasting = play(run).frames;
      const plain = play({ ...run, coasting: undefined, options: { leadGain: 0 } }).frames;
      expect(coasting).toEqual(plain);

      // A hand that drops out while moving: the lead of its last observation is withdrawn,
      // and the point settles exactly on the last observed position.
      const g = new PointGlide();
      for (let t = 0; t <= 500; t += 100) g.sample({ x: 0.2 + t * 0.001, y: Y }, t);
      g.sample({ x: 0.7, y: Y }, 600, false);
      expect(g.at(3000)!.x).toBeCloseTo(0.7, 9);
    });

    it("does not lead across a dropout: a velocity needs two observations in a row", () => {
      const feed = (g: PointGlide) => {
        g.snap({ x: 0.2, y: Y }, 0);
        g.sample({ x: 0.2, y: Y }, 100, false);
        g.sample({ x: 0.4, y: Y }, 200); // first sight after the dropout: far away, but no known velocity
      };
      const led = new PointGlide();
      const plain = new PointGlide({ leadGain: 0 });
      feed(led);
      feed(plain);
      for (let t = 200; t <= 300; t += 10) expect(led.at(t)).toEqual(plain.at(t));
      // The next observation does give a velocity.
      led.sample({ x: 0.6, y: Y }, 300);
      plain.sample({ x: 0.6, y: Y }, 300);
      expect(led.at(400)!.x).toBeGreaterThan(plain.at(400)!.x + 0.005);
    });

    it("does not extrapolate landmark jitter", () => {
      const rand = mulberry32(7);
      const led = new PointGlide();
      const plain = new PointGlide({ leadGain: 0 });
      // ±0.001 of the stage (about a pixel) around a fixed point, at 17 Hz.
      for (let k = 0; k < 120; k++) {
        const p = { x: 0.5 + (rand() * 2 - 1) * 0.001, y: 0.5 + (rand() * 2 - 1) * 0.001 };
        led.sample(p, k * 59);
        plain.sample(p, k * 59);
        expect(led.at(k * 59 + 50)).toEqual(plain.at(k * 59 + 50));
      }

      // Rougher jitter (±0.003, several pixels): the glided point still moves less than the raw one.
      const g = new PointGlide();
      let raw = 0;
      let glided = 0;
      let n = 0;
      for (let k = 0; k < 400; k++) {
        const p = { x: 0.5 + (rand() * 2 - 1) * 0.003, y: 0.5 + (rand() * 2 - 1) * 0.003 };
        g.sample(p, k * 59);
        raw += (p.x - 0.5) ** 2 + (p.y - 0.5) ** 2;
        for (let f = 1; f <= 3; f++) {
          const o = g.at(k * 59 + f * 16)!;
          glided += (o.x - 0.5) ** 2 + (o.y - 0.5) ** 2;
          n++;
        }
      }
      expect(Math.sqrt(glided / n)).toBeLessThan(Math.sqrt(raw / 400) * 0.9);
    });
  });

  describe("frame-rate independence", () => {
    // Irregular results, a lead that ramps, and a dead stop: every code path of the follower.
    const run: Run = { hz: 9, speed: 0.6, duration: 6000, jitter: 0.3, stopAt: 4100, seed: 5 };
    const marks = (times: number[]) => {
      const out = new Map<number, number>();
      for (const f of play({ ...run, times }).frames) if (f.t % 500 === 0) out.set(f.t, f.x);
      return out;
    };

    it("gives the same path at 30, 60 and 144 fps, and on an uneven frame clock", () => {
      const at60 = marks(grid(60, run.duration));
      expect(at60.size).toBe(12); // every 500 ms; the first result comes just after 0

      const rand = mulberry32(3);
      const uneven: number[] = [];
      for (let block = 0; block < 12; block++) {
        // Frames 4–40 ms apart, including one long hitch per block, that still land on every 500 ms mark.
        for (let t = block * 500; t < block * 500 + 500 - 40; t += 4 + rand() * 36) uneven.push(t === block * 500 ? t : Math.round(t * 100) / 100);
      }
      uneven.push(6000);

      for (const other of [marks(grid(30, run.duration)), marks(grid(144, run.duration)), marks(uneven)]) {
        expect(other.size).toBe(12);
        for (const [t, x] of at60) expect(Math.abs(other.get(t)! - x)).toBeLessThan(1e-9);
      }
    });

    it("one long frame lands where many short ones do", () => {
      const a = new PointGlide();
      const b = new PointGlide();
      for (const g of [a, b]) {
        g.snap({ x: 0.1, y: 0.9 }, 0);
        g.sample({ x: 0.3, y: 0.6 }, 100);
        g.sample({ x: 0.5, y: 0.3 }, 200);
        g.at(200);
      }
      for (let t = 200; t <= 700; t += 0.5) a.at(t);
      const fine = a.at(700)!;
      const coarse = b.at(700)!;
      expect(coarse.x).toBeCloseTo(fine.x, 10);
      expect(coarse.y).toBeCloseTo(fine.y, 10);
      expect(b.velocity.x).toBeCloseTo(a.velocity.x, 10);
    });

    it("with results stamped in the past, frame rates differ by less than one slow frame of travel", () => {
      // A late result takes effect from the last frame drawn, so a slower renderer applies it a little earlier.
      const late: Run = { hz: 10, speed: 0.5, duration: 4000, latency: 0.85 };
      const at30 = play({ ...late, times: grid(30, late.duration) }).frames;
      const at120 = play({ ...late, times: grid(120, late.duration) }).frames;
      const fast = new Map(at120.map((f) => [f.t, f.x]));
      let compared = 0;
      for (const f of at30) {
        const x = fast.get(f.t);
        if (x === undefined) continue;
        compared++;
        expect(Math.abs(f.x - x)).toBeLessThan((0.5 / 30) * 1.5);
      }
      expect(compared).toBeGreaterThan(100);
    });

    it("a time that runs backwards returns the latest position instead of rewinding", () => {
      const g = new PointGlide();
      g.snap({ x: 0, y: 0 }, 0);
      g.sample({ x: 1, y: 0 }, 100, false);
      const later = g.at(200)!;
      expect(g.at(150)).toEqual(later);
      expect(g.at(200)).toEqual(later);
    });
  });

  describe("time constant", () => {
    const tauAt = (hz: number, options?: Partial<GlideOptions>) => {
      const g = new PointGlide(options);
      for (let k = 0; k < 20; k++) g.sample({ x: 0.5, y: 0.5 }, (k * 1000) / hz);
      return g.tauMs;
    };

    it("is 0.7 × the measured tracking interval, kept between 45 and 140 ms", () => {
      expect(tauAt(10)).toBeCloseTo(70, 6);
      expect(tauAt(8)).toBeCloseTo(87.5, 6);
      expect(tauAt(5)).toBeCloseTo(140, 6);
      expect(tauAt(2)).toBeCloseTo(140, 6);
      expect(tauAt(17)).toBeCloseTo(45, 6);
      expect(tauAt(60)).toBeCloseTo(45, 6);
      expect(tauAt(10, { tauFactor: 1.5, tauMinMs: 10, tauMaxMs: 500 })).toBeCloseTo(150, 6);
      expect(new PointGlide().tauMs).toBeCloseTo(DEFAULT_GLIDE.tauFactor * GLIDE_T.defaultIntervalMs, 6);
    });

    it("follows a change of tracking rate within a few results", () => {
      const g = new PointGlide();
      let t = 0;
      for (let k = 0; k < 20; k++) g.sample({ x: 0.5, y: 0.5 }, (t += 59));
      expect(g.tauMs).toBeCloseTo(45, 6);
      for (let k = 0; k < 8; k++) g.sample({ x: 0.5, y: 0.5 }, (t += 200));
      expect(g.tauMs).toBeGreaterThan(130);
      // One missing result does not throw it far.
      for (let k = 0; k < 12; k++) g.sample({ x: 0.5, y: 0.5 }, (t += 100));
      const before = g.tauMs;
      g.sample({ x: 0.5, y: 0.5 }, (t += 200));
      expect(g.tauMs).toBeLessThan(before * 1.35);
    });

    it("spreads each result over about one tracking interval, at any rate", () => {
      for (const hz of [5, 8, 12]) {
        const interval = 1000 / hz;
        const g = new PointGlide({ leadGain: 0 });
        for (let k = 0; k < 10; k++) g.sample({ x: 0, y: 0 }, k * interval);
        g.sample({ x: 1, y: 0 }, 10 * interval);
        // By the time the next result is due, most of the way there; halfway, well under way but not rushing.
        const half = g.at(10.5 * interval)!.x;
        const whole = g.at(11 * interval)!.x;
        expect(half).toBeGreaterThan(0.3);
        expect(half).toBeLessThan(0.5);
        expect(whole).toBeGreaterThan(0.7);
        expect(whole).toBeLessThan(0.85);
      }
    });

    it("without lead the point approaches its target from one side and never passes it", () => {
      const g = new PointGlide();
      g.snap({ x: 0.2, y: 0.8 }, 0);
      g.sample({ x: 0.8, y: 0.3 }, 100, false);
      let prev = g.at(100)!;
      for (let t = 100; t <= 2000; t += 7) {
        const p = g.at(t)!;
        expect(p.x).toBeGreaterThanOrEqual(prev.x);
        expect(p.y).toBeLessThanOrEqual(prev.y);
        expect(p.x).toBeLessThanOrEqual(0.8);
        expect(p.y).toBeGreaterThanOrEqual(0.3);
        prev = p;
      }
      expect(prev.x).toBeCloseTo(0.8, 6);
      expect(prev.y).toBeCloseTo(0.3, 6);
    });
  });

  it("reports the velocity of the glided point in stage units per ms", () => {
    const { glide } = play({ hz: 10, speed: 0.4, duration: 3000 });
    // Average over whole tracking intervals: the point moves exactly as fast as what it follows.
    let sum = 0;
    let n = 0;
    let before = glide.at(3000)!;
    for (let t = 3000.25; t <= 3400; t += 0.25) {
      // Results keep coming so the motion stays steady.
      if ((t - 3) % 100 === 0) glide.sample({ x: X0 + 0.0004 * t, y: Y }, t);
      const now = glide.at(t)!;
      const v = glide.velocity;
      // It is the slope of the path that at() returns.
      expect(v.x).toBeCloseTo((now.x - before.x) / 0.25, 5);
      expect(v.y).toBe(0);
      sum += v.x;
      n++;
      before = now;
    }
    expect(sum / n).toBeCloseTo(0.0004, 5);

    // At rest it is zero.
    const still = new PointGlide();
    still.snap({ x: 0.4, y: 0.4 }, 0);
    still.sample({ x: 0.6, y: 0.4 }, 100, false);
    still.at(150);
    expect(still.velocity.x).toBeGreaterThan(0);
    still.at(4000);
    expect(Math.abs(still.velocity.x)).toBeLessThan(1e-9);
  });

  it("ignores non-finite input and a result delivered twice", () => {
    const g = new PointGlide();
    g.snap({ x: Number.NaN, y: 0.5 }, 0);
    expect(g.at(0)).toBeNull();
    g.sample({ x: 0.5, y: Number.POSITIVE_INFINITY }, 0);
    expect(g.at(0)).toBeNull();

    const once = new PointGlide();
    const twice = new PointGlide();
    for (let t = 0; t <= 600; t += 100) {
      const p = { x: 0.2 + t * 0.0005, y: Y };
      once.sample(p, t);
      twice.sample(p, t);
      twice.sample(p, t);
      twice.sample({ x: Number.NaN, y: Y }, t + 50);
      twice.sample(p, Number.NaN);
      expect(twice.at(t + 60)).toEqual(once.at(t + 60));
    }
    expect(twice.tauMs).toBe(once.tauMs);
  });

  it("reset forgets everything", () => {
    const g = new PointGlide();
    for (let t = 0; t <= 1000; t += 200) g.sample({ x: t / 2000, y: Y }, t);
    expect(g.tauMs).toBeCloseTo(140, 6);
    g.reset();
    expect(g.at(1200)).toBeNull();
    expect(g.velocity).toEqual({ x: 0, y: 0 });
    expect(g.tauMs).toBeCloseTo(70, 6);
    g.sample({ x: 0.9, y: 0.9 }, 1300);
    expect(g.at(1300)).toEqual({ x: 0.9, y: 0.9 });
  });
});
