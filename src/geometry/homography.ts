import type { Quad, Vec2 } from "./vec";

/** Row-major 3x3 matrix: [a b c; d e f; g h i]. Maps (x, y, 1) -> (x', y', w). */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const EPS = 1e-12;

/**
 * Projective map from the unit square to a quad (Heckbert, "Fundamentals of
 * Texture Mapping and Image Warping", 1989): (0,0)->q[0], (1,0)->q[1],
 * (1,1)->q[2], (0,1)->q[3]. Returns null when the quad is degenerate.
 */
export function squareToQuad(q: Quad): Mat3 | null {
  const [p0, p1, p2, p3] = q;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(dx3) < EPS && Math.abs(dy3) < EPS) {
    // Parallelogram: the map is affine.
    const m: Mat3 = [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
    return Math.abs(det3(m)) < EPS ? null : m;
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < EPS) return null;

  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const m: Mat3 = [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
  return Math.abs(det3(m)) < EPS ? null : m;
}

export function det3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function invert3(m: Mat3): Mat3 | null {
  const d = det3(m);
  if (Math.abs(d) < EPS) return null;
  const k = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * k,
    (m[2] * m[7] - m[1] * m[8]) * k,
    (m[1] * m[5] - m[2] * m[4]) * k,
    (m[5] * m[6] - m[3] * m[8]) * k,
    (m[0] * m[8] - m[2] * m[6]) * k,
    (m[2] * m[3] - m[0] * m[5]) * k,
    (m[3] * m[7] - m[4] * m[6]) * k,
    (m[1] * m[6] - m[0] * m[7]) * k,
    (m[0] * m[4] - m[1] * m[3]) * k,
  ];
}

export function multiply3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

/** Applies a homography; returns null for points that land on the line at infinity. */
export function applyHomography(m: Mat3, p: Vec2): Vec2 | null {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) < EPS) return null;
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

/** Homogeneous w of a point under m; its sign tells which side of the horizon the point is on. */
export function homogeneousW(m: Mat3, p: Vec2): number {
  return m[6] * p.x + m[7] * p.y + m[8];
}

/** General quad-to-quad map: src corners land exactly on dst corners. */
export function quadToQuad(src: Quad, dst: Quad): Mat3 | null {
  const a = squareToQuad(src);
  const b = squareToQuad(dst);
  if (!a || !b) return null;
  const ai = invert3(a);
  return ai ? multiply3(b, ai) : null;
}

/** Column-major Float32Array for gl.uniformMatrix3fv(loc, false, ...). */
export function toGLMatrix(m: Mat3, out = new Float32Array(9)): Float32Array {
  out[0] = m[0];
  out[1] = m[3];
  out[2] = m[6];
  out[3] = m[1];
  out[4] = m[4];
  out[5] = m[7];
  out[6] = m[2];
  out[7] = m[5];
  out[8] = m[8];
  return out;
}
