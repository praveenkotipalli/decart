/**
 * CPU mirrors of the frame shader's geometry, used for tests, the scissor rectangle
 * and the twist detector. Nothing here knows about pixels or stage space: every
 * function works in whatever isotropic space its arguments are given in.
 */
import type { Quad, Vec2 } from "../geometry/vec";
import type { Rect } from "./types";

/**
 * Even-odd (crossing number) point-in-polygon test: the same rule as `sdQuad` in the
 * shaders. Both lobes of a self-crossing bow-tie count as inside, and a quad whose
 * corners run the "wrong" way round is inside like any other.
 */
export function insideEvenOdd(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Corner brackets: for each of the four edges, one arm from each end, `fraction` of the
 * edge long (0.5 makes the arms meet: a full outline). Returns 8 segments, two per edge,
 * in edge order 0→1, 1→2, 2→3, 3→0.
 */
export function bracketSegments(q: Quad, fraction: number): [Vec2, Vec2][] {
  const f = Math.min(0.5, Math.max(0, fraction));
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) & 3];
    const arm = { x: (b.x - a.x) * f, y: (b.y - a.y) * f };
    out.push([{ ...a }, { x: a.x + arm.x, y: a.y + arm.y }]);
    out.push([{ x: b.x - arm.x, y: b.y - arm.y }, { ...b }]);
  }
  return out;
}

/** Axis-aligned bounds of a quad, grown by `pad` on every side. */
export function quadBounds(q: Quad, pad = 0): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of q) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Where segment a→b meets segment c→d: parameters along each, or null when they do not properly cross. */
export function segmentCrossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; s: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const s = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t > 0 && t < 1 && s > 0 && s < 1 ? { t, s } : null;
}

/**
 * The twist of a hand frame [A index, B index, B thumb, A thumb]: whether the top edge
 * (0→1) crosses the bottom edge (3→2), and how far along each (0..1). This is what one
 * turned-over hand does to the quad.
 */
export function crossing(q: Quad): { crossed: boolean; t: number; s: number } {
  const hit = segmentCrossing(q[0], q[1], q[3], q[2]);
  return hit ? { crossed: true, t: hit.t, s: hit.s } : { crossed: false, t: 0, s: 0 };
}

/** True when any two opposite edges cross (top/bottom or left/right): the quad is a bow-tie. */
export function selfIntersects(q: Quad): boolean {
  return segmentCrossing(q[0], q[1], q[3], q[2]) !== null || segmentCrossing(q[1], q[2], q[0], q[3]) !== null;
}

/** Length of the bounding-box diagonal. */
export function boundsDiagonal(q: Quad): number {
  const b = quadBounds(q);
  return Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
}

/**
 * A region of the camera frame (fractions of the unmirrored frame) as it appears on the
 * mirrored display. With `mirror` false the rect is returned unchanged.
 */
export function displayRect(rect: Rect, mirror: boolean): Rect {
  return mirror ? { x: 1 - rect.x - rect.w, y: rect.y, w: rect.w, h: rect.h } : { ...rect };
}

/**
 * Stage position → texture coordinate in the AI frame, given the stage rect the AI frame
 * covers (display orientation). `inside` is false where the AI frame has no pixels.
 */
export function stageToAiUv(st: Vec2, aiRect: Rect): { uv: Vec2; inside: boolean } {
  const uv = { x: (st.x - aiRect.x) / aiRect.w, y: (st.y - aiRect.y) / aiRect.h };
  return { uv, inside: uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1 };
}
