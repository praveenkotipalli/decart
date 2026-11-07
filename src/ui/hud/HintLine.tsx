import { useEffect, useRef, useState, type ReactNode } from "react";

/** The hint never changes faster than this, so a flickering state cannot make it unreadable. */
export const HINT_MIN_INTERVAL_MS = 1200;

/**
 * Gesture words and key names are set apart: "L", "OK", "space" and the single-letter keys
 * the hints mention. "a" (an article in this copy) and "s" (the seconds unit) are excluded.
 */
const EMPHASIS = /\b(L|OK|space|[cdfhlt])\b/g;

export function emphasise(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <em key={at} className="hint__key">
        {m[0]}
      </em>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The centred line above the effect bar. It is a polite live region, and it holds each
 * text for at least 1.2 s: a change that arrives sooner is shown when that time is up
 * (always the latest one), never dropped.
 */
export function HintLine({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const changedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (text === shown) {
      clearTimeout(timer.current);
      return;
    }
    const now = Date.now();
    const wait = changedAt.current + HINT_MIN_INTERVAL_MS - now;
    const apply = () => {
      changedAt.current = Date.now();
      setShown(text);
    };
    clearTimeout(timer.current);
    if (wait <= 0) apply();
    else timer.current = setTimeout(apply, wait);
    return () => clearTimeout(timer.current);
  }, [text, shown]);

  return (
    <p className="hint" aria-live="polite" aria-atomic="true">
      <span key={shown} className="hint__text">
        {emphasise(shown)}
      </span>
    </p>
  );
}
