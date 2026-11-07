import { LEGEND, legendDim, type FrameStyle } from "../../toy/hud";
import type { EffectId } from "../../toy/types";

/**
 * One line of key hints, top right. Decorative: the Keys tab of the Tune panel is the
 * accessible list, so this is hidden from assistive technology. Items beyond the reel's
 * six are dropped on narrow bands (CSS), and keys that do nothing in the current effect
 * are dimmed.
 */
export function KeyLegend({ effect, frameStyle }: { effect: EffectId; frameStyle: FrameStyle }) {
  const dim = legendDim(effect, frameStyle);
  return (
    <div className="legend" aria-hidden="true">
      {LEGEND.map((item, i) => (
        <span key={item.key} className={item.fromReel ? "legend__item" : "legend__item legend__item--more"} data-dim={dim.has(item.key)}>
          {i > 0 && <span className="legend__sep">·</span>}
          <span className="legend__key">{item.key}</span>
          <span className="legend__label">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
