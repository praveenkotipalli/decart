/**
 * Copy and view logic of the hand-frame HUD. Pure: no React, no DOM, no clock.
 *
 * Everything the bands say is decided here so that the wording can be unit-tested
 * character for character and the components stay presentational.
 */
import type { AnimeView, EffectId, FilterId, PlateState, ToyStatus } from "./types";

export type FrameStyle = "window" | "classic";

// ── Legend ────────────────────────────────────────────────────────────────────

export interface LegendItem {
  key: string;
  label: string;
  /** The first six items are the reel's own text, verbatim. */
  fromReel: boolean;
}

export const LEGEND: readonly LegendItem[] = [
  { key: "h", label: "hide", fromReel: true },
  { key: "g", label: "full screen", fromReel: true },
  { key: "1–5", label: "effects", fromReel: true },
  { key: "d", label: "anime", fromReel: true },
  { key: "f", label: "filter", fromReel: true },
  { key: "t", label: "trackers", fromReel: true },
  { key: "c", label: "clear", fromReel: false },
  { key: "l", label: "lock", fromReel: false },
  { key: "s", label: "snap", fromReel: false },
  { key: "e", label: "rec", fromReel: false },
  { key: "p", label: "tune", fromReel: false },
];

/**
 * Keys of the legend items that do nothing right now; the legend draws them at 0.35 alpha.
 * `d` and `f` only act in effect "frame"; `c` is the per-effect action and has none in
 * "frame"; `l` locks a frame, which only "frame" and "vanish" have.
 */
export function legendDim(effect: EffectId, frameStyle: FrameStyle): ReadonlySet<string> {
  if (frameStyle === "classic") return new Set(["h", "1–5", "f", "c"]);
  const dim = new Set<string>();
  if (effect !== "frame") {
    dim.add("d");
    dim.add("f");
  }
  if (effect === "frame") dim.add("c");
  if (effect !== "frame" && effect !== "vanish") dim.add("l");
  return dim;
}

// ── Hint line ─────────────────────────────────────────────────────────────────

/** The reel's line, character for character. */
export const REEL_HINT = "two L shapes: whoever is inside becomes anime · flip one hand to change the filter · OK sign for a loupe";

const FRAME_OPENER = "two L shapes make a frame";

/** The frame hint for each anime state. */
export const ANIME_HINTS: Record<Exclude<AnimeView, "budget">, string> = {
  live: REEL_HINT,
  off: `${FRAME_OPENER} · flip one hand to change the filter · OK sign for a loupe · d for anime`,
  connecting: `${FRAME_OPENER} · anime is connecting, about 8 s — the filter shows until it is live`,
  stalled: `${FRAME_OPENER} · anime is connecting, about 8 s — the filter shows until it is live`,
  paused: `${FRAME_OPENER} · anime is paused to save credits and wakes when you frame`,
  unconfigured: `${FRAME_OPENER} · anime needs a Decart key on the server · filters and the loupe work without one`,
  error: `${FRAME_OPENER} · anime stopped — press d to retry`,
};

export const HINTS = {
  paused: "tracking paused · press space",
  locked: "frame locked · press l to release",
  noHands: "raise both hands and make two L shapes — index up, thumb out",
  oneL: "that's one L · bring in your other hand",
  draw: "point to draw · open your hand to lift the pen · hold a fist to wipe it clean · c clears",
  particles: "move your hands to shed sparks · faster hands, more sparks · close a fist to gather them",
  fog: "wipe the glass with an open hand · write in it with one finger · it mists over again",
  vanishNoPlate: "step out of view and press c — the empty room is remembered after a 3 s countdown",
  vanishReady: "two L shapes: whoever is inside disappears · c memorises the room again",
} as const;

/** Default budget per `d`, used only for the wording of the budget hint. */
export const DEFAULT_BUDGET_SEC = 180;

function minutesPhrase(sec: number): string {
  if (sec % 60 === 0) {
    const m = sec / 60;
    return m === 1 ? "1 minute" : `${m} minutes`;
  }
  return `${sec} s`;
}

export function budgetHint(budgetSec = DEFAULT_BUDGET_SEC): string {
  return `${FRAME_OPENER} · anime budget reached — press d for another ${minutesPhrase(budgetSec)}`;
}

function animeHint(view: AnimeView, budgetSec: number): string {
  return view === "budget" ? budgetHint(budgetSec) : ANIME_HINTS[view];
}

export interface HintInput {
  effect: EffectId;
  anime: AnimeView;
  gate: ToyStatus["gate"];
  locked: boolean;
  handsFresh: number;
  handsIdle: boolean;
  oneL: boolean;
  plate: PlateState;
  countdown: number;
  paused: boolean;
  /** Billed seconds per `d`; only the wording of the budget hint uses it. */
  budgetSec?: number;
}

/**
 * The one line under the picture. Always non-empty.
 *
 * Effect "frame": paused → locked → the anime-state line while the frame is open or
 * hands are present → no hands for 1.5 s → one L held → the anime-state line.
 * The other effects only yield to "paused" (and "locked" where a frame exists).
 */
export function hintFor(s: HintInput): string {
  const budgetSec = s.budgetSec ?? DEFAULT_BUDGET_SEC;
  if (s.paused) return HINTS.paused;
  switch (s.effect) {
    case "frame": {
      if (s.locked) return HINTS.locked;
      if (s.gate === "open" || s.handsFresh > 0) return animeHint(s.anime, budgetSec);
      if (s.handsIdle) return HINTS.noHands;
      if (s.oneL) return HINTS.oneL;
      return animeHint(s.anime, budgetSec);
    }
    case "draw":
      return HINTS.draw;
    case "particles":
      return HINTS.particles;
    case "fog":
      return HINTS.fog;
    case "vanish": {
      if (s.locked) return HINTS.locked;
      if (s.countdown > 0) return `stay out of view · memorising the room in ${Math.ceil(s.countdown)} s`;
      return s.plate === "ready" ? HINTS.vanishReady : HINTS.vanishNoPlate;
    }
  }
}

// ── Numbers ───────────────────────────────────────────────────────────────────

/** `$0.34` — dollars with two decimals, never negative. */
export function formatCost(cost: number): string {
  return `$${Math.max(0, cost).toFixed(2)}`;
}

/** `0:42`, `3:00` — whole seconds as m:ss. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Anime pill suffix and the status line ────────────────────────────────────

/** Mono text after "anime" in its pill. Empty when anime is off. */
export function animeSuffix(view: AnimeView, s: { seconds: number; cost: number; connectingSec: number }): string {
  switch (view) {
    case "live":
      return `live ${formatClock(s.seconds)} · ${formatCost(s.cost)}`;
    case "stalled":
      return `stalled ${formatClock(s.seconds)} · ${formatCost(s.cost)}`;
    case "connecting":
      return `connecting ${Math.max(0, Math.floor(s.connectingSec))} s`;
    case "paused":
      return "paused";
    case "unconfigured":
      return "no key";
    case "error":
      return "error";
    case "budget":
      return "budget";
    case "off":
      return "";
  }
}

/** Anime is switched on in these views (the pill reads as pressed). */
export function animeOn(view: AnimeView): boolean {
  return view === "connecting" || view === "live" || view === "stalled" || view === "paused";
}

export interface StatusLineInput {
  renderFps: number;
  trackFps: number;
  hands: number;
  anime: AnimeView;
  aiFps: number;
  /** Glass-to-glass lag; null when unknown. */
  lagMs: number | null;
  seconds: number;
  cost: number;
}

/**
 * `60 fps · track 14 hz · 2 hands`, and with anime live also
 * `anime 22 fps · 0.9 s behind · 34 s · $0.34`. The seconds and dollars stay on while a
 * paused, stalled or exhausted session still has a bill, so the cost is never hidden.
 * The anime part always begins with "anime", which lets the component break the line there.
 */
export function statusLineFor(s: StatusLineInput): string {
  const hands = `${Math.max(0, Math.round(s.hands))} ${Math.round(s.hands) === 1 ? "hand" : "hands"}`;
  const parts = [`${Math.max(0, Math.round(s.renderFps))} fps`, `track ${Math.max(0, Math.round(s.trackFps))} hz`, hands];
  const seconds = Math.max(0, Math.floor(s.seconds));
  if (s.anime === "live") {
    const anime = [`anime ${Math.max(0, Math.round(s.aiFps))} fps`];
    if (s.lagMs != null && Number.isFinite(s.lagMs)) anime.push(`${(Math.max(0, s.lagMs) / 1000).toFixed(1)} s behind`);
    anime.push(`${seconds} s`, formatCost(s.cost));
    parts.push(anime.join(" · "));
  } else if (s.anime !== "off" && seconds > 0) {
    parts.push(`anime ${seconds} s · ${formatCost(s.cost)}`);
  }
  return parts.join(" · ");
}

/** Where the status line may break into two: before its anime readout. */
export function statusLineParts(text: string): { base: string; anime: string | null } {
  const i = text.indexOf(" · anime ");
  if (i < 0) return { base: text, anime: null };
  return { base: text.slice(0, i), anime: text.slice(i + 3) };
}

// ── What the HUD components receive ──────────────────────────────────────────

export interface ToyHudStatus {
  effect: EffectId;
  /** The effective filter: what the pill shows. */
  filter: FilterId;
  trackers: boolean;
  anime: AnimeView;
  animeSuffix: string;
  hint: string;
  statusLine: string;
  cameraOn: boolean;
  recording: boolean;
  panelOpen: boolean;
  fullscreen: boolean;
  /** Synthetic hands instead of a camera: the utility row shows a small tag. */
  simulated: boolean;
}

export interface ToyHudActions {
  setEffect(e: EffectId): void;
  toggleTrackers(): void;
  toggleAnime(): void;
  cycleFilter(dir: 1 | -1): void;
  toggleCamera(): void;
  snapshot(): void;
  toggleRecording(): void;
  togglePanel(): void;
  hideChrome(): void;
  showChrome(): void;
}
