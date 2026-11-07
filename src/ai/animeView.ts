/**
 * The anime switch as the user sees it: one word that is honest about whether AI pixels
 * are on screen right now. "live" is the only state in which the treatment targets the
 * AI frame and the pill, hint and frame tag say "anime"; everything else shows the camera
 * with its filter and says why.
 */
import type { AnimeView } from "../toy/types";
import type { AIState } from "./DecartSession";

export type { AnimeView };

/** An AI frame older than this is not shown: a frozen picture would sit still while the camera moves. */
export const ANIME_FRESH_MS = 1000;

/**
 * @param on        the user's anime switch
 * @param ai        the Decart session state
 * @param texReady  the AI video texture has received at least one frame
 * @param frameAgeMs ms since the last decoded AI frame reached the GPU (Infinity when none did)
 * @param budgetHit the billing guard switched anime off because the granted seconds ran out
 */
export function animeView(on: boolean, ai: AIState, texReady: boolean, frameAgeMs: number, budgetHit: boolean): AnimeView {
  if (!on) return budgetHit ? "budget" : "off";
  switch (ai) {
    case "live":
      // The session may be generating while nothing reaches us (network stall, decoder stuck):
      // then the last picture is stale and the camera must show instead.
      return texReady && frameAgeMs < ANIME_FRESH_MS ? "live" : "stalled";
    case "paused":
      return "paused";
    case "unconfigured":
      return "unconfigured";
    case "error":
      return "error";
    case "connecting":
    case "waiting":
    case "connected":
    case "reconnecting":
      return "connecting";
    default:
      // "off" with the switch on: the session is about to start (the toggle starts it in the same tick).
      return "connecting";
  }
}

/**
 * Text of the frame tag while anime is on but not showing, e.g. "anime connecting 5 s" or
 * "anime paused". Null when there is nothing to add to the filter's name: anime is off (or
 * cannot run at all), or it is live and the tag already says "anime".
 */
export function animeTag(view: AnimeView, connectingSec: number): string | null {
  switch (view) {
    case "connecting": {
      const s = Number.isFinite(connectingSec) ? Math.max(0, Math.floor(connectingSec)) : 0;
      return s > 0 ? `anime connecting ${s} s` : "anime connecting";
    }
    case "stalled":
      return "anime stalled";
    case "paused":
      return "anime paused";
    case "error":
      return "anime stopped";
    case "budget":
      return "anime budget reached";
    default:
      return null;
  }
}

/** Colour of the tag's dot: blue while AI pixels show, violet while anime is working on it, grey when you see the camera. */
export function animeTone(view: AnimeView): "camera" | "busy" | "live" {
  if (view === "live") return "live";
  if (view === "connecting" || view === "stalled") return "busy";
  return "camera";
}
