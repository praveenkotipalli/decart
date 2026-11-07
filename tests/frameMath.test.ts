import { describe, expect, it } from "vitest";
import type { Quad } from "../src/geometry/vec";
import {
  boundsDiagonal,
  bracketSegments,
  crossing,
  displayRect,
  insideEvenOdd,
  quadBounds,
  selfIntersects,
  stageToAiUv,
} from "../src/toy/frameMath";

// Corner order of the hand frame: A index (top-left), B index (top-right), B thumb, A thumb.
const RECT: Quad = [
  { x: 0.3, y: 0.3 },
  { x: 0.7, y: 0.3 },
  { x: 0.7, y: 0.7 },
  { x: 0.3, y: 0.7 },
];
// Hand B turned over: its thumb is now above its index finger.
const BOWTIE: Quad = [
  { x: 0.3, y: 0.3 },
  { x: 0.7, y: 0.7 },
  { x: 0.7, y: 0.3 },
  { x: 0.3, y: 0.7 },
];

describe("insideEvenOdd", () => {
  it("is true inside a rectangle and false outside", () => {
    expect(insideEvenOdd({ x: 0.5, y: 0.5 }, RECT)).toBe(true);
    expect(insideEvenOdd({ x: 0.2, y: 0.5 }, RECT)).toBe(false);
    expect(insideEvenOdd({ x: 0.5, y: 0.8 }, RECT)).toBe(false);
  });

  it("fills both lobes of a bow-tie and nothing above or below the crossing", () => {
    expect(insideEvenOdd({ x: 0.35, y: 0.5 }, BOWTIE)).toBe(true);
    expect(insideEvenOdd({ x: 0.65, y: 0.5 }, BOWTIE)).toBe(true);
    expect(insideEvenOdd({ x: 0.5, y: 0.35 }, BOWTIE)).toBe(false);
    expect(insideEvenOdd({ x: 0.5, y: 0.65 }, BOWTIE)).toBe(false);
  });

  it("does not care which way round the corners run", () => {
    const mirrored: Quad = [RECT[1], RECT[0], RECT[3], RECT[2]];
    expect(insideEvenOdd({ x: 0.5, y: 0.5 }, mirrored)).toBe(true);
    expect(insideEvenOdd({ x: 0.9, y: 0.5 }, mirrored)).toBe(false);
  });
});

describe("crossing", () => {
  it("reports no crossing for a convex frame", () => {
    expect(crossing(RECT).crossed).toBe(false);
    expect(selfIntersects(RECT)).toBe(false);
  });

  it("finds where the top and bottom edges of a twisted frame meet", () => {
    const c = crossing(BOWTIE);
    expect(c.crossed).toBe(true);
    expect(c.t).toBeCloseTo(0.5, 6);
    expect(c.s).toBeCloseTo(0.5, 6);
    expect(selfIntersects(BOWTIE)).toBe(true);
  });

  it("puts the crossing off-centre when one side is taller", () => {
    // Left side 0.2 tall, right side 0.6 tall: the edges meet a quarter of the way along.
    const q: Quad = [
      { x: 0.2, y: 0.4 },
      { x: 0.8, y: 0.8 },
      { x: 0.8, y: 0.2 },
      { x: 0.2, y: 0.6 },
    ];
    const c = crossing(q);
    expect(c.crossed).toBe(true);
    expect(c.t).toBeCloseTo(0.25, 6);
    expect(c.s).toBeCloseTo(0.25, 6);
  });

  it("sees a left/right crossing as self-intersecting but not as a twist", () => {
    const q: Quad = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.3 },
      { x: 0.3, y: 0.7 },
      { x: 0.7, y: 0.7 },
    ];
    expect(crossing(q).crossed).toBe(false);
    expect(selfIntersects(q)).toBe(true);
  });
});

describe("bracketSegments", () => {
  it("returns two arms per edge, each a sixth of the edge long", () => {
    const segs = bracketSegments(RECT, 1 / 6);
    expect(segs).toHaveLength(8);
    for (const [a, b] of segs) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(0.4 / 6, 6);
    // First edge: one arm starts at corner 0, the other ends at corner 1.
    expect(segs[0][0]).toEqual(RECT[0]);
    expect(segs[1][1]).toEqual(RECT[1]);
  });

  it("makes the arms meet at 0.5 (the locked outline)", () => {
    const segs = bracketSegments(RECT, 0.5);
    expect(segs[0][1].x).toBeCloseTo(segs[1][0].x, 9);
    expect(segs[0][1].y).toBeCloseTo(segs[1][0].y, 9);
  });
});

describe("bounds", () => {
  it("pads the bounding box", () => {
    expect(quadBounds(BOWTIE, 0.1)).toEqual({ x0: 0.3 - 0.1, y0: 0.3 - 0.1, x1: 0.7 + 0.1, y1: 0.7 + 0.1 });
  });

  it("measures the diagonal", () => {
    expect(boundsDiagonal(RECT)).toBeCloseTo(Math.hypot(0.4, 0.4), 9);
  });
});

describe("AI rect", () => {
  it("mirrors a camera region for the mirrored display", () => {
    expect(displayRect({ x: 0.1, y: 0.125, w: 0.6, h: 0.75 }, true)).toEqual({ x: 1 - 0.1 - 0.6, y: 0.125, w: 0.6, h: 0.75 });
    expect(displayRect({ x: 0.1, y: 0.125, w: 0.6, h: 0.75 }, false)).toEqual({ x: 0.1, y: 0.125, w: 0.6, h: 0.75 });
  });

  it("maps stage positions into the AI frame and reports the uncovered band", () => {
    const rect = { x: 0, y: 0.125, w: 1, h: 0.75 }; // a 4:3 camera cropped to 16:9
    const mid = stageToAiUv({ x: 0.5, y: 0.5 }, rect);
    expect(mid.inside).toBe(true);
    expect(mid.uv.x).toBeCloseTo(0.5, 9);
    expect(mid.uv.y).toBeCloseTo(0.5, 9);
    expect(stageToAiUv({ x: 0.5, y: 0.05 }, rect).inside).toBe(false);
    expect(stageToAiUv({ x: 0.5, y: 0.125 }, rect).uv.y).toBeCloseTo(0, 9);
  });
});
