/**
 * The small capsule under the effect bar. It is the one piece of chrome that stays when
 * the bands are hidden (as a ghost), so there is always a pointer way back.
 */
export function HudHandle({ hidden, onToggle }: { hidden: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className="hud-handle"
      aria-label={hidden ? "show controls (h)" : "hide controls (h)"}
      aria-expanded={!hidden}
      aria-controls="toy-hud"
      onClick={onToggle}
    />
  );
}
