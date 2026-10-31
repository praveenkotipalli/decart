import { defaultPromptFor, RETIRED_PROMPTS } from "../ai/prompts";
import { createStore, useStore } from "../core/store";
import type { GestureBindings } from "../gestures/GestureMachine";
import type { CalibrationResult } from "../portal/Calibrator";
import { DEFAULT_ONE_HAND_MAPPING, DEFAULT_TWO_HAND_MAPPING, type CornerMapping } from "../portal/cornerMapping";
import type { InvalidPolicy } from "../portal/PortalController";
import type { ContentFit, ContentMapping, ContentSource } from "../render/Renderer";
import type { TrackingMode } from "../tracking/handAssignment";

export interface Settings {
  // Tracking
  mode: TrackingMode;
  twoHandMapping: CornerMapping;
  oneHandMapping: CornerMapping;
  /** One Euro min cutoff, Hz: lower = steadier. */
  smoothing: number;
  /** One Euro beta: higher = less lag on fast moves. */
  responsiveness: number;
  graceMs: number;
  detectionConfidence: number;
  mirror: boolean;
  // Portal
  invalidPolicy: InvalidPolicy;
  portalScale: number;
  lingerMs: number;
  glow: number;
  energy: number;
  particles: boolean;
  fit: ContentFit;
  mapping: ContentMapping;
  fullscreenTransform: boolean;
  showSkeleton: boolean;
  showLabels: boolean;
  // Gestures
  gestures: Record<TrackingMode, GestureBindings>;
  // Transformation
  source: ContentSource;
  /** Content used when AI is switched off. */
  previewSource: Exclude<ContentSource, "decart">;
  model: string;
  prompt: string;
  enhance: boolean;
  fast: boolean;
  autoFallback: boolean;
  /** Disconnect Decart after this many seconds without a visible portal (0 = never). */
  idlePauseSec: number;
  calibration: CalibrationResult | null;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "two-hand",
  twoHandMapping: DEFAULT_TWO_HAND_MAPPING,
  oneHandMapping: DEFAULT_ONE_HAND_MAPPING,
  smoothing: 1.2,
  responsiveness: 6,
  graceMs: 450,
  detectionConfidence: 0.6,
  mirror: true,
  invalidPolicy: "hold",
  portalScale: 1,
  lingerMs: 1400,
  glow: 1,
  energy: 0.7,
  particles: true,
  fit: "cover",
  mapping: "projected",
  fullscreenTransform: false,
  showSkeleton: false,
  showLabels: true,
  gestures: {
    "two-hand": { lock: "pinch-middle", reset: "open-palm-solo", lockHoldMs: 320, resetHoldMs: 1100 },
    "one-hand": { lock: "pinch-middle", reset: "fist", lockHoldMs: 320, resetHoldMs: 900 },
  },
  source: "local",
  previewSource: "local",
  model: "lucy-2.6",
  prompt: defaultPromptFor("lucy-2.6"),
  enhance: true,
  fast: false,
  autoFallback: true,
  idlePauseSec: 45,
  calibration: null,
};

const KEY = "domain-portal:settings:v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<Settings>;
    if (saved.prompt && RETIRED_PROMPTS.includes(saved.prompt)) delete saved.prompt;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      gestures: { ...DEFAULT_SETTINGS.gestures, ...(saved.gestures ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const settingsStore = createStore<Settings>(typeof localStorage === "undefined" ? DEFAULT_SETTINGS : load());

let saveTimer: ReturnType<typeof setTimeout> | undefined;
settingsStore.subscribe(() => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settingsStore.get()));
    } catch {
      /* private mode / storage blocked: settings just don't persist */
    }
  }, 250);
});

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  settingsStore.set((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
}

export function resetSettings() {
  settingsStore.set({ ...DEFAULT_SETTINGS });
}

export const useSettings = () => useStore(settingsStore);
