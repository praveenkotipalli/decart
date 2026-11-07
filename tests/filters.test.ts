import { describe, expect, it } from "vitest";
import {
  buildLut,
  effectiveFilter,
  FILTER_ORDER,
  FILTERS,
  hexToRgb,
  luma,
  LUT_ROWS,
  LUT_WIDTH,
  nextFilter,
  sampleRamp,
  TreatmentTransition,
} from "../src/toy/filters";

describe("filter ramps", () => {
  it("has one lookup row per tint and none for the clear filter", () => {
    const rows = Object.values(FILTERS)
      .filter((f) => f.stops)
      .map((f) => f.row)
      .sort();
    expect(rows).toEqual([0, 1, 2, 3]);
    expect(rows).toHaveLength(LUT_ROWS);
    expect(FILTERS.none.row).toBe(-1);
    expect(FILTERS.none.stops).toBeNull();
  });

  it("rises in luminance along every ramp, so the picture keeps its tonal order", () => {
    for (const def of Object.values(FILTERS)) {
      if (!def.stops) continue;
      let prev = -1;
      for (let i = 0; i < LUT_WIDTH; i++) {
        const l = luma(sampleRamp(def.stops, i / (LUT_WIDTH - 1)));
        expect(l, `${def.id} at ${i}`).toBeGreaterThanOrEqual(prev);
        prev = l;
      }
      // Dark stays dark and bright stays bright.
      expect(luma(sampleRamp(def.stops, 0))).toBeLessThan(20);
      expect(luma(sampleRamp(def.stops, 1))).toBeGreaterThan(225);
    }
  });

  it("starts and ends each ramp exactly on its first and last stop", () => {
    for (const def of Object.values(FILTERS)) {
      if (!def.stops) continue;
      expect(sampleRamp(def.stops, 0)).toEqual(hexToRgb(def.stops[0][1]));
      expect(sampleRamp(def.stops, 1)).toEqual(hexToRgb(def.stops[def.stops.length - 1][1]));
      expect(sampleRamp(def.stops, -3)).toEqual(hexToRgb(def.stops[0][1]));
      expect(sampleRamp(def.stops, 7)).toEqual(hexToRgb(def.stops[def.stops.length - 1][1]));
    }
  });

  it("passes through every stop", () => {
    for (const def of Object.values(FILTERS)) {
      if (!def.stops) continue;
      for (const [pos, hex] of def.stops) {
        const c = sampleRamp(def.stops, pos);
        const want = hexToRgb(hex);
        for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(want[k], 6);
      }
    }
  });
});

describe("buildLut", () => {
  const lut = buildLut();

  it("has the documented size and is opaque", () => {
    expect(lut).toHaveLength(LUT_WIDTH * LUT_ROWS * 4);
    for (let i = 3; i < lut.length; i += 4) expect(lut[i]).toBe(255);
  });

  it("writes each filter's end stops into its own row", () => {
    for (const def of Object.values(FILTERS)) {
      if (!def.stops) continue;
      const first = def.row * LUT_WIDTH * 4;
      const last = (def.row * LUT_WIDTH + LUT_WIDTH - 1) * 4;
      expect([lut[first], lut[first + 1], lut[first + 2]]).toEqual(hexToRgb(def.stops[0][1]));
      expect([lut[last], lut[last + 1], lut[last + 2]]).toEqual(hexToRgb(def.stops[def.stops.length - 1][1]));
    }
  });
});

describe("filter cycle", () => {
  it("steps rose → clear → cobalt → violet → silver → rose", () => {
    expect(FILTER_ORDER).toEqual(["rose", "none", "cobalt", "violet", "silver"]);
    let f = FILTER_ORDER[0];
    const seen = [f];
    for (let i = 0; i < 5; i++) {
      f = nextFilter(f, 1, false);
      seen.push(f);
    }
    expect(seen).toEqual(["rose", "none", "cobalt", "violet", "silver", "rose"]);
  });

  it("steps backwards", () => {
    expect(nextFilter("rose", -1, false)).toBe("silver");
    expect(nextFilter("cobalt", -1, false)).toBe("none");
  });

  it("skips the clear filter when asked (no anime on screen)", () => {
    expect(nextFilter("rose", 1, true)).toBe("cobalt");
    expect(nextFilter("cobalt", -1, true)).toBe("rose");
    expect(nextFilter("none", 1, true)).toBe("cobalt");
  });

  it("never applies the clear filter while anime is not showing", () => {
    expect(effectiveFilter("none", false, "violet")).toBe("violet");
    expect(effectiveFilter("none", true, "violet")).toBe("none");
    expect(effectiveFilter("cobalt", false, "rose")).toBe("cobalt");
    expect(effectiveFilter("cobalt", true, "rose")).toBe("cobalt");
  });
});

describe("TreatmentTransition", () => {
  it("is idle until something changes", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    const s = t.state(1000);
    expect(s.progress).toBe(1);
    expect(s.from).toEqual(s.to);
  });

  it("is a no-op when the target does not change", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    t.set({ row: 0, anime: 0 }, 1000, true);
    expect(t.state(1001).progress).toBe(1);
  });

  it("runs 360 ms of tiles from the old look to the new one and then stops", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    t.set({ row: 1, anime: 0 }, 1000, true);
    const start = t.state(1000);
    expect(start.progress).toBe(0);
    expect(start.from).toEqual({ row: 0, anime: 0 });
    expect(start.to).toEqual({ row: 1, anime: 0 });
    expect(start.tiles).toBe(true);
    expect(t.state(1180).progress).toBeCloseTo(0.5, 6);
    expect(t.state(1360).progress).toBe(1);
    expect(t.state(99999).progress).toBe(1);
  });

  it("cross-fades in 150 ms when tiles are off", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    t.set({ row: 0, anime: 1 }, 0, false);
    expect(t.state(0).tiles).toBe(false);
    expect(t.state(75).progress).toBeCloseTo(0.5, 6);
    expect(t.state(150).progress).toBe(1);
  });

  it("uses a new seed for every transition", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    t.set({ row: 1, anime: 0 }, 0, true);
    const a = t.state(10).seed;
    t.set({ row: 2, anime: 0 }, 1000, true);
    expect(t.state(1010).seed).not.toBe(a);
  });

  it("starts an interrupting change from the look that was mostly on screen", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    t.set({ row: 1, anime: 0 }, 0, true);
    t.set({ row: 2, anime: 0 }, 300, true); // 83% through: row 1 is what is showing
    expect(t.state(300).from).toEqual({ row: 1, anime: 0 });
    expect(t.state(300).to).toEqual({ row: 2, anime: 0 });
  });

  it("snaps without animating", () => {
    const t = new TreatmentTransition({ row: 0, anime: 0 });
    t.snap({ row: 3, anime: 1 });
    const s = t.state(5);
    expect(s.progress).toBe(1);
    expect(s.to).toEqual({ row: 3, anime: 1 });
    expect(t.target).toEqual({ row: 3, anime: 1 });
  });
});
