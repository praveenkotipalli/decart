import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { EFFECT_ORDER, type EffectId } from "../../toy/types";

/** Lowercase, as everything in the bands. The digit is the key. */
const LABELS: Record<EffectId, string> = { frame: "frame", draw: "draw", particles: "particles", fog: "fog", vanish: "vanish" };

/**
 * The capsule of five effects with a sliding thumb. Segments are as wide as their
 * labels, so the thumb is measured from the selected segment rather than computed;
 * a ResizeObserver re-measures when fonts load or the band changes width.
 *
 * Keyboard: a radiogroup with a roving tab stop. Arrow keys and Home/End move the
 * selection; the digits 1–5 pick one directly. Those keys stop here so the global map
 * does not act on them a second time.
 */
export function EffectBar({ effect, onSelect }: { effect: EffectId; onSelect(e: EffectId): void }) {
  const segs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  // Transitions are enabled only after the first measured paint, so the thumb never slides in from the left on mount.
  const [live, setLive] = useState(false);
  const index = Math.max(0, EFFECT_ORDER.indexOf(effect));

  const measure = useCallback(() => {
    const el = segs.current[index];
    if (!el) return;
    const next = { x: el.offsetLeft, w: el.offsetWidth };
    setThumb((t) => (t && t.x === next.x && t.w === next.w ? t : next));
  }, [index]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    setLive(true);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const el of segs.current) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const select = (i: number) => {
    const n = EFFECT_ORDER.length;
    const k = ((i % n) + n) % n;
    onSelect(EFFECT_ORDER[k]);
    segs.current[k]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = EFFECT_ORDER.length - 1;
        break;
      default:
        if (e.key >= "1" && e.key <= "5") next = Number(e.key) - 1;
    }
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    select(next);
  };

  return (
    <div className="fxbar" role="radiogroup" aria-label="effect" onKeyDown={onKeyDown}>
      <span
        className={live ? "fxbar__thumb fxbar__thumb--live" : "fxbar__thumb"}
        aria-hidden="true"
        style={thumb ? { transform: `translateX(${thumb.x}px)`, width: thumb.w } : { opacity: 0 }}
      />
      {EFFECT_ORDER.map((id, i) => (
        <button
          key={id}
          ref={(el) => {
            segs.current[i] = el;
          }}
          type="button"
          role="radio"
          className="fxbar__seg"
          aria-checked={id === effect}
          aria-keyshortcuts={String(i + 1)}
          tabIndex={id === effect ? 0 : -1}
          onClick={() => onSelect(id)}
        >
          <span className="fxbar__label">{LABELS[id]}</span>
          <span className="fxbar__digit">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}
