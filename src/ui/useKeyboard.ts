import { useEffect } from "react";
import { settingsStore, updateSettings } from "../config/settings";
import { engine } from "../engine/instance";
import { toggleAI, toggleFullscreen } from "./Dock";

export const SHORTCUTS: [string, string][] = [
  ["Space", "Pause / resume tracking"],
  ["L", "Lock / unlock the portal"],
  ["R", "Reset the portal"],
  ["K", "Calibrate"],
  ["A", "AI transform on / off"],
  ["M", "Two-hand / one-hand mode"],
  ["D", "Hand landmarks"],
  ["S", "Snapshot"],
  ["E", "Start / stop recording"],
  ["F", "Full screen"],
  ["T", "Tune panel"],
  ["Esc", "Close panel · cancel calibration"],
];

export function useKeyboard(handlers: { togglePanel: () => void; closePanel: () => void; enabled: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        engine.cancelCalibration();
        handlers.closePanel();
        return;
      }
      if (!handlers.enabled) return;
      const s = settingsStore.get();
      switch (e.key.toLowerCase()) {
        case " ":
          if (el.closest("button")) return; // let Space press the focused button
          e.preventDefault();
          engine.togglePause();
          break;
        case "l":
          engine.toggleLock();
          break;
        case "r":
          engine.reset();
          break;
        case "k":
          engine.startCalibration();
          break;
        case "a":
          toggleAI();
          break;
        case "m":
          updateSettings({ mode: s.mode === "two-hand" ? "one-hand" : "two-hand" });
          break;
        case "d":
          updateSettings({ showSkeleton: !s.showSkeleton });
          break;
        case "s":
          void engine.snapshot();
          break;
        case "e":
          void engine.toggleRecording();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "t":
          handlers.togglePanel();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
