import { describe, expect, it } from "vitest";
import {
  applyHomography,
  homogeneousW,
  invert3,
  multiply3,
  quadToQuad,
  squareToQuad,
  toGLMatrix,
  type Mat3,
} from "../src/geometry/homography";
import {
  classifyQuad,
  estimateAspect,
  expandQuad,
  isConvex,
  isSelfIntersecting,
  minInteriorAngle,
  signedArea,
  untangle,
} from "../src/geometry/quad";
import type { Quad, Vec2 } from "../src/geometry/vec";

const UNIT: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const trapezoid: Quad = [
  { x: 120, y: 80 },
  { x: 610, y: 140 },
  { x: 560, y: 470 },
  { x: 90, y: 400 },
];

function expectClose(a: Vec2 | null, b: Vec2, digits = 6) {
  expect(a).not.toBeNull();
  expect(a!.x).toBeCloseTo(b.x, digits);
  expect(a!.y).toBeCloseTo(b.y, digits);
}

/** Intersection of segments p0p2 and p1p3 — where a projective map must send (0.5, 0.5). */
function diagonalIntersection(q: Quad): Vec2 {
  const [a, b, c, d] = q;
  const r = { x: c.x - a.x, y: c.y - a.y };
  const s = { x: d.x - b.x, y: d.y - b.y };
  const t = ((b.x - a.x) * s.y - (b.y - a.y) * s.x) / (r.x * s.y - r.y * s.x);
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

describe("squareToQuad", () => {
  it("maps the unit square's corners exactly onto the quad", () => {
    const H = squareToQuad(trapezoid)!;
    UNIT.forEach((u, i) => expectClose(applyHomography(H, u), trapezoid[i]));
  });

  it("is perspective-correct: the square's centre lands on the quad's diagonal intersection", () => {
    // An affine/bilinear warp would put it at the vertex average instead.
    const H = squareToQuad(trapezoid)!;
    expectClose(applyHomography(H, { x: 0.5, y: 0.5 }), diagonalIntersection(trapezoid), 5);
  });

  it("preserves straight lines (collinear points stay collinear)", () => {
    const H = squareToQuad(trapezoid)!;
    const pts = [0, 0.25, 0.6, 1].map((t) => applyHomography(H, { x: t, y: 0.3 })!);
    const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    expect(Math.abs(cross(pts[0], pts[1], pts[2]))).toBeLessThan(1e-6);
    expect(Math.abs(cross(pts[0], pts[1], pts[3]))).toBeLessThan(1e-6);
  });

  it("handles parallelograms with the affine branch", () => {
    const para: Quad = [
      { x: 10, y: 10 },
      { x: 110, y: 30 },
      { x: 130, y: 130 },
      { x: 30, y: 110 },
    ];
    const H = squareToQuad(para)!;
    expect(H[6]).toBe(0);
    expect(H[7]).toBe(0);
    UNIT.forEach((u, i) => expectClose(applyHomography(H, u), para[i]));
  });

  it("follows a rotated portal: rotating the corners rotates the content", () => {
    const rot = (p: Vec2, a: number, c: Vec2): Vec2 => ({
      x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
      y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
    });
    const c = { x: 350, y: 280 };
    const turned = trapezoid.map((p) => rot(p, Math.PI / 2, c)) as Quad;
    const H0 = squareToQuad(trapezoid)!;
    const H1 = squareToQuad(turned)!;
    for (const u of [{ x: 0.2, y: 0.7 }, { x: 0.9, y: 0.1 }]) {
      expectClose(applyHomography(H1, u), rot(applyHomography(H0, u)!, Math.PI / 2, c), 5);
    }
  });

  it("returns null for degenerate quads", () => {
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(squareToQuad(line)).toBeNull();
  });
});

describe("inverse homography (what the fragment shader evaluates per pixel)", () => {
  it("round-trips screen points back to texture coordinates", () => {
    const H = squareToQuad(trapezoid)!;
    const Hi = invert3(H)!;
    for (const u of [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.93, y: 0.41 }]) {
      expectClose(applyHomography(Hi, applyHomography(H, u)!), u);
    }
    const I = multiply3(H, Hi);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(I[i]).toBeCloseTo(v, 9));
  });

  it("gives every interior point the same w sign (used to reject points beyond the horizon)", () => {
    const Hi = invert3(squareToQuad(trapezoid)!)!;
    const signs = [{ x: 200, y: 200 }, { x: 500, y: 200 }, { x: 300, y: 400 }].map((p) => Math.sign(homogeneousW(Hi, p)));
    expect(new Set(signs).size).toBe(1);
  });

  it("quadToQuad maps one quad onto another", () => {
    const M = quadToQuad(UNIT, trapezoid)!;
    UNIT.forEach((u, i) => expectClose(applyHomography(M, u), trapezoid[i]));
  });

  it("toGLMatrix transposes to column-major", () => {
    const m: Mat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(Array.from(toGLMatrix(m))).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });
});

describe("quad validity", () => {
  it("accepts convex quads in either winding (a mirrored portal is still a portal)", () => {
    expect(classifyQuad(trapezoid, 1)).toBe("valid");
    const mirrored = [trapezoid[1], trapezoid[0], trapezoid[3], trapezoid[2]] as Quad;
    expect(signedArea(mirrored)).toBeLessThan(0);
    expect(classifyQuad(mirrored, 1)).toBe("valid");
  });

  it("detects a bow-tie when two corners swap (crossed fingers)", () => {
    const crossed: Quad = [trapezoid[1], trapezoid[0], trapezoid[2], trapezoid[3]];
    expect(isSelfIntersecting(crossed)).toBe(true);
    expect(classifyQuad(crossed, 1)).toBe("crossed");
  });

  it("detects concave quads (one corner pushed inside)", () => {
    const dart: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 100 },
    ];
    expect(isConvex(dart)).toBe(false);
    expect(classifyQuad(dart, 1)).toBe("concave");
  });

  it("flags tiny or collapsed quads as degenerate", () => {
    const tiny: Quad = [
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 0.01, y: 0.01 },
      { x: 0, y: 0.01 },
    ];
    expect(classifyQuad(tiny, 0.001)).toBe("degenerate");
  });

  it("optionally rejects slivers with a tiny interior angle", () => {
    const sliver: Quad = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 20 },
      { x: 280, y: 25 },
    ];
    expect(classifyQuad(sliver, 1)).toBe("valid");
    expect(minInteriorAngle(sliver)).toBeLessThan(10);
    expect(classifyQuad(sliver, 1, 0, 10)).toBe("degenerate");
    expect(classifyQuad(trapezoid, 1, 0, 10)).toBe("valid");
  });

  it("untangle repairs a bow-tie into a valid outline and keeps P1 first", () => {
    const crossed: Quad = [trapezoid[0], trapezoid[2], trapezoid[1], trapezoid[3]];
    const fixed = untangle(crossed);
    expect(fixed[0]).toEqual(trapezoid[0]);
    expect(classifyQuad(fixed, 1)).toBe("valid");
  });
});

describe("quad helpers", () => {
  it("estimates the depicted aspect ratio", () => {
    const r: Quad = [
      { x: 0, y: 0 },
      { x: 160, y: 0 },
      { x: 160, y: 90 },
      { x: 0, y: 90 },
    ];
    expect(estimateAspect(r)).toBeCloseTo(16 / 9, 6);
  });

  it("expands about the centroid", () => {
    const e = expandQuad(UNIT, 2);
    expect(e[0]).toEqual({ x: -0.5, y: -0.5 });
    expect(e[2]).toEqual({ x: 1.5, y: 1.5 });
  });
});
