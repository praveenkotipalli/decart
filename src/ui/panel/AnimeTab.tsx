import { useId } from "react";
import type { ToySettings } from "../../config/toySettings";
import { animeOn, formatClock, formatCost } from "../../toy/hud";
import type { AnimeView } from "../../toy/types";
import { pricePerSecond } from "../aiView";
import { Section, Segmented, Select } from "../controls";
import { animeDotClass } from "../hud/TogglePills";

type AnimeSettings = ToySettings & { idlePauseSec: number };

export interface AnimePresetView {
  id: string;
  label: string;
  /** The full prompt this preset sends; shown as the placeholder of the custom prompt. */
  text: string;
}

const MODEL_NAME: Record<string, string> = {
  "lucy-restyle-2": "Lucy Restyle 2 · whole-scene style",
  "lucy-2.6": "Lucy 2.6 · scene restyle",
  "lucy-2.5": "Lucy 2.5",
};

const VIEW_LABEL: Record<AnimeView, string> = {
  off: "off",
  connecting: "connecting",
  live: "live",
  stalled: "catching up",
  paused: "paused",
  unconfigured: "no key",
  error: "stopped",
  budget: "budget reached",
};

function toneOf(view: AnimeView): "off" | "busy" | "live" | "error" {
  switch (view) {
    case "live":
      return "live";
    case "connecting":
    case "stalled":
      return "busy";
    case "error":
    case "unconfigured":
      return "error";
    default:
      return "off";
  }
}

function detailOf(view: AnimeView, budget: string): string {
  switch (view) {
    case "off":
      return "Off. Press d or the button to start a session; it is billed per second only while it runs.";
    case "connecting":
      return "Connecting, about 8 s. The filter shows until the first anime frame arrives.";
    case "live":
      return "Live. Whoever is inside the frame is redrawn as anime; the picture runs about a second behind.";
    case "stalled":
      return "No fresh anime frame for a moment, so the frame shows the filter. It comes back by itself.";
    case "paused":
      return "Paused to save credits: nothing on screen was showing anime. It wakes when you make a frame.";
    case "unconfigured":
      return "The server has no Decart key. Filters and the loupe work without one.";
    case "error":
      return "The session stopped. Turn anime on again to retry.";
    case "budget":
      return `This switch-on's ${budget} are used up. Turning anime on again grants another ${budget}.`;
  }
}

const enhanceValue = (v: boolean | null): "auto" | "on" | "off" => (v === null ? "auto" : v ? "on" : "off");

/**
 * Anime: the live state and bill, the look (a preset or a custom prompt), the model,
 * and the billing guards (idle pause and budget).
 */
export function AnimeTab({
  settings,
  onChange,
  view,
  seconds,
  cost,
  allowedModels,
  presets,
  promptLimit,
  pricePerSec,
  warning,
  onToggleAnime,
}: {
  settings: AnimeSettings;
  onChange(patch: Partial<AnimeSettings>): void;
  view: AnimeView;
  seconds: number;
  cost: number;
  allowedModels: string[];
  presets: readonly AnimePresetView[];
  promptLimit: number;
  pricePerSec: number;
  warning: string | null;
  onToggleAnime(): void;
}) {
  const promptId = useId();
  const on = animeOn(view);
  const models = allowedModels.length ? allowedModels : [settings.animeModel];
  const preset = presets.find((p) => p.id === settings.animePreset) ?? presets[0];
  const custom = settings.animePrompt ?? "";
  const over = custom.length > promptLimit;
  const budgetClock = formatClock(settings.animeBudgetSec);
  const perMinute = formatCost(pricePerSec * 60);
  const maxCost = formatCost(pricePerSec * settings.animeBudgetSec);

  return (
    <>
      <Section label="Anime">
        <div className="status-box" data-tone={toneOf(view)} style={{ marginTop: 0 }}>
          <div className="status-box__head">
            <span>
              <span className={animeDotClass(view)} aria-hidden="true" />
              anime · {VIEW_LABEL[view]}
            </span>
            <button type="button" className="btn btn--ghost btn--small" aria-pressed={on} onClick={onToggleAnime}>
              {on ? "Turn off" : "Turn on"}
            </button>
          </div>
          <div className="status-box__detail">{detailOf(view, budgetClock)}</div>
          <div className="status-box__stats">
            <span>{formatClock(seconds)} billed</span>
            <span>{formatCost(cost)}</span>
            <span>{formatCost(pricePerSec)} a second</span>
          </div>
        </div>
        {warning && <p className="note anime-warning">{warning}</p>}
        <p className="note">
          Anime is off on every page load and never starts by itself. Whoever stands inside the frame (or under a loupe) is
          redrawn live by Decart; outside the frame the camera is untouched.
        </p>
      </Section>

      <Section label="Style">
        <div className="chips" role="group" aria-label="Style presets">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="chip"
              aria-pressed={settings.animePreset === p.id && settings.animePrompt === null}
              onClick={() => onChange({ animePreset: p.id, animePrompt: null })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <div className="field__row">
            <label className="field__name" htmlFor={promptId}>
              Custom prompt
            </label>
            <span className="count" data-over={over}>
              {custom.length}/{promptLimit}
            </span>
          </div>
          <textarea
            id={promptId}
            className="textarea"
            value={custom}
            placeholder={preset?.text ?? ""}
            spellCheck={false}
            aria-invalid={over || undefined}
            onChange={(e) => onChange({ animePrompt: e.target.value.trim() === "" ? null : e.target.value })}
          />
          <span className="field__help">describe the look — do not name characters, series or studios</span>
          <span className="field__help">Empty uses the selected style. Changes apply live, without reconnecting.</span>
        </div>
      </Section>

      <Section label="Model">
        <Select
          label="Model"
          value={settings.animeModel}
          onChange={(animeModel) => onChange({ animeModel })}
          options={models.map((m) => ({ value: m, label: `${MODEL_NAME[m] ?? m} · ${formatCost(pricePerSecond(m, false))}/s` }))}
          help="Restyle redraws the whole scene in one style and is the cheapest. The camera is re-requested at the model's own size."
        />
        <Segmented<"auto" | "on" | "off">
          label="Prompt enhancement"
          value={enhanceValue(settings.animeEnhance)}
          onChange={(v) => onChange({ animeEnhance: v === "auto" ? null : v === "on" })}
          options={[
            { value: "auto", label: "Auto" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
        <p className="note">Decart rewrites the prompt to fit the video. Auto follows the model: off for Restyle, on for Lucy.</p>
      </Section>

      <Section label="Billing guards">
        <Select
          label="Pause when nothing shows anime for"
          value={settings.idlePauseSec}
          onChange={(idlePauseSec) => onChange({ idlePauseSec })}
          options={[
            { value: 15, label: "15 seconds" },
            { value: 30, label: "30 seconds" },
            { value: 60, label: "60 seconds" },
            { value: 120, label: "2 minutes" },
          ]}
          help="With no frame or loupe on screen the session is paused and nothing is billed. An L or OK sign wakes it."
        />
        <Select
          label="Budget per switch-on"
          value={settings.animeBudgetSec}
          onChange={(animeBudgetSec) => onChange({ animeBudgetSec })}
          options={[
            { value: 60, label: "1 minute" },
            { value: 180, label: "3 minutes" },
            { value: 300, label: "5 minutes" },
            { value: 600, label: "10 minutes" },
          ]}
        />
        <p className="note">
          {formatCost(pricePerSec)} a second, {perMinute} a minute. Each press of <code>d</code> grants {budgetClock} of anime, at most{" "}
          {maxCost}; when it is used up anime switches off and tells you. A hidden tab pauses the session after 10 s.
        </p>
      </Section>
    </>
  );
}
