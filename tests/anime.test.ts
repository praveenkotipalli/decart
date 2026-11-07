import { describe, expect, it } from "vitest";
import type { AIState } from "../src/ai/DecartSession";
import {
  ANIME_DEFAULT_PRESET,
  ANIME_MODELS,
  ANIME_PRESETS,
  ANIME_SUFFIX,
  animeModelInfo,
  animePreset,
  animePrompt,
  isRestyleModel,
  LUCY_PREFIX,
  resolveAnimeModel,
  RESTYLE_PREFIX,
} from "../src/ai/animePrompts";
import { ANIME_FRESH_MS, animeTag, animeTone, animeView } from "../src/ai/animeView";
import { guardGrant, guardInit, guardStep, type GuardAction, type GuardInput, type GuardState } from "../src/ai/billingGuard";
import { PROMPT_LIMIT } from "../src/ai/prompts";
import type { AnimeView } from "../src/toy/types";

const RESTYLE = "lucy-restyle-2";
const LUCY = "lucy-2.6";

// ── Presets and prompts ───────────────────────────────────────────────────────

/**
 * Studios, franchises, characters and creators Decart would refuse (or that would make a
 * preset an imitation of someone's work). Matched as whole words, case-insensitively, in
 * every label, body and final prompt.
 */
const BLOCKED_NAMES = [
  // studios and companies
  "ghibli", "madhouse", "kyoto animation", "kyoani", "ufotable", "mappa", "toei", "trigger", "bones", "shaft", "wit studio",
  "gainax", "sunrise", "pierrot", "a-1 pictures", "clamp", "production i.g", "disney", "pixar", "sanrio", "nintendo",
  "crunchyroll", "netflix", "shueisha", "kodansha", "jump",
  // franchises and films
  "naruto", "pokemon", "pokémon", "sailor moon", "evangelion", "akira", "totoro", "spirited away", "attack on titan",
  "demon slayer", "jujutsu", "one piece", "dragon ball", "cowboy bebop", "death note", "bleach", "my hero academia",
  "chainsaw man", "spy x family", "your name", "doraemon", "astro boy", "gundam", "neon genesis", "fullmetal alchemist",
  "hunter x hunter", "haikyuu", "jojo", "berserk", "ghost in the shell", "kiki", "ponyo", "nausicaa", "mononoke", "howl",
  "paprika", "perfect blue", "violet evergarden", "k-on", "lucky star", "cardcaptor", "inuyasha", "yu-gi-oh", "digimon",
  "fruits basket", "mob psycho", "one punch man", "hellsing", "trigun", "kill la kill", "steins;gate", "fate/stay", "madoka",
  "frieren", "dandadan", "oshi no ko", "blue lock", "tokyo ghoul", "sword art online", "re:zero", "konosuba",
  // characters
  "goku", "pikachu", "luffy", "gojo", "satoru", "sukuna", "tanjiro", "nezuko", "eren", "mikasa", "levi", "chihiro", "sasuke",
  "kakashi", "ichigo", "yagami", "ketchum", "usagi", "shinji", "asuka", "ayanami", "spiegel", "elric", "vegeta", "deku",
  "bakugo", "zenitsu", "zoro", "nami", "kirito", "denji", "makima", "anya",
  // creators
  "miyazaki", "shinkai", "satoshi kon", "tezuka", "toriyama", "kishimoto", "isayama", "akutami", "araki", "takahashi", "anno",
  "gotouge", "oda", "kubo", "horikoshi", "fujimoto",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// A name counts only as a whole word: "shojo" must not trip on "jojo", "iconic" not on "kon".
const BLOCKED_RE = BLOCKED_NAMES.map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "iu"));

function blockedIn(text: string): string[] {
  return BLOCKED_NAMES.filter((_, i) => BLOCKED_RE[i].test(text));
}

describe("anime presets", () => {
  it("has the five presets of the design in order, the default first", () => {
    expect(ANIME_PRESETS.map((p) => p.id)).toEqual(["anime-clean", "anime-shoujo", "anime-90s-cel", "manga-ink", "anime-watercolor"]);
    expect(ANIME_PRESETS.map((p) => p.label)).toEqual(["clean", "shoujo", "90s cel", "manga ink", "watercolor"]);
    expect(ANIME_DEFAULT_PRESET).toBe(ANIME_PRESETS[0].id);
    expect(animePreset("anime-clean")).toBe(ANIME_PRESETS[0]);
  });

  it("names no studio, franchise, character or creator anywhere in a label, body or final prompt", () => {
    // The block list itself must be able to catch something, or the test proves nothing.
    expect(blockedIn("Transform to the look of Studio Ghibli")).toEqual(["ghibli"]);
    expect(blockedIn("like Gojo Satoru from Jujutsu Kaisen")).toEqual(["jujutsu", "gojo", "satoru"]);
    expect(blockedIn("a shojo heroine with an iconic look")).toEqual([]);

    for (const p of ANIME_PRESETS) {
      expect(blockedIn(p.label), `${p.id} label`).toEqual([]);
      expect(blockedIn(p.body), `${p.id} body`).toEqual([]);
      for (const model of [RESTYLE, LUCY]) {
        expect(blockedIn(animePrompt(p.id, model).text), `${p.id} on ${model}`).toEqual([]);
      }
    }
    expect(blockedIn(ANIME_SUFFIX)).toEqual([]);
  });

  it("keeps every final prompt under 400 characters for both model families", () => {
    for (const p of ANIME_PRESETS) {
      for (const model of [RESTYLE, LUCY]) {
        const { text } = animePrompt(p.id, model);
        expect(text.length, `${p.id} on ${model}`).toBeLessThan(400);
        expect(text.length).toBeLessThanOrEqual(PROMPT_LIMIT);
      }
    }
  });

  it("uses the restyle prefix with enhancement off on restyle models", () => {
    const r = animePrompt("anime-shoujo", RESTYLE);
    expect(r.text).toBe(RESTYLE_PREFIX + ANIME_PRESETS[1].body + ANIME_SUFFIX);
    expect(r.text.startsWith("Transform to soft pastel shoujo anime")).toBe(true);
    expect(r.text.endsWith("and the background layout.")).toBe(true);
    expect(r.enhance).toBe(false);
    expect(isRestyleModel(RESTYLE)).toBe(true);
    expect(isRestyleModel("lucy-restyle-latest")).toBe(true);
  });

  it("uses the whole-scene prefix with enhancement on for the editing models", () => {
    const r = animePrompt("anime-90s-cel", LUCY);
    expect(r.text).toBe(LUCY_PREFIX + ANIME_PRESETS[2].body + ANIME_SUFFIX);
    expect(r.text.startsWith("Restyle the whole scene as 1990s hand-painted cel anime")).toBe(true);
    expect(r.enhance).toBe(true);
    expect(isRestyleModel(LUCY)).toBe(false);
    // The window style never sends an editing instruction that swaps the person out.
    expect(r.text.startsWith("Substitute")).toBe(false);
  });

  it("lets an explicit enhance flag override the model default, and null means default", () => {
    expect(animePrompt("anime-clean", RESTYLE, null, true).enhance).toBe(true);
    expect(animePrompt("anime-clean", LUCY, null, false).enhance).toBe(false);
    expect(animePrompt("anime-clean", LUCY, null, null).enhance).toBe(true);
    expect(animePrompt("anime-clean", RESTYLE, undefined, undefined).enhance).toBe(false);
  });

  it("falls back to the default preset for an unknown id", () => {
    expect(animePrompt("not-a-preset", RESTYLE).text).toBe(animePrompt(ANIME_DEFAULT_PRESET, RESTYLE).text);
    expect(animePreset("").id).toBe(ANIME_DEFAULT_PRESET);
  });

  it("sends a custom prompt as written, trimmed, with no prefix or suffix", () => {
    const r = animePrompt("anime-clean", RESTYLE, "  oil painting with thick strokes  ");
    expect(r.text).toBe("oil painting with thick strokes");
    expect(r.enhance).toBe(false);
    // The custom text keeps the model's enhance default unless told otherwise.
    expect(animePrompt("anime-clean", LUCY, "oil painting").enhance).toBe(true);
    expect(animePrompt("anime-clean", LUCY, "oil painting", false).enhance).toBe(false);
  });

  it("cuts a custom prompt to Decart's 750-character limit", () => {
    const long = "x".repeat(PROMPT_LIMIT + 200);
    expect(animePrompt("anime-clean", LUCY, long).text).toHaveLength(PROMPT_LIMIT);
    expect(PROMPT_LIMIT).toBe(750);
  });

  it("treats an empty or whitespace-only custom prompt as no custom prompt", () => {
    const preset = animePrompt("manga-ink", LUCY).text;
    expect(animePrompt("manga-ink", LUCY, "").text).toBe(preset);
    expect(animePrompt("manga-ink", LUCY, "   \n ").text).toBe(preset);
    expect(animePrompt("manga-ink", LUCY, null).text).toBe(preset);
  });
});

describe("resolveAnimeModel", () => {
  it("returns the preferred model when the server allows it", () => {
    expect(resolveAnimeModel(LUCY, [LUCY, RESTYLE])).toBe(LUCY);
    expect(resolveAnimeModel(RESTYLE, [LUCY, RESTYLE])).toBe(RESTYLE);
    expect(resolveAnimeModel("lucy-2.5", ["lucy-2.5"])).toBe("lucy-2.5");
  });

  it("falls back to lucy-restyle-2, then lucy-2.6, then null", () => {
    expect(resolveAnimeModel("lucy-2.5", [LUCY, RESTYLE])).toBe(RESTYLE);
    expect(resolveAnimeModel("lucy-2.5", [LUCY])).toBe(LUCY);
    expect(resolveAnimeModel("lucy-2.5", ["lucy-2.1"])).toBeNull();
    expect(resolveAnimeModel(RESTYLE, [])).toBeNull();
  });

  it("never picks lucy-latest, even when it is preferred and allowed", () => {
    expect(resolveAnimeModel("lucy-latest", ["lucy-latest", LUCY])).toBe(LUCY);
    expect(resolveAnimeModel("lucy-latest", ["lucy-latest"])).toBeNull();
    expect(resolveAnimeModel("lucy-restyle-latest", ["lucy-restyle-latest", RESTYLE])).toBe(RESTYLE);
  });
});

describe("anime models", () => {
  it("knows the size and price of the two pinned models", () => {
    expect(ANIME_MODELS[RESTYLE]).toEqual({ label: "lucy restyle 2", pricePerSec: 0.01, width: 1280, height: 704 });
    expect(ANIME_MODELS[LUCY]).toEqual({ label: "lucy 2.6", pricePerSec: 0.02, width: 1280, height: 720 });
    expect(animeModelInfo(RESTYLE)).toBe(ANIME_MODELS[RESTYLE]);
  });

  it("gives an unknown id a conservative estimate: the dearest known price and a 16:9 frame", () => {
    const info = animeModelInfo("lucy-9.9");
    expect(info.label).toBe("lucy-9.9");
    expect(info.pricePerSec).toBe(0.02);
    expect(info.width / info.height).toBeCloseTo(16 / 9, 5);
    // Prototype keys must not leak through the table lookup.
    expect(animeModelInfo("constructor").pricePerSec).toBe(0.02);
  });
});

// ── View state ────────────────────────────────────────────────────────────────

describe("animeView", () => {
  it("is live only when on, the session is live, the texture is ready and the frame is fresh", () => {
    expect(animeView(true, "live", true, 0, false)).toBe("live");
    expect(animeView(true, "live", true, ANIME_FRESH_MS - 1, false)).toBe("live");
    expect(animeView(true, "live", true, ANIME_FRESH_MS, false)).toBe("stalled");
    expect(animeView(true, "live", true, Infinity, false)).toBe("stalled");
    expect(animeView(true, "live", true, Number.NaN, false)).toBe("stalled");
    expect(animeView(true, "live", false, 0, false)).toBe("stalled");
    expect(ANIME_FRESH_MS).toBe(1000);
  });

  it("is off whenever the switch is off, even if a session is still winding down", () => {
    expect(animeView(false, "off", false, Infinity, false)).toBe("off");
    expect(animeView(false, "live", true, 0, false)).toBe("off");
    expect(animeView(false, "connecting", false, Infinity, false)).toBe("off");
  });

  it("is budget when the budget switched it off", () => {
    expect(animeView(false, "off", false, Infinity, true)).toBe("budget");
    expect(animeView(false, "off", true, 0, true)).toBe("budget");
  });

  it("maps every connection phase to connecting", () => {
    for (const s of ["connecting", "waiting", "connected", "reconnecting"] as AIState[]) {
      expect(animeView(true, s, false, Infinity, false), s).toBe("connecting");
      // A texture left over from before a reconnect does not make it live.
      expect(animeView(true, s, true, 0, false), s).toBe("connecting");
    }
    // The switch is on and the session has not started yet: it is about to.
    expect(animeView(true, "off", false, Infinity, false)).toBe("connecting");
  });

  it("passes paused, unconfigured and error through", () => {
    expect(animeView(true, "paused", true, 0, false)).toBe("paused");
    expect(animeView(true, "unconfigured", false, Infinity, false)).toBe("unconfigured");
    expect(animeView(true, "error", false, Infinity, false)).toBe("error");
  });
});

describe("frame tag copy", () => {
  it("names the waiting states and says nothing when off or live", () => {
    expect(animeTag("connecting", 5)).toBe("anime connecting 5 s");
    expect(animeTag("connecting", 7.9)).toBe("anime connecting 7 s");
    expect(animeTag("connecting", 0)).toBe("anime connecting");
    expect(animeTag("connecting", Number.NaN)).toBe("anime connecting");
    expect(animeTag("paused", 0)).toBe("anime paused");
    expect(animeTag("stalled", 0)).toBe("anime stalled");
    expect(animeTag("error", 0)).toBe("anime stopped");
    expect(animeTag("budget", 0)).toBe("anime budget reached");
    expect(animeTag("off", 0)).toBeNull();
    expect(animeTag("live", 3)).toBeNull();
    expect(animeTag("unconfigured", 0)).toBeNull();
  });

  it("colours the dot blue only while AI pixels show, violet while anime works on it", () => {
    const tones: Record<AnimeView, ReturnType<typeof animeTone>> = {
      live: "live",
      connecting: "busy",
      stalled: "busy",
      off: "camera",
      paused: "camera",
      unconfigured: "camera",
      error: "camera",
      budget: "camera",
    };
    for (const [view, tone] of Object.entries(tones)) expect(animeTone(view as AnimeView), view).toBe(tone);
  });
});

// ── Billing guard ─────────────────────────────────────────────────────────────

const CFG = { idleSec: 30, hiddenSec: 10 };
const BASE: GuardInput = { now: 0, on: true, ai: "live", consumerVisible: false, poseIntent: false, tabHidden: false, sessionSeconds: 0 };

function step(state: GuardState, over: Partial<GuardInput>, cfg = CFG) {
  return guardStep(state, { ...BASE, ...over }, cfg);
}

/** Steps from `from` to `to` (inclusive) every `every` ms; returns the actions by time and the final state. */
function run(state: GuardState, from: number, to: number, every: number, input: (t: number) => Partial<GuardInput>, cfg = CFG) {
  const actions: Array<[number, GuardAction]> = [];
  let s = state;
  let used = 0;
  for (let t = from; t <= to; t += every) {
    const r = step(s, { now: t, ...input(t) }, cfg);
    s = r.state;
    used = r.usedSec;
    if (r.action !== "none") actions.push([t, r.action]);
  }
  return { state: s, actions, usedSec: used };
}

describe("billing guard: idle pause", () => {
  it("pauses after 30 s without a consumer, and not a step before, at a 5 Hz cadence", () => {
    let g = guardInit(0, 180);
    g = step(g, { now: 0, consumerVisible: true }).state;
    const r = run(g, 200, 30_000, 200, () => ({ consumerVisible: false }));
    expect(r.actions).toEqual([[30_000, "pause"]]);
  });

  it("restarts the idle clock whenever a consumer shows", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 50_000, 500, (t) => ({ consumerVisible: t === 20_000 }));
    expect(r.actions).toEqual([[50_000, "pause"]]);
  });

  it("stops asking once the session is paused", () => {
    let g = guardInit(0, 180);
    g = run(g, 0, 30_000, 1000, () => ({})).state;
    const r = run(g, 31_000, 120_000, 1000, () => ({ ai: "paused" }));
    expect(r.actions).toEqual([]);
  });

  it("does not count idle time while no session is running, so a late `d` is not paused at once", () => {
    let g = guardInit(0, 180);
    // Five minutes with anime off and the hands down.
    g = run(g, 0, 300_000, 10_000, () => ({ on: false, ai: "off" })).state;
    // `d`: the session starts connecting; the user has the full 30 s to open a frame.
    const r = run(g, 300_100, 330_000, 100, () => ({ ai: "connecting" }));
    expect(r.actions).toEqual([[330_000, "pause"]]);
  });

  it("holds the idle clock while the session is paused, so a resume gets a fresh 30 s", () => {
    let g = guardInit(0, 180);
    g = run(g, 0, 30_000, 1000, () => ({})).state; // paused at 30 s
    g = run(g, 31_000, 90_000, 1000, () => ({ ai: "paused" })).state;
    const r = run(g, 91_000, 120_000, 1000, () => ({ ai: "connecting" }));
    expect(r.actions).toEqual([[120_000, "pause"]]);
  });

  it("never pauses with idleSec 0", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 600_000, 1000, () => ({}), { idleSec: 0, hiddenSec: 10 });
    expect(r.actions).toEqual([]);
  });

  it("does nothing while anime is off", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 120_000, 1000, () => ({ on: false }));
    expect(r.actions).toEqual([]);
  });
});

describe("billing guard: resume", () => {
  it("does not resume from paused without pose intent, even with a (locked) frame on screen", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 60_000, 1000, () => ({ ai: "paused", consumerVisible: true, poseIntent: false }));
    expect(r.actions).toEqual([]);
  });

  it("resumes on pose intent", () => {
    const g = guardInit(0, 180);
    expect(step(g, { now: 1000, ai: "paused", poseIntent: true }).action).toBe("resume");
  });

  it("does not resume in a hidden tab, or while anime is off", () => {
    const g = guardInit(0, 180);
    expect(step(g, { now: 1000, ai: "paused", poseIntent: true, tabHidden: true }).action).toBe("none");
    expect(step(g, { now: 1000, ai: "paused", poseIntent: true, on: false }).action).toBe("none");
  });

  it("only resumes a paused session: pose intent while connecting or live is not an action", () => {
    const g = guardInit(0, 180);
    expect(step(g, { now: 1000, ai: "connecting", poseIntent: true }).action).toBe("none");
    expect(step(g, { now: 1000, ai: "live", poseIntent: true, consumerVisible: true }).action).toBe("none");
  });
});

describe("billing guard: hidden tab", () => {
  it("pauses after 10 s hidden and not before", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 10_000, 1000, () => ({ tabHidden: true, consumerVisible: true }));
    expect(r.actions).toEqual([[10_000, "pause"]]);
    expect(r.state.hiddenSince).toBe(0);
  });

  it("forgets the hidden time when the tab shows again", () => {
    let g = guardInit(0, 180);
    g = run(g, 0, 8000, 1000, () => ({ tabHidden: true, consumerVisible: true })).state;
    g = step(g, { now: 9000, tabHidden: false, consumerVisible: true }).state;
    expect(g.hiddenSince).toBeNull();
    const r = run(g, 10_000, 20_000, 1000, () => ({ tabHidden: true, consumerVisible: true }));
    expect(r.actions).toEqual([[20_000, "pause"]]);
  });

  it("tracks hiddenSince even while anime is off, but acts only when it is on and running", () => {
    let g = guardInit(0, 180);
    g = run(g, 0, 60_000, 1000, () => ({ tabHidden: true, on: false })).state;
    expect(g.hiddenSince).toBe(0);
    expect(step(g, { now: 61_000, tabHidden: true, ai: "paused" }).action).toBe("none");
  });

  it("never pauses for a hidden tab with hiddenSec 0", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 60_000, 1000, () => ({ tabHidden: true, consumerVisible: true }), { idleSec: 30, hiddenSec: 0 });
    expect(r.actions).toEqual([]);
  });
});

describe("billing guard: budget", () => {
  const live = (sec: number): Partial<GuardInput> => ({ ai: "live", consumerVisible: true, sessionSeconds: sec });

  it("stops exactly once when the granted seconds are reached, and reports what was used", () => {
    const g = guardInit(0, 180);
    const r = run(g, 0, 185_000, 1000, (t) => live(t / 1000));
    expect(r.actions).toEqual([[180_000, "stop-budget"]]);
    expect(r.usedSec).toBe(185);
    expect(r.state.grantSec).toBe(Infinity);
  });

  it("reports usedSec as the seconds billed so far", () => {
    const g = guardInit(0, 180);
    expect(step(g, live(0)).usedSec).toBe(0);
    expect(step(g, live(42)).usedSec).toBe(42);
    expect(step(g, live(179)).action).toBe("none");
    expect(step(g, live(180)).action).toBe("stop-budget");
  });

  it("starts a new grant from zero although the stopped session's counter still shows the old total", () => {
    let g = guardInit(0, 180);
    g = run(g, 0, 180_000, 1000, (t) => live(t / 1000)).state; // stopped at 180
    // The engine switched anime off; DecartSession keeps metrics.seconds at 180 until the next start.
    let r = run(g, 181_000, 190_000, 1000, () => ({ on: false, ai: "off", sessionSeconds: 180 }));
    expect(r.actions).toEqual([]);
    expect(r.usedSec).toBe(180);
    // `d` again: another 180 s. Before the new session starts, nothing is used.
    g = guardGrant(r.state, 180);
    r = step(g, { now: 191_000, ai: "connecting", sessionSeconds: 180 });
    expect(r.usedSec).toBe(0);
    expect(r.action).toBe("none");
    // The new session starts: its counter is back at 0.
    r = run(r.state, 192_000, 372_000, 1000, (t) => live((t - 192_000) / 1000));
    expect(r.actions).toEqual([[372_000, "stop-budget"]]);
    expect(r.usedSec).toBe(180); // the new grant alone, nothing carried over
  });

  it("sums the billed seconds across a pause and a resume, whose counter restarts at 0", () => {
    let g = guardInit(0, 180);
    g = run(g, 0, 50_000, 1000, (t) => live(t / 1000)).state; // 50 s live
    // Paused for a while: the counter is stale at 50 and nothing is added.
    let r = run(g, 51_000, 80_000, 1000, () => ({ ai: "paused", sessionSeconds: 50 }));
    expect(r.usedSec).toBe(50);
    expect(r.actions).toEqual([]);
    // Resume: the new session counts from 0 again; 50 already-billed seconds are kept.
    r = step(r.state, { now: 81_000, ai: "connecting", sessionSeconds: 0 });
    expect(r.usedSec).toBe(50);
    r = run(r.state, 82_000, 211_000, 1000, (t) => live((t - 82_000) / 1000));
    expect(r.usedSec).toBe(50 + 129);
    expect(r.actions).toEqual([]);
    expect(step(r.state, { now: 212_000, ...live(130) }).action).toBe("stop-budget");
  });

  it("does not fold a counter that keeps climbing across a reconnect, nor a repeated (dropped) tick", () => {
    const g = guardInit(0, 180);
    let r = step(g, { now: 1000, ai: "reconnecting", sessionSeconds: 10 });
    r = step(r.state, { now: 2000, ai: "reconnecting", sessionSeconds: 10 });
    r = step(r.state, { now: 3000, ...live(10) });
    expect(r.usedSec).toBe(10);
    r = step(r.state, { now: 4000, ...live(11) });
    expect(r.usedSec).toBe(11);
    expect(r.state.doneSec).toBe(0);
  });

  it("does not stop while anime is off, and a grant re-arms the stop", () => {
    let g = guardInit(0, 60);
    expect(step(g, { now: 0, on: false, ai: "off", sessionSeconds: 500 }).action).toBe("none");
    g = run(g, 0, 60_000, 1000, (t) => live(t / 1000)).state;
    expect(g.grantSec).toBe(Infinity);
    expect(step(g, { now: 61_000, ...live(61) }).action).toBe("none");
    g = guardGrant(g, 60);
    expect(g.grantSec).toBe(60);
    // Still the same session, counter climbing: the new chunk is measured from the grant.
    expect(step(g, { now: 62_000, ...live(62) }).usedSec).toBe(2);
    expect(step(g, { now: 120_000, ...live(120) }).action).toBe("stop-budget");
  });

  it("fails closed for a missing or non-positive budget", () => {
    expect(step(guardInit(0, 0), { now: 1000, ...live(0) }).action).toBe("stop-budget");
    expect(step(guardInit(0, Number.NaN), { now: 1000, ...live(0) }).action).toBe("stop-budget");
    expect(step(guardInit(0, -5), { now: 1000, ...live(0) }).action).toBe("stop-budget");
  });

  it("takes precedence over the idle pause in the same step", () => {
    const g = guardInit(0, 10);
    const r = step(g, { now: 60_000, ai: "live", consumerVisible: false, sessionSeconds: 10 });
    expect(r.action).toBe("stop-budget");
  });

  it("ignores a non-finite counter instead of corrupting the total", () => {
    const g = guardInit(0, 180);
    let r = step(g, { now: 1000, ...live(20) });
    r = step(r.state, { now: 2000, ...live(Number.NaN) });
    expect(r.usedSec).toBe(20);
    expect(r.action).toBe("none");
  });
});

describe("billing guard: state is plain data", () => {
  it("never mutates the state it is given", () => {
    const g = guardInit(0, 180);
    const frozen = Object.freeze({ ...g });
    const r = step(frozen as GuardState, { now: 40_000, ai: "live", sessionSeconds: 5 });
    expect(r.action).toBe("pause");
    expect(frozen).toEqual(g);
    expect(guardGrant(frozen as GuardState, 90).grantSec).toBe(90);
  });
});
