import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/config/migrate";
import { TOY_DEFAULTS, type ToySettings } from "../src/config/toySettings";

// A stand-in for the app's defaults: the toy fields plus a few classic ones.
interface TestSettings extends ToySettings {
  mode: string;
  smoothing: number;
  detectionConfidence: number;
  idlePauseSec: number;
  prompt: string;
  model: string;
  source: string;
  gestures: Record<string, { lock: string; reset: string }>;
  calibration: { home: number[] } | null;
}

const DEFAULTS: TestSettings = {
  ...TOY_DEFAULTS,
  mode: "two-hand",
  smoothing: 1.2,
  detectionConfidence: 0.5,
  idlePauseSec: 30,
  prompt: "default prompt",
  model: "lucy-2.6",
  source: "local",
  gestures: { "two-hand": { lock: "pinch-middle", reset: "open-palm-solo" }, "one-hand": { lock: "pinch-middle", reset: "fist" } },
  calibration: null,
};

const RETIRED = ["an old prompt that names a character"];

describe("migrateSettings", () => {
  it("returns the defaults for nothing or garbage", () => {
    expect(migrateSettings(null, DEFAULTS, RETIRED)).toEqual(DEFAULTS);
    expect(migrateSettings("nope", DEFAULTS, RETIRED)).toEqual(DEFAULTS);
    expect(migrateSettings([1, 2], DEFAULTS, RETIRED)).toEqual(DEFAULTS);
    expect(migrateSettings(42, DEFAULTS, RETIRED)).toEqual(DEFAULTS);
  });

  it("keeps every classic field of a v1 entry and adds the toy defaults", () => {
    const v1 = {
      mode: "one-hand",
      smoothing: 2.5,
      detectionConfidence: 0.7,
      idlePauseSec: 90,
      prompt: "my own prompt",
      model: "lucy-restyle-2",
      source: "decart",
      gestures: { "two-hand": { lock: "fist", reset: "none" } },
      calibration: { home: [1, 2, 3] },
    };
    const out = migrateSettings(v1, DEFAULTS, RETIRED);
    expect(out.mode).toBe("one-hand");
    expect(out.smoothing).toBe(2.5);
    expect(out.detectionConfidence).toBe(0.7);
    expect(out.idlePauseSec).toBe(90);
    expect(out.prompt).toBe("my own prompt");
    expect(out.model).toBe("lucy-restyle-2");
    expect(out.source).toBe("decart");
    expect(out.calibration).toEqual({ home: [1, 2, 3] });
    // Gestures merge per mode: the stored mode wins, the missing one comes from the defaults.
    expect(out.gestures["two-hand"]).toEqual({ lock: "fist", reset: "none" });
    expect(out.gestures["one-hand"]).toEqual(DEFAULTS.gestures["one-hand"]);
    expect(out.schema).toBe(2);
    expect(out.frameStyle).toBe("window");
    expect(out.effect).toBe("frame");
    expect(out.filter).toBe("rose");
    expect(out.animeModel).toBe("lucy-restyle-2");
    expect(out.animeBudgetSec).toBe(180);
  });

  it("moves the two changed tracking defaults only when the user still had the old default", () => {
    const untouched = migrateSettings({ detectionConfidence: 0.6, idlePauseSec: 45 }, DEFAULTS, RETIRED);
    expect(untouched.detectionConfidence).toBe(0.5);
    expect(untouched.idlePauseSec).toBe(30);
    const chosen = migrateSettings({ detectionConfidence: 0.8, idlePauseSec: 0 }, DEFAULTS, RETIRED);
    expect(chosen.detectionConfidence).toBe(0.8);
    expect(chosen.idlePauseSec).toBe(0);
  });

  it("does not touch those values in an entry that is already v2", () => {
    const out = migrateSettings({ schema: 2, detectionConfidence: 0.6, idlePauseSec: 45 }, DEFAULTS, RETIRED);
    expect(out.detectionConfidence).toBe(0.6);
    expect(out.idlePauseSec).toBe(45);
  });

  it("drops a retired prompt", () => {
    expect(migrateSettings({ prompt: RETIRED[0] }, DEFAULTS, RETIRED).prompt).toBe("default prompt");
  });

  it("passes a valid v2 entry through", () => {
    const v2 = { ...DEFAULTS, frameStyle: "classic", effect: "fog", filter: "none", lastTint: "violet", glitch: false, trackers: false, loupeZoom: 2.5, animePrompt: "soft pencil", animeEnhance: true };
    const out = migrateSettings(v2, DEFAULTS, RETIRED);
    expect(out).toEqual(v2);
  });

  it("replaces malformed toy fields with defaults instead of trusting them", () => {
    const out = migrateSettings(
      { schema: 2, frameStyle: "sideways", effect: "lasers", filter: "pink", lastTint: "none", glitch: "yes", faceBox: 1, loupeZoom: 99, animeModel: "", animePrompt: "   ", animeEnhance: "true", animeBudgetSec: -5 },
      DEFAULTS,
      RETIRED,
    );
    expect(out.frameStyle).toBe("window");
    expect(out.effect).toBe("frame");
    expect(out.filter).toBe("rose");
    expect(out.lastTint).toBe("rose");
    expect(out.glitch).toBe(true);
    expect(out.faceBox).toBe("auto");
    expect(out.loupeZoom).toBe(3);
    expect(out.animeModel).toBe("lucy-restyle-2");
    expect(out.animePrompt).toBeNull();
    expect(out.animeEnhance).toBeNull();
    expect(out.animeBudgetSec).toBe(30);
  });

  it("can never switch anime on from storage", () => {
    const out = migrateSettings({ anime: true, animeOn: true }, DEFAULTS, RETIRED) as unknown as Record<string, unknown>;
    expect(out.anime).toBeUndefined();
    expect(out.animeOn).toBeUndefined();
  });

  it("does not mutate what it was given", () => {
    const raw = { prompt: RETIRED[0], gestures: { "two-hand": { lock: "fist", reset: "none" } } };
    const copy = JSON.parse(JSON.stringify(raw));
    migrateSettings(raw, DEFAULTS, RETIRED);
    expect(raw).toEqual(copy);
    expect(DEFAULTS.gestures["two-hand"].lock).toBe("pinch-middle");
  });
});
