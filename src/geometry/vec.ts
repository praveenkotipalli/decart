export interface Vec2 {
  x: number;
  y: number;
}

/** Corners in portal order: P1 top-left, P2 top-right, P3 bottom-right, P4 bottom-left. */
export type Quad = [Vec2, Vec2, Vec2, Vec2];

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const cloneQuad = (q: Quad): Quad => [
  { ...q[0] },
  { ...q[1] },
  { ...q[2] },
  { ...q[3] },
];

export const mapQuad = (q: Quad, f: (p: Vec2, i: number) => Vec2): Quad => [
  f(q[0], 0),
  f(q[1], 1),
  f(q[2], 2),
  f(q[3], 3),
];
