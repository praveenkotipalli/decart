import { statusLineParts } from "../../toy/hud";

/**
 * Bottom left, row 1: `60 fps · track 14 hz · 2 hands`, plus the anime readout while it
 * runs. The two parts are unbreakable blocks, so when the column is narrow the line wraps
 * exactly once, before "anime", and never word by word. Not a live region: it updates
 * several times a second.
 */
export function StatusLine({ text }: { text: string }) {
  const { base, anime } = statusLineParts(text);
  if (!text) return null;
  return (
    <p className="statusline" data-anime={anime != null}>
      <span className="statusline__part statusline__part--base">{base}</span>
      {anime && (
        <>
          <span className="statusline__sep statusline__part--base"> · </span>
          <span className="statusline__part statusline__part--anime">{anime}</span>
        </>
      )}
    </p>
  );
}
