import type { EngineStatus } from "../engine/Engine";
import type { ContentSource } from "../render/Renderer";

export type Tone = "off" | "busy" | "live" | "error" | "preview";

/** Decart's published realtime prices, USD per generated second. */
export function pricePerSecond(model: string, fast: boolean): number {
  if (model.startsWith("lucy-restyle")) return 0.01;
  return fast ? 0.04 : 0.02;
}

export function aiView(ai: EngineStatus["ai"], source: ContentSource, content: ContentSource): { tone: Tone; label: string } {
  if (source !== "decart") return { tone: "preview", label: content === "test" ? "Test pattern" : "Local preview" };
  switch (ai.state) {
    case "live":
      return { tone: "live", label: "Live" };
    case "connecting":
      return { tone: "busy", label: "Connecting" };
    case "connected":
      return { tone: "busy", label: "First frame…" };
    case "waiting":
      return { tone: "busy", label: "Waiting" };
    case "reconnecting":
      return { tone: "busy", label: "Reconnecting" };
    case "unconfigured":
      return { tone: "error", label: "No API key" };
    case "error":
      return { tone: "error", label: "Error" };
    case "paused":
      return { tone: "off", label: "Paused" };
    default:
      return { tone: "off", label: "Off" };
  }
}

export const dotClass = (tone: Tone) =>
  `dot ${tone === "live" ? "dot--live" : tone === "busy" ? "dot--busy" : tone === "error" ? "dot--error" : tone === "preview" ? "dot--preview" : ""}`;
