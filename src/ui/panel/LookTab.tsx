import type { ToySettings } from "../../config/toySettings";
import { FILTER_ORDER, FILTERS } from "../../toy/filters";
import { EFFECT_ORDER, type EffectId, type FilterId } from "../../toy/types";
import { Section, Segmented, Slider, Switch } from "../controls";
import { Swatch } from "../hud/TogglePills";

const EFFECT_LABEL: Record<EffectId, string> = { frame: "Frame", draw: "Draw", particles: "Particles", fog: "Fog", vanish: "Vanish" };

const EFFECT_NOTE: Record<EffectId, string> = {
  frame: "Two L shapes open a frame; whoever is inside gets the filter, or the anime picture when it is live.",
  draw: "Point to draw, open your hand to lift the pen, hold a fist to wipe the ink.",
  particles: "Your hands shed sparks as they move; a fist gathers them.",
  fog: "The glass is misted over; wipe it with an open hand or write with one finger.",
  vanish: "Memorise the empty room, then whoever is inside the frame disappears.",
};

/** Look: the effect, the filter, how the look changes, and what is drawn over the picture. */
export function LookTab({ settings, onChange }: { settings: ToySettings; onChange(patch: Partial<ToySettings>): void }) {
  const setFilter = (filter: FilterId) => onChange(filter === "none" ? { filter } : { filter, lastTint: filter });
  return (
    <>
      <Section label="Effect">
        <Segmented<EffectId>
          label="Effect"
          value={settings.effect}
          onChange={(effect) => onChange({ effect })}
          options={EFFECT_ORDER.map((id) => ({ value: id, label: EFFECT_LABEL[id] }))}
        />
        <p className="note">
          {EFFECT_NOTE[settings.effect]} Keys <code>1</code>–<code>5</code> switch effects.
        </p>
      </Section>

      <Section label="Filter">
        <div className="swatches" role="radiogroup" aria-label="Filter">
          {FILTER_ORDER.map((id) => {
            const f = FILTERS[id];
            return (
              <button key={id} type="button" role="radio" className="swatch-btn" aria-checked={settings.filter === id} onClick={() => setFilter(id)}>
                <Swatch colors={f.swatch} size={22} />
                <span className="swatch-btn__label">{f.label}</span>
              </button>
            );
          })}
        </div>
        <p className="note">
          A luminance ramp over the picture inside the frame. <code>f</code> or flipping one hand steps through them. Clear shows the
          anime picture as it is; without anime the last tint stays, so the frame is never invisible.
        </p>
        <Switch
          label="Glitch transition"
          help="A short tile glitch when the look inside the frame changes. A plain cross-fade with reduced motion."
          checked={settings.glitch}
          onChange={(glitch) => onChange({ glitch })}
        />
        <Slider
          label="Loupe zoom"
          value={settings.loupeZoom}
          min={1.5}
          max={3}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(loupeZoom) => onChange({ loupeZoom })}
          help="An OK sign opens a round magnifier between thumb and index finger."
        />
      </Section>

      <Section label="Trackers">
        <Switch
          label="Trackers"
          help="Hairline hand graphics on the picture. Key t."
          checked={settings.trackers}
          onChange={(trackers) => onChange({ trackers })}
        />
        <Segmented<ToySettings["faceBox"]>
          label="Face box"
          value={settings.faceBox}
          onChange={(faceBox) => onChange({ faceBox })}
          options={[
            { value: "auto", label: "Auto" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
        <p className="note">
          A small detector that only runs when an effect needs to know whether someone is in view (vanish). Auto starts it on demand
          and stops it when tracking gets slow.
        </p>
        <Switch
          label="Trackers in captures"
          help="Include the tracker graphics in snapshots and recordings."
          checked={settings.captureTrackers}
          onChange={(captureTrackers) => onChange({ captureTrackers })}
        />
      </Section>
    </>
  );
}
