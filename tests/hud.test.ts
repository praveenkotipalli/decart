import { describe, expect, it } from "vitest";
import {
  ANIME_HINTS,
  animeOn,
  animeSuffix,
  budgetHint,
  formatClock,
  formatCost,
  HINTS,
  hintFor,
  LEGEND,
  legendDim,
  REEL_HINT,
  statusLineFor,
  statusLineParts,
  type HintInput,
} from "../src/toy/hud";
import { EFFECT_ORDER, type AnimeView, type EffectId, type PlateState, type ToyStatus } from "../src/toy/types";

const VIEWS: AnimeView[] = ["off", "connecting", "live", "stalled", "paused", "unconfigured", "error", "budget"];
const GATES: ToyStatus["gate"][] = ["idle", "arming", "open"];
const PLATES: PlateState[] = ["none", "countdown", "capturing", "ready"];

const base = (o: Partial<HintInput> = {}): HintInput => ({
  effect: "frame",
  anime: "off",
  gate: "idle",
  locked: false,
  handsFresh: 0,
  handsIdle: false,
  oneL: false,
  plate: "none",
  countdown: 0,
  paused: false,
  ...o,
});

describe("legend", () => {
  it("starts with the reel's six items, in its order", () => {
    expect(LEGEND.slice(0, 6).map((i) => `${i.key} ${i.label}`)).toEqual([
      "h hide",
      "g full screen",
      "1–5 effects",
      "d anime",
      "f filter",
      "t trackers",
    ]);
    expect(LEGEND.slice(0, 6).every((i) => i.fromReel)).toBe(true);
    expect(LEGEND.slice(6).every((i) => !i.fromReel)).toBe(true);
  });

  it("has one entry per key and lowercase labels", () => {
    const keys = LEGEND.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of LEGEND) expect(i.label).toBe(i.label.toLowerCase());
  });

  it("dims d and f outside effect frame, and only then", () => {
    for (const effect of EFFECT_ORDER) {
      const dim = legendDim(effect, "window");
      expect(dim.has("d")).toBe(effect !== "frame");
      expect(dim.has("f")).toBe(effect !== "frame");
    }
  });

  it("dims the action key in frame and the lock key where there is no frame", () => {
    expect(legendDim("frame", "window").has("c")).toBe(true);
    expect(legendDim("draw", "window").has("c")).toBe(false);
    expect(legendDim("draw", "window").has("l")).toBe(true);
    expect(legendDim("vanish", "window").has("l")).toBe(false);
    expect(legendDim("frame", "window").has("l")).toBe(false);
    // Keys that always work are never dimmed.
    for (const effect of EFFECT_ORDER) {
      for (const k of ["h", "g", "1–5", "t", "s", "e", "p"]) expect(legendDim(effect, "window").has(k)).toBe(false);
    }
  });

  it("dims the toy-only keys in the classic style", () => {
    const dim = legendDim("frame", "classic");
    expect([...dim].sort()).toEqual(["1–5", "c", "f", "h"]);
  });
});

describe("hintFor", () => {
  it("says the reel's line, character for character, with anime live", () => {
    expect(hintFor(base({ anime: "live", gate: "open", handsFresh: 2 }))).toBe(
      "two L shapes: whoever is inside becomes anime · flip one hand to change the filter · OK sign for a loupe",
    );
    expect(REEL_HINT).toBe(hintFor(base({ anime: "live" })));
  });

  it("gives exactly one non-empty line for every effect × anime view × flag combination", { timeout: 30000 }, () => {
    // 46 080 combinations: one cheap check each, so the loop stays fast on a loaded machine.
    let combos = 0;
    let bad = 0;
    for (const effect of EFFECT_ORDER) {
      for (const anime of VIEWS) {
        for (const gate of GATES) {
          for (const plate of PLATES) {
            for (const locked of [false, true]) {
              for (const handsIdle of [false, true]) {
                for (const oneL of [false, true]) {
                  for (const paused of [false, true]) {
                    for (const handsFresh of [0, 1, 2]) {
                      for (const countdown of [0, 2.4]) {
                        const hint = hintFor(base({ effect, anime, gate, plate, locked, handsIdle, oneL, paused, handsFresh, countdown }));
                        if (typeof hint !== "string" || hint.length === 0 || hint !== hint.trim()) bad++;
                        combos++;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
    expect(combos).toBe(5 * 8 * 3 * 4 * 2 * 2 * 2 * 2 * 3 * 2);
  });

  it("uses the copy table for every anime state in effect frame", () => {
    const expected: Record<AnimeView, string> = {
      live: "two L shapes: whoever is inside becomes anime · flip one hand to change the filter · OK sign for a loupe",
      off: "two L shapes make a frame · flip one hand to change the filter · OK sign for a loupe · d for anime",
      connecting: "two L shapes make a frame · anime is connecting, about 8 s — the filter shows until it is live",
      stalled: "two L shapes make a frame · anime is connecting, about 8 s — the filter shows until it is live",
      paused: "two L shapes make a frame · anime is paused to save credits and wakes when you frame",
      unconfigured: "two L shapes make a frame · anime needs a Decart key on the server · filters and the loupe work without one",
      error: "two L shapes make a frame · anime stopped — press d to retry",
      budget: "two L shapes make a frame · anime budget reached — press d for another 3 minutes",
    };
    for (const anime of VIEWS) {
      expect(hintFor(base({ anime }))).toBe(expected[anime]);
      expect(hintFor(base({ anime, gate: "open", handsFresh: 2 }))).toBe(expected[anime]);
    }
    for (const view of Object.keys(ANIME_HINTS) as (keyof typeof ANIME_HINTS)[]) expect(ANIME_HINTS[view]).toBe(expected[view]);
  });

  it("words the budget hint from the budget setting", () => {
    expect(budgetHint()).toBe("two L shapes make a frame · anime budget reached — press d for another 3 minutes");
    expect(hintFor(base({ anime: "budget", budgetSec: 60 }))).toMatch(/another 1 minute$/);
    expect(hintFor(base({ anime: "budget", budgetSec: 300 }))).toMatch(/another 5 minutes$/);
    expect(hintFor(base({ anime: "budget", budgetSec: 90 }))).toMatch(/another 90 s$/);
  });

  it("coaches when no hands are seen or only one L is held, but not while the frame is open", () => {
    expect(hintFor(base({ handsIdle: true }))).toBe("raise both hands and make two L shapes — index up, thumb out");
    expect(hintFor(base({ oneL: true }))).toBe("that's one L · bring in your other hand");
    expect(hintFor(base({ handsIdle: true, oneL: true }))).toBe(HINTS.noHands);
    // Hands present or the frame open: the anime-state line wins over the coaching.
    expect(hintFor(base({ handsIdle: true, handsFresh: 1 }))).toBe(ANIME_HINTS.off);
    expect(hintFor(base({ oneL: true, gate: "open" }))).toBe(ANIME_HINTS.off);
    expect(hintFor(base({ oneL: true, gate: "arming" }))).toBe(HINTS.oneL);
  });

  it("ranks paused above locked above everything else", () => {
    expect(hintFor(base({ locked: true }))).toBe("frame locked · press l to release");
    expect(hintFor(base({ locked: true, anime: "live", gate: "open", handsFresh: 2 }))).toBe(HINTS.locked);
    expect(hintFor(base({ paused: true, locked: true }))).toBe("tracking paused · press space");
    for (const effect of EFFECT_ORDER) expect(hintFor(base({ effect, paused: true }))).toBe(HINTS.paused);
  });

  it("describes the other effects regardless of the anime state", () => {
    const lines: Partial<Record<EffectId, string>> = {
      draw: "point to draw · open your hand to lift the pen · hold a fist to wipe it clean · c clears",
      particles: "move your hands to shed sparks · faster hands, more sparks · close a fist to gather them",
      fog: "wipe the glass with an open hand · write in it with one finger · it mists over again",
    };
    for (const [effect, line] of Object.entries(lines) as [EffectId, string][]) {
      for (const anime of VIEWS) expect(hintFor(base({ effect, anime, gate: "open", handsFresh: 2, locked: true }))).toBe(line);
    }
  });

  it("walks vanish through countdown, no plate and ready", () => {
    expect(hintFor(base({ effect: "vanish" }))).toBe("step out of view and press c — the empty room is remembered after a 3 s countdown");
    expect(hintFor(base({ effect: "vanish", plate: "capturing" }))).toBe(HINTS.vanishNoPlate);
    expect(hintFor(base({ effect: "vanish", plate: "countdown", countdown: 2.2 }))).toBe("stay out of view · memorising the room in 3 s");
    expect(hintFor(base({ effect: "vanish", plate: "countdown", countdown: 0.4 }))).toBe("stay out of view · memorising the room in 1 s");
    expect(hintFor(base({ effect: "vanish", plate: "ready" }))).toBe("two L shapes: whoever is inside disappears · c memorises the room again");
    expect(hintFor(base({ effect: "vanish", plate: "ready", locked: true }))).toBe(HINTS.locked);
    expect(hintFor(base({ effect: "vanish", plate: "ready", paused: true }))).toBe(HINTS.paused);
  });
});

describe("animeSuffix", () => {
  const s = { seconds: 42, cost: 0.42, connectingSec: 5 };
  it("has the designed text for every view", () => {
    const expected: Record<AnimeView, string> = {
      live: "live 0:42 · $0.42",
      stalled: "stalled 0:42 · $0.42",
      connecting: "connecting 5 s",
      paused: "paused",
      unconfigured: "no key",
      error: "error",
      budget: "budget",
      off: "",
    };
    for (const view of VIEWS) expect(animeSuffix(view, s)).toBe(expected[view]);
  });

  it("formats clocks and costs", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(42.9)).toBe("0:42");
    expect(formatClock(180)).toBe("3:00");
    expect(formatClock(605)).toBe("10:05");
    expect(formatCost(0.346)).toBe("$0.35");
    expect(formatCost(1.8)).toBe("$1.80");
    expect(formatCost(-0.01)).toBe("$0.00");
    expect(animeSuffix("live", { seconds: 180, cost: 1.8, connectingSec: 0 })).toBe("live 3:00 · $1.80");
    expect(animeSuffix("connecting", { seconds: 0, cost: 0, connectingSec: 7.9 })).toBe("connecting 7 s");
  });

  it("reads anime as on while connecting, live, stalled or paused", () => {
    for (const view of VIEWS) expect(animeOn(view)).toBe(["connecting", "live", "stalled", "paused"].includes(view));
  });
});

describe("statusLineFor", () => {
  const off = { renderFps: 60, trackFps: 14, hands: 2, anime: "off" as AnimeView, aiFps: 0, lagMs: null, seconds: 0, cost: 0 };

  it("shows render, tracking and hands without anime", () => {
    expect(statusLineFor(off)).toBe("60 fps · track 14 hz · 2 hands");
    expect(statusLineFor({ ...off, hands: 1 })).toBe("60 fps · track 14 hz · 1 hand");
    expect(statusLineFor({ ...off, hands: 0, renderFps: 59.6, trackFps: 13.5 })).toBe("60 fps · track 14 hz · 0 hands");
  });

  it("adds the anime readout while live", () => {
    expect(statusLineFor({ ...off, anime: "live", aiFps: 22, lagMs: 900, seconds: 34, cost: 0.34 })).toBe(
      "60 fps · track 14 hz · 2 hands · anime 22 fps · 0.9 s behind · 34 s · $0.34",
    );
    expect(statusLineFor({ ...off, anime: "live", aiFps: 21.6, lagMs: null, seconds: 34.7, cost: 0.347 })).toBe(
      "60 fps · track 14 hz · 2 hands · anime 22 fps · 34 s · $0.35",
    );
  });

  it("keeps the bill visible while paused or exhausted, and drops it once off", () => {
    expect(statusLineFor({ ...off, anime: "paused", seconds: 34, cost: 0.34 })).toBe("60 fps · track 14 hz · 2 hands · anime 34 s · $0.34");
    expect(statusLineFor({ ...off, anime: "budget", seconds: 180, cost: 1.8 })).toBe("60 fps · track 14 hz · 2 hands · anime 180 s · $1.80");
    expect(statusLineFor({ ...off, anime: "connecting", seconds: 0, cost: 0 })).toBe("60 fps · track 14 hz · 2 hands");
    expect(statusLineFor({ ...off, anime: "off", seconds: 34, cost: 0.34 })).toBe("60 fps · track 14 hz · 2 hands");
  });

  it("splits before the anime readout so the component can break the line there", () => {
    const live = statusLineFor({ ...off, anime: "live", aiFps: 22, lagMs: 900, seconds: 34, cost: 0.34 });
    expect(statusLineParts(live)).toEqual({ base: "60 fps · track 14 hz · 2 hands", anime: "anime 22 fps · 0.9 s behind · 34 s · $0.34" });
    expect(statusLineParts(statusLineFor(off))).toEqual({ base: "60 fps · track 14 hz · 2 hands", anime: null });
  });
});
