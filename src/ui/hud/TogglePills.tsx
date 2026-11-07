import { FILTERS } from "../../toy/filters";
import { animeOn, type ToyHudActions, type ToyHudStatus } from "../../toy/hud";
import type { AnimeView } from "../../toy/types";

/** The leading dot of the anime pill: the existing dot classes, by state. */
export function animeDotClass(view: AnimeView): string {
  switch (view) {
    case "live":
      return "dot dot--live";
    case "connecting":
    case "stalled":
      return "dot dot--busy";
    case "error":
    case "unconfigured":
      return "dot dot--error";
    default:
      return "dot";
  }
}

/** Two halves: the filter's shadow colour and its highlight colour. */
export function Swatch({ colors, size = 14 }: { colors: readonly [string, string]; size?: number }) {
  return (
    <span className="swatch" style={{ width: size, height: size }} aria-hidden="true">
      <i style={{ background: colors[0] }} />
      <i style={{ background: colors[1] }} />
    </span>
  );
}

/**
 * Bottom right: trackers, anime (with its mono state), and the filter. The anime and
 * filter pills only mean something in effect "frame" and are disabled elsewhere.
 */
export function TogglePills({ status, actions }: { status: ToyHudStatus; actions: ToyHudActions }) {
  const inFrame = status.effect === "frame";
  const filter = FILTERS[status.filter];
  const on = animeOn(status.anime);
  return (
    <div className="pills">
      <button
        type="button"
        className="pill"
        aria-pressed={status.trackers}
        aria-label={`trackers ${status.trackers ? "on" : "off"}`}
        data-tip={status.trackers ? "trackers off · t" : "trackers on · t"}
        onClick={actions.toggleTrackers}
      >
        <span className={status.trackers ? "dot dot--live" : "dot"} aria-hidden="true" />
        <span className="pill__label">trackers</span>
      </button>
      <button
        type="button"
        className="pill"
        aria-pressed={on}
        aria-label={`anime ${status.animeSuffix || "off"}`}
        data-tip={on ? "anime off · d" : "anime on · d · billed per second"}
        disabled={!inFrame}
        onClick={actions.toggleAnime}
      >
        <span className={animeDotClass(status.anime)} aria-hidden="true" />
        <span className="pill__label">anime</span>
        {status.animeSuffix && <span className="pill__suffix">{status.animeSuffix}</span>}
      </button>
      <button
        type="button"
        className="pill pill--filter"
        aria-label={`filter ${filter.label} · next filter; shift-click for the previous`}
        data-tip="next filter · f · shift for the previous"
        disabled={!inFrame}
        onClick={(e) => actions.cycleFilter(e.shiftKey ? -1 : 1)}
      >
        <Swatch colors={filter.swatch} />
        <span className="pill__label">{filter.label}</span>
      </button>
    </div>
  );
}
