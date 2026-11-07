/**
 * Colour filters of the hand frame. A filter is a luminance ramp: each pixel's Rec. 601
 * luma picks a colour from a gradient. The ramps are baked into one small lookup
 * texture (one row per filter) and applied after the source (camera or AI picture),
 * inside the frame and the loupe only.
 */
import type { FilterId, TintId } from "./types";

export type RampStop = readonly [position: number, hex: string];

export interface FilterDef {
  id: FilterId;
  label: string;
  /** Row of the lookup texture; -1 = no filter. */
  row: number;
  stops: readonly RampStop[] | null;
  /** Two colours for the UI swatch: shadow side, highlight side. */
  swatch: readonly [string, string];
}

export const FILTERS: Record<FilterId, FilterDef> = {
  rose: {
    id: "rose",
    label: "rose",
    row: 0,
    stops: [
      [0, "#12030C"],
      [0.12, "#5A0322"],
      [0.28, "#93043A"],
      [0.45, "#B83665"],
      [0.62, "#E2729A"],
      [0.8, "#F7B4C6"],
      [1, "#FDE3E5"],
    ],
    swatch: ["#93043A", "#F7B4C6"],
  },
  none: { id: "none", label: "clear", row: -1, stops: null, swatch: ["#3A4257", "#E9EDF7"] },
  cobalt: {
    id: "cobalt",
    label: "cobalt",
    row: 1,
    stops: [
      [0, "#03040B"],
      [0.2, "#0C1650"],
      [0.45, "#1F4FC4"],
      [0.64, "#4A9EFF"],
      [0.84, "#A8D4FF"],
      [1, "#F2F8FF"],
    ],
    swatch: ["#1F4FC4", "#A8D4FF"],
  },
  violet: {
    id: "violet",
    label: "violet",
    row: 2,
    stops: [
      [0, "#05030D"],
      [0.22, "#24106B"],
      [0.5, "#6A43E0"],
      [0.66, "#8C66FF"],
      [0.86, "#C9B8FF"],
      [1, "#F6F1FF"],
    ],
    swatch: ["#6A43E0", "#C9B8FF"],
  },
  silver: {
    id: "silver",
    label: "silver",
    row: 3,
    stops: [
      [0, "#040508"],
      [0.3, "#2A303E"],
      [0.6, "#8790A6"],
      [0.85, "#D5DBEA"],
      [1, "#FAFBFF"],
    ],
    swatch: ["#2A303E", "#D5DBEA"],
  },
};

/** The order `f` and a hand flip step through. */
export const FILTER_ORDER: readonly FilterId[] = ["rose", "none", "cobalt", "violet", "silver"];
export const LUT_ROWS = 4;
export const LUT_WIDTH = 256;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Rec. 601 luma of an sRGB triple (same weights as the shader). */
export const luma = (c: readonly [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** Colour of a ramp at `t` in 0..1, linear in sRGB between stops; channels 0..255. */
export function sampleRamp(stops: readonly RampStop[], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const [p0, h0] = stops[i];
  const [p1, h1] = stops[Math.min(i + 1, stops.length - 1)];
  const a = hexToRgb(h0);
  const b = hexToRgb(h1);
  const k = p1 > p0 ? Math.min(1, Math.max(0, (x - p0) / (p1 - p0))) : 0;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** RGBA8 lookup texture, LUT_WIDTH × LUT_ROWS, row r = the filter with `row === r`. */
export function buildLut(): Uint8Array {
  const out = new Uint8Array(LUT_WIDTH * LUT_ROWS * 4);
  for (const def of Object.values(FILTERS)) {
    if (!def.stops || def.row < 0) continue;
    for (let x = 0; x < LUT_WIDTH; x++) {
      const c = sampleRamp(def.stops, x / (LUT_WIDTH - 1));
      const o = (def.row * LUT_WIDTH + x) * 4;
      out[o] = Math.round(c[0]);
      out[o + 1] = Math.round(c[1]);
      out[o + 2] = Math.round(c[2]);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * The next filter in the cycle. With `skipNone` the cycle passes over "none": without
 * anime on screen an unfiltered frame would be invisible.
 */
export function nextFilter(id: FilterId, dir: 1 | -1, skipNone: boolean): FilterId {
  const n = FILTER_ORDER.length;
  let i = Math.max(0, FILTER_ORDER.indexOf(id));
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (!(skipNone && FILTER_ORDER[i] === "none")) return FILTER_ORDER[i];
  }
  return id;
}

/** The filter actually applied: "none" is replaced by the last tint whenever anime is not showing. */
export function effectiveFilter(filter: FilterId, animeShowing: boolean, lastTint: TintId): FilterId {
  return filter === "none" && !animeShowing ? lastTint : filter;
}

/** What is inside the frame: a filter row (-1 = none) over the camera (anime 0) or the AI picture (anime 1). */
export interface Treatment {
  row: number;
  anime: 0 | 1;
}

export interface TransitionState {
  from: Treatment;
  to: Treatment;
  /** 0..1; 1 = idle. */
  progress: number;
  /** Changes with every transition so the tile pattern differs each time. */
  seed: number;
  /** Tile glitch (true) or plain cross-fade (false). */
  tiles: boolean;
}

/**
 * Animates every change of treatment: a filter change, anime going live, anime stalling
 * or being switched off. One mechanism, so each of those events reads the same way.
 */
export class TreatmentTransition {
  private from: Treatment;
  private to: Treatment;
  private startedAt = -Infinity;
  private duration: number;
  private tiles = true;
  private seed = 0;

  constructor(
    initial: Treatment,
    private tilesMs = 360,
    private fadeMs = 150,
  ) {
    this.from = { ...initial };
    this.to = { ...initial };
    this.duration = tilesMs;
  }

  get target(): Treatment {
    return { ...this.to };
  }

  /** Start a transition to `next`. No-op when it already is the target. */
  set(next: Treatment, time: number, tiles: boolean) {
    if (next.row === this.to.row && next.anime === this.to.anime) return;
    // A change that arrives mid-transition starts from the look being shown most.
    const p = this.progressAt(time);
    this.from = p >= 0.5 ? { ...this.to } : { ...this.from };
    this.to = { ...next };
    this.startedAt = time;
    this.tiles = tiles;
    this.duration = tiles ? this.tilesMs : this.fadeMs;
    this.seed = (this.seed + 1) % 4096;
  }

  /** Jump straight to `next` with no animation (used when nothing is on screen). */
  snap(next: Treatment) {
    this.from = { ...next };
    this.to = { ...next };
    this.startedAt = -Infinity;
  }

  private progressAt(time: number): number {
    if (this.startedAt === -Infinity) return 1;
    return Math.min(1, Math.max(0, (time - this.startedAt) / Math.max(1, this.duration)));
  }

  state(time: number): TransitionState {
    const progress = this.progressAt(time);
    return { from: { ...this.from }, to: { ...this.to }, progress, seed: this.seed, tiles: this.tiles };
  }
}
