/**
 * Helpers around StampBuffer for the two effects that paint into an offscreen target: the
 * ink of "draw" and the wipe mask of "fog". A stamp is a capsule (a segment with a radius
 * and a colour, a dot when both ends coincide); the renderer draws the stamps in buffer
 * order, each one over what is already there.
 *
 * That order is the one thing worth knowing here. An ink line is laid in two passes: the
 * hand's colour, then a narrow ice-white core on top. Stamped piece by piece as the finger
 * moves, the round start of each new colour capsule lands on the end of the core of the
 * piece before it and paints it over, and the core comes out dashed or missing. InkRibbon
 * therefore re-lays the previous core after every new colour pass, and keeps its vertices
 * far enough apart that one re-laid piece is all the new capsule can reach.
 */
import { hexToRgb } from "../filters";
import type { HandRole, StampBuffer } from "../types";

export { StampBuffer } from "../types";

/** r, g, b, a in 0..1, not premultiplied: what StampBuffer.push takes. */
export type Rgba = readonly [number, number, number, number];

export function hexRgba(hex: string, alpha = 1): Rgba {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255, alpha];
}

/** The app's blue and violet (the same pair the trackers use for the two hands) and the ice white of the brackets. */
export const INK_HEX = { A: "#4a9eff", B: "#8c66ff", core: "#f4f8ff" } as const;
export const INK_A: Rgba = hexRgba(INK_HEX.A);
export const INK_B: Rgba = hexRgba(INK_HEX.B);
export const INK_CORE: Rgba = hexRgba(INK_HEX.core);
/** Wipe-mask value of a fog wipe: fully clear. The mask keeps the largest value stamped on a pixel. */
export const WIPE: Rgba = [1, 1, 1, 1];

/** Hand A (screen left) draws in blue, hand B in violet. */
export const inkColor = (role: HandRole): Rgba => (role === "B" ? INK_B : INK_A);

export const INK = {
  /** Half the width of the colour pass, frame heights (4 px on a 720 px high stage). */
  radius: 0.0055,
  /** Radius of the ice-white core as a fraction of that. */
  core: 0.4,
  /**
   * Ribbon vertices are at least this many colour radii apart. More than one radius, so the
   * round start of a new colour capsule (and its anti-aliased rim) cannot reach back past
   * the piece just before it: re-laying that one core is then always enough.
   */
  vertexSpacing: 1.25,
  /** The line end has to move this far before anything new is stamped, frame heights (a fifth of a pixel at 720p). */
  minMove: 0.0003,
  /** Unconfirmed vertices a ribbon keeps. Beyond that the withheld part ends in one straight piece. */
  maxWithheld: 96,
} as const;

/** How many more stamps fit. */
export const stampRoom = (out: StampBuffer): number => out.capacity - out.count;

/** The colour pass of one piece of ink. */
export function pushInkColor(out: StampBuffer, ax: number, ay: number, bx: number, by: number, rgba: Rgba, radius: number = INK.radius): boolean {
  return out.push(ax, ay, bx, by, radius, rgba);
}

/** The ice-white core of one piece of ink; `radius` is the radius of the colour pass it sits on. */
export function pushInkCore(out: StampBuffer, ax: number, ay: number, bx: number, by: number, radius: number = INK.radius): boolean {
  return out.push(ax, ay, bx, by, radius * INK.core, INK_CORE);
}

/**
 * One piece of ink in both passes: colour, then core. Both or neither: returns false and
 * stores nothing when the buffer has no room for two stamps. Equal ends make a dot.
 */
export function pushInkSegment(out: StampBuffer, ax: number, ay: number, bx: number, by: number, rgba: Rgba, radius: number = INK.radius): boolean {
  if (stampRoom(out) < 2) return false;
  pushInkColor(out, ax, ay, bx, by, rgba, radius);
  pushInkCore(out, ax, ay, bx, by, radius);
  return true;
}

/** One stroke of a wipe across the fog mask. */
export function pushWipe(out: StampBuffer, ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  return out.push(ax, ay, bx, by, radius, WIPE);
}

/**
 * Turns a line that grows a point at a time into ink stamps.
 *
 * Points are added as the finger moves and are either definite or withheld: a withheld
 * point is ink only if `commit` later says so (the pen was confirmed) and vanishes on
 * `discard` (it was not). `drain` stamps what is definite, in order, as far as the buffer
 * has room; the rest waits for the next frame, so a full buffer delays ink and never
 * drops it.
 *
 * The stamped line is a chain of vertices with a live end. Each drain re-stamps the piece
 * from the last vertex to wherever the line ends now, so the ink follows the finger every
 * frame; the end becomes a vertex once it is `vertexSpacing` radii away.
 */
export class InkRibbon {
  /** Points not stamped yet: x, y, and 1 when the point starts a new stroke. */
  private readonly queue: number[] = [];
  /** How many queued points are definite ink. Always a prefix of the queue. */
  private solid = 0;
  /** The last queued point is only where the line ended a frame ago: the next point replaces it. */
  private looseTail = false;
  private startNext = true;

  // What has been stamped: the vertex before the last, the last vertex, and the end of the ink.
  private hasPrev = false;
  private prevX = 0;
  private prevY = 0;
  private hasLast = false;
  private lastX = 0;
  private lastY = 0;
  private endX = 0;
  private endY = 0;

  private readonly spacing: number;

  constructor(
    private readonly radius: number = INK.radius,
    private readonly maxWithheld: number = INK.maxWithheld,
  ) {
    this.spacing = radius * INK.vertexSpacing;
  }

  /** Definite points still waiting for room in a stamp buffer. */
  get backlog(): number {
    return this.solid;
  }

  /**
   * Add the current end of the line (stage space). `aspect` makes distances isotropic.
   * A definite point makes everything queued before it definite too.
   */
  add(x: number, y: number, definite: boolean, aspect: number): void {
    const q = this.queue;
    if (this.startNext) {
      this.startNext = false;
      this.looseTail = false;
      q.push(x, y, 1);
    } else {
      let n = q.length / 3;
      // A loose tail is replaced, unless that would turn definite ink back into a maybe.
      if (this.looseTail && n > 0 && (definite || n > this.solid)) {
        q.length -= 3;
        n--;
        if (this.solid > n) this.solid = n;
      }
      // Measured from the vertex before it: the last one queued, or the last one stamped.
      const fromX = n > 0 ? q[q.length - 3] : this.lastX;
      const fromY = n > 0 ? q[q.length - 2] : this.lastY;
      const far = Math.hypot((x - fromX) * aspect, y - fromY) >= this.spacing;
      q.push(x, y, 0);
      // Past the limit the queue stops growing: its tail just follows the finger.
      this.looseTail = !far || n >= this.maxWithheld;
    }
    if (definite) this.solid = q.length / 3;
  }

  /** Everything withheld so far is ink after all. */
  commit(): void {
    this.solid = this.queue.length / 3;
  }

  /** Everything withheld so far is not ink, and the stroke ends where the definite part ended. */
  discard(): void {
    this.queue.length = this.solid * 3;
    this.looseTail = false;
    this.startNext = true;
  }

  /** The next point starts a new stroke: no ink joins it to the one before. */
  breakStroke(): void {
    this.startNext = true;
  }

  /** Forget everything, stamped or not (the picture was wiped). */
  clear(): void {
    this.queue.length = 0;
    this.solid = 0;
    this.looseTail = false;
    this.startNext = true;
    this.hasPrev = false;
    this.hasLast = false;
  }

  /**
   * Stamp the definite points into `out`, as many as fit. Returns how many strokes were
   * started. Per piece: the colour pass, the core of the piece before it again (the colour
   * pass has just covered its end), then this piece's own core.
   */
  drain(out: StampBuffer, rgba: Rgba, aspect: number): number {
    const q = this.queue;
    let started = 0;
    let i = 0;
    for (; i < this.solid; i++) {
      const x = q[i * 3];
      const y = q[i * 3 + 1];
      if (q[i * 3 + 2] === 1 || !this.hasLast) {
        // A stroke starts with a dot: the pen shows the moment it is down, moving or not.
        if (!pushInkSegment(out, x, y, x, y, rgba, this.radius)) break;
        this.hasPrev = false;
        this.hasLast = true;
        this.lastX = this.endX = x;
        this.lastY = this.endY = y;
        started++;
        continue;
      }
      if (Math.hypot((x - this.endX) * aspect, y - this.endY) < INK.minMove) continue;
      if (stampRoom(out) < (this.hasPrev ? 3 : 2)) break;
      pushInkColor(out, this.lastX, this.lastY, x, y, rgba, this.radius);
      if (this.hasPrev) pushInkCore(out, this.prevX, this.prevY, this.lastX, this.lastY, this.radius);
      pushInkCore(out, this.lastX, this.lastY, x, y, this.radius);
      this.endX = x;
      this.endY = y;
      if (Math.hypot((x - this.lastX) * aspect, y - this.lastY) >= this.spacing) {
        this.hasPrev = true;
        this.prevX = this.lastX;
        this.prevY = this.lastY;
        this.lastX = x;
        this.lastY = y;
      }
    }
    if (i > 0) {
      q.splice(0, i * 3);
      this.solid -= i;
      if (q.length === 0) this.looseTail = false;
    }
    return started;
  }
}
