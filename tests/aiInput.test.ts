import { describe, expect, it } from "vitest";
import { aspectsMatch, coverCrop } from "../src/ai/aiInputStream";

describe("coverCrop", () => {
  it("crops a 4:3 frame to a centred 16:9 band", () => {
    const c = coverCrop(640, 480, 16 / 9);
    expect(c).toEqual({ x: 0, y: 60, w: 640, h: 360 });
  });

  it("crops a wide frame to a centred column for a taller target", () => {
    const c = coverCrop(1920, 1080, 4 / 3);
    expect(c.h).toBe(1080);
    expect(c.w).toBe(1440);
    expect(c.x).toBe(240);
    expect(c.y).toBe(0);
  });

  it("returns even dimensions that fit inside the source", () => {
    for (const [w, h, a] of [[641, 479, 16 / 9], [1279, 721, 1280 / 704], [333, 777, 1.5]] as const) {
      const c = coverCrop(w, h, a);
      expect(c.w % 2).toBe(0);
      expect(c.h % 2).toBe(0);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(w);
      expect(c.y + c.h).toBeLessThanOrEqual(h);
      expect(Math.abs(c.w / c.h - a)).toBeLessThan(0.02);
    }
  });
});

describe("aspectsMatch", () => {
  it("treats 1280x720 and the restyle model's 1280x704 as the same shape", () => {
    expect(aspectsMatch(1280 / 720, 1280 / 704)).toBe(true);
  });

  it("does not treat 4:3 as 16:9", () => {
    expect(aspectsMatch(4 / 3, 16 / 9)).toBe(false);
  });
});
