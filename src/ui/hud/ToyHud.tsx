import type { ToyHudActions, ToyHudStatus } from "../../toy/hud";
import { EffectBar } from "./EffectBar";
import { HintLine } from "./HintLine";
import { HudHandle } from "./HudHandle";
import { StatusLine } from "./StatusLine";
import { TogglePills } from "./TogglePills";
import { UtilityButtons } from "./UtilityButtons";

/**
 * The whole bottom band of the hand-frame toy, plus the handle under it. Presentational:
 * everything it shows arrives in `status`, everything it does goes through `actions`.
 *
 * Row 1: status line (left) and the hint (centred). Row 2: utility buttons, the effect
 * bar, the toggle pills. The handle is a sibling so it survives the band collapsing.
 */
export function ToyHud({ status, actions, chromeHidden }: { status: ToyHudStatus; actions: ToyHudActions; chromeHidden: boolean }) {
  return (
    <>
      <footer id="toy-hud" className="band band--bottom" aria-label="controls" aria-hidden={chromeHidden} inert={chromeHidden} data-fullscreen={status.fullscreen}>
        <div className="hudrow hudrow--1">
          <StatusLine text={status.statusLine} />
          <HintLine text={status.hint} />
        </div>
        <div className="hudrow hudrow--2">
          <UtilityButtons status={status} actions={actions} />
          <EffectBar effect={status.effect} onSelect={actions.setEffect} />
          <TogglePills status={status} actions={actions} />
        </div>
      </footer>
      <HudHandle hidden={chromeHidden} onToggle={chromeHidden ? actions.showChrome : actions.hideChrome} />
    </>
  );
}
