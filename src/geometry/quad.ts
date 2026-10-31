import { cross, dist, lerp, sub, type Quad, type Vec2 } from "./vec";

export type QuadValidity = "valid" | "crossed" | "concave" | "degenerate";

/** Shoelace area. Positive for P1→P4 clockwise on screen (y down), negative when mirrored. */
export function signedArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return a / 2;
}

export function centroid(q: Quad): Vec2 {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

export function perimeter(q: Quad): number {
  return dist(q[0], q[1]) + dist(q[1], q[2]) + dist(q[2], q[3]) + dist(q[3], q[0]);
}

function orient(a: Vec2, b: Vec2, c: Vec2) {
  return cross(sub(b, a), sub(c, a));
}

/** Proper intersection of segments ab and cd (shared endpoints and touching do not count). */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** A "bow-tie": opposite edges cross, e.g. when two fingers swap places. */
export function isSelfIntersecting(q: Quad): boolean {
  return segmentsIntersect(q[0], q[1], q[2], q[3]) || segmentsIntersect(q[1], q[2], q[3], q[0]);
}

export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = orient(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/**
 * Only convex, non-degenerate quads are projective images of a rectangle, so only
 * those can carry a perspective-correct texture. `minArea` is in the quad's units².
 */
export function classifyQuad(q: Quad, minArea: number, minEdge = 0, minAngleDeg = 0): QuadValidity {
  // Crossing first: a symmetric bow-tie has zero net area but is not "collapsed".
  if (isSelfIntersecting(q)) return "crossed";
  if (Math.abs(signedArea(q)) < minArea) return "degenerate";
  for (let i = 0; i < 4; i++) if (dist(q[i], q[(i + 1) % 4]) < minEdge) return "degenerate";
  if (!isConvex(q)) return "concave";
  if (minAngleDeg > 0 && minInteriorAngle(q) < minAngleDeg) return "degenerate";
  return "valid";
}

/** Smallest interior angle, degrees. A sliver (a few degrees) is a portal in name only. */
export function minInteriorAngle(q: Quad): number {
  let min = 180;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const a = sub(q[(i + 3) % 4], p);
    const b = sub(q[(i + 1) % 4], p);
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la < 1e-12 || lb < 1e-12) return 0;
    const cos = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (la * lb)));
    min = Math.min(min, (Math.acos(cos) * 180) / Math.PI);
  }
  return min;
}

/**
 * Re-orders corners by angle around the centroid so the outline no longer crosses
 * itself. Keeps q[0] first so the content stays anchored to P1's finger.
 */
export function untangle(q: Quad): Quad {
  const c = centroid(q);
  const order = [0, 1, 2, 3].sort(
    (a, b) => Math.atan2(q[a].y - c.y, q[a].x - c.x) - Math.atan2(q[b].y - c.y, q[b].x - c.x),
  );
  const start = order.indexOf(0);
  const r = [0, 1, 2, 3].map((i) => q[order[(start + i) % 4]]);
  return [r[0], r[1], r[2], r[3]];
}

/** Scales the quad about its centroid. */
export function expandQuad(q: Quad, k: number): Quad {
  const c = centroid(q);
  return q.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k })) as Quad;
}

export function lerpQuad(a: Quad, b: Quad, t: number): Quad {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

/** Width/height of the rectangle this quad most plausibly depicts (mean of opposite edges). */
export function estimateAspect(q: Quad): number {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return h > 1e-9 ? w / h : 1;
}

export function boundingBox(q: Quad) {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** Rotation of the top edge, in radians (0 = level). */
export function topEdgeAngle(q: Quad): number {
  return Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
}
