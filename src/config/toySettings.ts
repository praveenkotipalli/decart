import type { EffectId, FilterId, TintId } from "../toy/types";

/**
 * Settings of the hand-frame toy (the "window" frame style). They are stored next to
 * the classic portal's settings; none of the classic fields is reused for the toy.
 *
 * Whether anime is switched on is deliberately NOT a setting: it is engine state and
 * is off on every page load, so a reload can never start a billed session.
 */
export interface ToySettings {
  schema: 2;
  /** "window" = the hand-frame toy; "classic" = the original glowing portal. */
  frameStyle: "window" | "classic";
  effect: EffectId;
  filter: FilterId;
  /** The last filter that was not "none": shown in its place whenever anime is not on screen. */
  lastTint: TintId;
  /** Tile-glitch transition when the look inside the frame changes. */
  glitch: boolean;
  trackers: boolean;
  faceBox: "auto" | "on" | "off";
  /** 1.5 – 3 */
  loupeZoom: number;
  /** Include the tracker graphics in snapshots and recordings. */
  captureTrackers: boolean;
  animeModel: string;
  animePreset: string;
  /** null = the preset's text. */
  animePrompt: string | null;
  /** null = the model's default (restyle: off, lucy: on). */
  animeEnhance: boolean | null;
  /** Billed seconds granted each time anime is switched on. */
  animeBudgetSec: number;
}

export const TOY_DEFAULTS: ToySettings = {
  schema: 2,
  frameStyle: "window",
  effect: "frame",
  filter: "rose",
  lastTint: "rose",
  glitch: true,
  trackers: true,
  faceBox: "auto",
  loupeZoom: 2,
  captureTrackers: true,
  animeModel: "lucy-restyle-2",
  animePreset: "anime-clean",
  animePrompt: null,
  animeEnhance: null,
  animeBudgetSec: 180,
};
