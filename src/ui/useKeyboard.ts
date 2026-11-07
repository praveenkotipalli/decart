import { useEffect } from "react";
import { settingsStore, updateSettings, type Settings } from "../config/settings";
import { engine } from "../engine/instance";
import { EFFECT_ORDER } from "../toy/types";
import { toggleAI, toggleFullscreen } from "./Dock";

type Shortcut = [key: string, label: string];

/** The hand-frame toy. The first six rows are the on-screen legend. */
const WINDOW_SHORTCUTS: Shortcut[] = [
  ["H", "Hide / show the controls"],
  ["G", "Full screen"],
  ["1 – 5", "Effect: frame, draw, particles, fog, vanish"],
  ["D", "Anime on / off (billed per second)"],
  ["F", "Next filter · Shift + F previous"],
  ["T", "Trackers on / off"],
  ["C", "Effect action: clear the ink or sparks, re-fog, memorise the room"],
  ["L", "Lock / unlock the frame"],
  ["Space", "Pause / resume tracking"],
  ["S", "Snapshot"],
  ["E", "Start / stop recording"],
  ["P", "Tune panel"],
  ["Esc", "Close panel · cancel a countdown · show the controls"],
];

const CLASSIC_SHORTCUTS: Shortcut[] = [
  ["Space", "Pause / resume tracking"],
  ["L", "Lock / unlock the portal"],
  ["R", "Reset the portal"],
  ["K", "Calibrate"],
  ["D", "AI transform on / off"],
  ["M", "Two-hand / one-hand mode"],
  ["T", "Hand landmarks"],
  ["S", "Snapshot"],
  ["E", "Start / stop recording"],
  ["G", "Full screen"],
  ["P", "Tune panel"],
  ["Esc", "Close panel · cancel calibration"],
];

export const shortcutsFor = (style: Settings["frameStyle"]): Shortcut[] => (style === "window" ? WINDOW_SHORTCUTS : CLASSIC_SHORTCUTS);

export interface KeyboardHandlers {
  togglePanel: () => void;
  closePanel: () => void;
  toggleChrome: () => void;
  showChrome: () => void;
  enabled: boolean;
}

export function useKeyboard(handlers: KeyboardHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        engine.cancelCalibration();
        engine.cancelToy();
        handlers.closePanel();
        handlers.showChrome();
        return;
      }
      if (!handlers.enabled || e.repeat) return;
      const s = settingsStore.get();
      const toy = s.frameStyle === "window";
      const key = e.key.toLowerCase();

      // Keys shared by both frame styles.
      switch (key) {
        case " ":
          if (el.closest("button, [role='radio'], [role='tab']")) return; // let Space press the focused control
          e.preventDefault();
          engine.togglePause();
          return;
        case "l":
          engine.toggleLock();
          return;
        case "s":
          void engine.snapshot();
          return;
        case "e":
          void engine.toggleRecording();
          return;
        case "g":
          toggleFullscreen();
          return;
        case "p":
          handlers.togglePanel();
          return;
      }

      if (toy) {
        if (key >= "1" && key <= "5") {
          engine.setEffect(EFFECT_ORDER[Number(key) - 1]);
          return;
        }
        switch (key) {
          case "h":
            handlers.toggleChrome();
            break;
          case "d":
          case "a":
            engine.toggleAnime();
            break;
          case "f":
            engine.cycleFilter(e.shiftKey ? -1 : 1);
            break;
          case "t":
            engine.toggleTrackers();
            break;
          case "c":
            engine.effectAction();
            break;
        }
        return;
      }

      switch (key) {
        case "r":
          engine.reset();
          break;
        case "k":
          engine.startCalibration();
          break;
        case "d":
        case "a":
          toggleAI();
          break;
        case "m":
          updateSettings({ mode: s.mode === "two-hand" ? "one-hand" : "two-hand" });
          break;
        case "t":
          updateSettings({ showSkeleton: !s.showSkeleton });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
