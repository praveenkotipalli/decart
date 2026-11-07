/**
 * Style presets and prompt assembly for the hand-frame toy's anime source.
 *
 * Two model families take different prompt shapes. `lucy-restyle-2` is a pure restyle
 * model: a short description of the look, prefixed with "Transform to", works best
 * with prompt enhancement off. The editing models (`lucy-2.6`) follow an instruction,
 * so the same body is prefixed with "Restyle the whole scene as" and enhancement stays
 * on. Both get the same suffix, which keeps the people and the room recognisable: the
 * frame is a window on the same pixels, not a new picture.
 *
 * Decart refuses prompts that name copyrighted IP (verified against the live API, see
 * prompts.ts), so every preset describes a look and never a franchise, character or
 * studio. tests/anime.test.ts checks the bodies against a block list of such names.
 */
import { PROMPT_LIMIT } from "./prompts";

export interface AnimePreset {
  id: string;
  /** Short lowercase chip label. */
  label: string;
  /** The look, without prefix or suffix. */
  body: string;
}

export const ANIME_DEFAULT_PRESET = "anime-clean";

export const ANIME_PRESETS: readonly AnimePreset[] = [
  {
    id: "anime-clean",
    label: "clean",
    body:
      "clean modern 2D anime: crisp thin dark outlines, flat cel shading with one soft shadow tone, smooth skin, " +
      "large expressive eyes with bright highlights, glossy simplified hair, bright natural colors",
  },
  {
    id: "anime-shoujo",
    label: "shoujo",
    body:
      "soft pastel shoujo anime: delicate thin brown linework, pink, peach and lavender palette, gentle gradient shading, " +
      "rosy cheeks, large sparkling eyes with long lashes, airy bright light",
  },
  {
    id: "anime-90s-cel",
    label: "90s cel",
    body:
      "1990s hand-painted cel anime: bold black ink outlines, hard-edged two-tone shadows, slightly muted warm colors, " +
      "sharp angular hair highlights, fine film grain, soft bloom on bright areas",
  },
  {
    id: "manga-ink",
    label: "manga ink",
    body:
      "black-and-white manga ink art: confident black brush outlines, halftone screentone dot shading, solid black shadow shapes, " +
      "clean white highlights, no color, no text, no panel borders",
  },
  {
    id: "anime-watercolor",
    label: "watercolor",
    body:
      "watercolor storybook anime: soft pencil outlines, translucent watercolor washes, gentle color bleeds, visible paper texture, " +
      "warm muted pastel palette, simple rounded faces with big gentle eyes",
  },
];

/** Follows every preset body: the toy restyles the picture, it never replaces who or what is in it. */
export const ANIME_SUFFIX =
  ", on people and background alike. Keep each person's pose, face position, hairstyle, hands and clothing shapes, and the background layout.";
/** Restyle models take a description of the target look. */
export const RESTYLE_PREFIX = "Transform to ";
/** Editing models take an instruction that names the whole scene, or they edit only the person. */
export const LUCY_PREFIX = "Restyle the whole scene as ";

export interface AnimeModelInfo {
  /** Short lowercase label for chips and toasts. */
  label: string;
  /** USD per billed generation second (Decart list price). */
  pricePerSec: number;
  /** The model's native frame, which the camera is opened at so nothing is rescaled. */
  width: number;
  height: number;
}

/** The two pinned ids the toy knows the size and price of (sizes confirmed in the SDK's model table). */
export const ANIME_MODELS: Record<string, AnimeModelInfo> = {
  "lucy-restyle-2": { label: "lucy restyle 2", pricePerSec: 0.01, width: 1280, height: 704 },
  "lucy-2.6": { label: "lucy 2.6", pricePerSec: 0.02, width: 1280, height: 720 },
};

/** Fallback order when the preferred model is not allowed by the server. */
export const ANIME_MODEL_FALLBACKS: readonly string[] = ["lucy-restyle-2", "lucy-2.6"];

/**
 * Size and price of a model. An unknown id gets the dearer known price and the common
 * camera size, so a cost shown to the user never under-reports.
 */
export function animeModelInfo(model: string): AnimeModelInfo {
  if (Object.hasOwn(ANIME_MODELS, model)) return ANIME_MODELS[model];
  const dearest = Math.max(...Object.values(ANIME_MODELS).map((m) => m.pricePerSec));
  return { label: model, pricePerSec: dearest, width: 1280, height: 720 };
}

/** The restyle family ("lucy-restyle-*") takes a description; everything else is an editing model. */
export function isRestyleModel(model: string): boolean {
  return /restyle/i.test(model);
}

/** The preset with this id, or the default preset for an id that no longer exists. */
export function animePreset(presetId: string): AnimePreset {
  return ANIME_PRESETS.find((p) => p.id === presetId) ?? ANIME_PRESETS.find((p) => p.id === ANIME_DEFAULT_PRESET) ?? ANIME_PRESETS[0];
}

/**
 * The prompt sent to Decart for a preset (or a custom prompt) on a model.
 *
 * A non-empty custom prompt is sent as written, trimmed and cut to Decart's limit, with
 * no prefix or suffix: the user asked for exactly that text. `enhance` null or undefined
 * means the model's default — off for restyle models, on for the editing models.
 */
export function animePrompt(presetId: string, model: string, custom?: string | null, enhance?: boolean | null): { text: string; enhance: boolean } {
  const restyle = isRestyleModel(model);
  const own = (custom ?? "").trim();
  const text = own ? own.slice(0, PROMPT_LIMIT).trimEnd() : (restyle ? RESTYLE_PREFIX : LUCY_PREFIX) + animePreset(presetId).body + ANIME_SUFFIX;
  return { text, enhance: enhance ?? !restyle };
}

/**
 * The model to connect with: the preferred one when the server allows it, else the first
 * allowed fallback, else null. A "-latest" alias is never chosen, even when preferred and
 * allowed: it floats to whatever Decart ships next, so its size and price would be unknown.
 */
export function resolveAnimeModel(preferred: string, allowed: readonly string[]): string | null {
  if (!preferred.endsWith("-latest") && allowed.includes(preferred)) return preferred;
  return ANIME_MODEL_FALLBACKS.find((m) => allowed.includes(m)) ?? null;
}
