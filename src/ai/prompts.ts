/**
 * Prompt presets for Decart's realtime models. Lucy 2.6 is an *editing* model:
 * prompts work best as an instruction that starts with a command ("Substitute",
 * "Add", "Replace") and names the target, then the visible details. Decart caps
 * prompts at roughly 750 characters; prompt enhancement is on by default.
 *
 * Decart refuses prompts that name copyrighted characters ("Content contains
 * copyrighted IP that cannot be generated" — verified against the live API), so
 * these presets describe the look of a white-haired, blindfolded sorcerer with
 * blue cursed energy instead of naming any character or series.
 */
export interface PromptPreset {
  id: string;
  label: string;
  /** Models this prompt is written for. */
  models: string[];
  text: string;
}

export const PROMPT_LIMIT = 750;

const LUCY = ["lucy-2.6", "lucy-2.5", "lucy-latest"];

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "blindfold",
    label: "Blindfolded sorcerer",
    models: LUCY,
    text:
      "Substitute the person with an anime sorcerer: tousled snow-white hair, a black blindfold over the eyes, " +
      "a dark navy high-collared uniform. Add crackling electric-blue energy swirling around the hands and shoulders. " +
      "Cinematic anime lighting with a deep blue rim light and a dramatic night atmosphere. Keep the person's pose, " +
      "movement and framing. No text.",
  },
  {
    id: "ice-eyes",
    label: "Luminous eyes",
    models: LUCY,
    text:
      "Substitute the person with a white-haired anime sorcerer with luminous ice-blue eyes and pale lashes, wearing a " +
      "dark high-collared jacket. Add a faint aura of blue energy and drifting light particles around the head. " +
      "Soft cinematic anime shading, cold blue key light. Keep the person's pose, expression and framing.",
  },
  {
    id: "void",
    label: "Infinite void",
    models: LUCY,
    text:
      "Substitute the person with a white-haired sorcerer in a black blindfold and dark high-collared uniform, and replace " +
      "the background with an infinite starry void of swirling blue and violet light. Glowing blue energy rings around " +
      "the hands. Cinematic anime lighting. Keep the person's pose and framing.",
  },
  {
    id: "restyle",
    label: "Anime restyle",
    models: ["lucy-restyle-2", "lucy-restyle-latest"],
    text:
      "Cinematic modern anime style, cel-shaded characters, white hair, deep navy and electric-blue palette, glowing blue " +
      "energy accents, dramatic night lighting, crisp clean line art.",
  },
];

/** Defaults shipped by earlier versions that Decart refuses; replaced on load. */
export const RETIRED_PROMPTS = [
  "Substitute the person with Gojo Satoru from Jujutsu Kaisen: tousled snow-white hair, a black blindfold over the eyes, " +
    "a dark navy high-collared uniform. Add crackling electric-blue cursed energy swirling around the hands and shoulders. " +
    "Cinematic anime lighting with a deep blue rim light and a dramatic night atmosphere. Keep the person's pose, " +
    "movement and framing. No text.",
];

export function presetsFor(model: string): PromptPreset[] {
  const own = PROMPT_PRESETS.filter((p) => p.models.includes(model));
  return own.length ? own : PROMPT_PRESETS;
}

export function defaultPromptFor(model: string): string {
  return presetsFor(model)[0].text;
}
