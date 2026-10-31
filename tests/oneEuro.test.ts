import { describe, expect, it } from "vitest";
import { OneEuro2D } from "../src/tracking/oneEuro";

/** Deterministic pseudo-random noise so the test is stable. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };
}

describe("OneEuro2D", () => {
  it("passes the first sample through unchanged", () => {
    const f = new OneEuro2D();
    expect(f.filter({ x: 0.3, y: 0.7 }, 0)).toEqual({ x: 0.3, y: 0.7 });
  });

  it("removes most jitter from a hand held still", () => {
    const f = new OneEuro2D({ minCutoff: 1.2, beta: 6, dCutoff: 1 });
    const r = rng(7);
    const rawDev: number[] = [];
    const outDev: number[] = [];
    for (let i = 0; i < 300; i++) {
      const raw = { x: 0.5 + r() * 0.01, y: 0.5 + r() * 0.01 };
      const out = f.filter(raw, i * 33.3);
      if (i > 30) {
        rawDev.push(Math.hypot(raw.x - 0.5, raw.y - 0.5));
        outDev.push(Math.hypot(out.x - 0.5, out.y - 0.5));
      }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(outDev)).toBeLessThan(mean(rawDev) * 0.4);
  });

  it("keeps lag small on fast movements because the cutoff rises with speed", () => {
    const run = (beta: number) => {
      const f = new OneEuro2D({ minCutoff: 1, beta, dCutoff: 1 });
      let out = { x: 0, y: 0 };
      // Sweep across 60% of the frame in half a second.
      for (let i = 0; i <= 15; i++) out = f.filter({ x: (i / 15) * 0.6, y: 0 }, i * 33.3);
      return 0.6 - out.x;
    };
    expect(run(8)).toBeLessThan(run(0) * 0.5);
  });

  it("converges to a constant input", () => {
    const f = new OneEuro2D();
    f.filter({ x: 0, y: 0 }, 0);
    let out = { x: 0, y: 0 };
    for (let i = 1; i < 200; i++) out = f.filter({ x: 1, y: 1 }, i * 33);
    expect(out.x).toBeCloseTo(1, 3);
  });

  it("reset jumps without smoothing", () => {
    const f = new OneEuro2D();
    f.filter({ x: 0, y: 0 }, 0);
    f.reset({ x: 0.9, y: 0.9 }, 100);
    expect(f.filter({ x: 0.9, y: 0.9 }, 133)).toEqual({ x: 0.9, y: 0.9 });
  });
});
