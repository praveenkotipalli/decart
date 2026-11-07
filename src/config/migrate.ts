import { EFFECT_ORDER, type FilterId } from "../toy/types";
import type { ToySettings } from "./toySettings";

const FILTER_IDS: readonly FilterId[] = ["rose", "none", "cobalt", "violet", "silver"];

type Loose = Record<string, unknown>;

const isObject = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Turns whatever was stored (a v1 object, a v2 object, or garbage) into current settings.
 *
 * - Every classic field keeps its stored value.
 * - Toy fields are validated one by one; anything missing or malformed takes its default.
 * - Coming from v1 only: two tracking defaults changed, and they move only when the user
 *   still had the old default.
 * - Nothing here can switch anime on: that is not a stored setting.
 *
 * Pure, and it takes the defaults as an argument so it can be tested without the store.
 */
export function migrateSettings<T extends ToySettings & { gestures?: unknown; prompt?: unknown }>(
  raw: unknown,
  defaults: T,
  retiredPrompts: readonly string[] = [],
): T {
  if (!isObject(raw)) return defaults;
  const saved: Loose = { ...raw };
  const fromV1 = saved.schema !== 2;

  if (typeof saved.prompt === "string" && retiredPrompts.includes(saved.prompt)) delete saved.prompt;
  // A field removed from the store must never come back from an old entry.
  delete saved.anime;
  delete saved.animeOn;

  const d = defaults as unknown as Loose;
  const out: Loose = { ...d, ...saved };
  if (isObject(d.gestures)) out.gestures = { ...d.gestures, ...(isObject(saved.gestures) ? saved.gestures : {}) };

  if (fromV1) {
    if (saved.detectionConfidence === 0.6) out.detectionConfidence = d.detectionConfidence;
    if (saved.idlePauseSec === 45) out.idlePauseSec = d.idlePauseSec;
  }

  const t = defaults as ToySettings;
  const toy: ToySettings = {
    schema: 2,
    frameStyle: oneOf(saved.frameStyle, ["window", "classic"] as const, t.frameStyle),
    effect: oneOf(saved.effect, EFFECT_ORDER, t.effect),
    filter: oneOf(saved.filter, FILTER_IDS, t.filter),
    lastTint: oneOf(saved.lastTint, ["rose", "cobalt", "violet", "silver"] as const, t.lastTint),
    glitch: bool(saved.glitch, t.glitch),
    trackers: bool(saved.trackers, t.trackers),
    faceBox: oneOf(saved.faceBox, ["auto", "on", "off"] as const, t.faceBox),
    loupeZoom: num(saved.loupeZoom, t.loupeZoom, 1.5, 3),
    captureTrackers: bool(saved.captureTrackers, t.captureTrackers),
    animeModel: typeof saved.animeModel === "string" && saved.animeModel ? saved.animeModel : t.animeModel,
    animePreset: typeof saved.animePreset === "string" && saved.animePreset ? saved.animePreset : t.animePreset,
    animePrompt: typeof saved.animePrompt === "string" && saved.animePrompt.trim() ? saved.animePrompt : null,
    animeEnhance: typeof saved.animeEnhance === "boolean" ? saved.animeEnhance : null,
    animeBudgetSec: num(saved.animeBudgetSec, t.animeBudgetSec, 30, 900),
  };
  return { ...out, ...toy } as T;
}
