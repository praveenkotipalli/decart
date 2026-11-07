// End-to-end QA of the hand-frame toy. Drives the running app (npm run dev) in Chrome.
//
//   node scripts/qa-toy.mjs                         start screen, simulated demo, layout
//   node scripts/qa-toy.mjs --clips <dir>           + real MediaPipe on fake-webcam clips (scripts/qa/make_frames.py)
//   node scripts/qa-toy.mjs --clips <dir> --decart  + a short, real Decart session (BILLED, about $0.20)
//   node scripts/qa-toy.mjs --only sim|layout|clips|decart
//
// Screenshots and toy-results.json go to qa-output/.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BASE = opt("--url") ?? "http://localhost:5199/";
const CLIPS = opt("--clips");
const ONLY = opt("--only");
const DECART = args.includes("--decart");
const HEADED = args.includes("--headed");
const CHANNEL = opt("--channel");
const OUT = resolve("qa-output");
await mkdir(OUT, { recursive: true });

const want = (section) => !ONLY || ONLY === section;
const results = { url: BASE, startedAt: new Date().toISOString(), checks: [], metrics: {} };
const check = (name, ok, detail = "") => {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (query = "") => `${BASE}?qa${query ? `&${query}` : ""}`;

async function launch(extra = []) {
  const base = {
    headless: !HEADED,
    args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", ...extra],
  };
  // Bundled Chromium if installed (`npx playwright install chromium`), else the system Chrome/Edge.
  for (const channel of CHANNEL ? [CHANNEL] : [undefined, "chrome", "msedge"]) {
    try {
      return await chromium.launch({ ...base, ...(channel ? { channel } : {}) });
    } catch (err) {
      if (channel === "msedge" || CHANNEL) throw err;
    }
  }
}

/** Seeds the stored settings before the app loads. */
async function settings(page, patch) {
  await page.addInitScript((p) => {
    const key = "domain-portal:settings:v2";
    const cur = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(key, JSON.stringify({ schema: 2, ...cur, ...p }));
  }, patch);
}

const state = (page) => page.evaluate(() => window.__domain.state());
const status = (page) => page.evaluate(() => window.__domain.status());
const probe = (page, points) => page.evaluate((p) => window.__domain.probe(p), points);

async function waitFor(page, fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await status(page).catch(() => null);
    const d = await state(page).catch(() => null);
    if (s && d && fn(s, d)) return { s, d, ms: Date.now() - t0 };
    await sleep(100);
  }
  console.log(`  (timed out waiting for ${label})`);
  return null;
}

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|WebSocket|websocket|\[vite\]/i.test(m.text()) && errors.push(m.text().slice(0, 240)));
  return errors;
}

const centroid = (q) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
/** How far a colour is from grey: the filters are strongly tinted, the simulated scene is nearly neutral. */
const chroma = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

// ── 1. Start screen ─────────────────────────────────────────────────────────
if (want("layout")) {
  const browser = await launch();
  for (const [name, viewport, dsf] of [
    ["60-toy-start-desktop", { width: 1440, height: 900 }, 1],
    ["61-toy-start-mobile", { width: 390, height: 844 }, 2],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: dsf });
    const errors = watchErrors(page);
    await page.goto(url());
    await page.waitForSelector(".start__title");
    await page.evaluate(() => document.fonts.ready);
    await sleep(2600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`${name}: renders without errors`, errors.length === 0, errors.join(" | "));
    check(`${name}: no horizontal overflow`, !overflow);
    await page.close();
  }
  await browser.close();
}

// ── 2. Simulated demo: the whole interaction without a camera ───────────────
if (want("sim")) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = watchErrors(page);
  await page.goto(url());
  await page.getByRole("button", { name: /simulated demo/i }).click();
  results.metrics.webglRenderer = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2");
    const ext = c?.getExtension("WEBGL_debug_renderer_info");
    return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });

  // Open palms first: trackers, no frame.
  const palms = await waitFor(page, (s) => s.toy && s.toy.handsFresh === 2 && s.toy.poseA === "palm" && s.toy.poseB === "palm", 30000, "open palms");
  check("sim: open palms are tracked and do not open a frame", palms && palms.s.toy.gate !== "open" && !palms.s.toy.frameVisible, palms ? `gate=${palms.s.toy.gate}` : "never saw two open palms");
  await page.screenshot({ path: `${OUT}/62-toy-palms.png` });

  // Two L shapes: the frame opens on the fingertips.
  const open = await waitFor(page, (s, d) => s.toy?.gate === "open" && d.frame && d.frame.visibility > 0.95, 30000, "frame open");
  check("sim: two L shapes open the frame", !!open, open ? `after ${open.ms} ms, poses ${open.s.toy.poseA}/${open.s.toy.poseB}` : "");
  if (open) {
    await sleep(500);
    const d = await state(page);
    const q = d.frame.quad;
    const c = centroid(q);
    const [inside, outside] = await probe(page, [c, { x: 0.04, y: 0.5 }]);
    await page.screenshot({ path: `${OUT}/63-toy-frame-rose.png` });
    check("sim: inside the frame is filtered (rose), outside is the plain picture", chroma(inside) > 40 && inside[0] > inside[1] && chroma(outside) < 40, `inside rgb(${inside.slice(0, 3)}) outside rgb(${outside.slice(0, 3)})`);
    check("sim: the frame is drawn where the fingers are (top edge above bottom edge, left of right)", q[0].y < q[3].y && q[1].y < q[2].y && q[0].x < q[1].x, JSON.stringify(q.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2)])));
  }

  // One hand turns over: bow-tie, and the filter steps exactly once.
  const before = (await state(page)).filter;
  const crossed = await waitFor(page, (s) => s.toy?.crossed === true, 20000, "crossed frame");
  if (crossed) {
    await sleep(120);
    await page.screenshot({ path: `${OUT}/64-toy-bowtie.png` });
  }
  check("sim: turning a hand over crosses the frame and it stays open", crossed && crossed.s.toy.gate === "open", crossed ? "" : "never crossed");
  const flipped = await waitFor(page, (s, d) => d.filter !== before, 8000, "filter change");
  await sleep(2500);
  const after = (await state(page)).filter;
  check("sim: the flip steps the filter once", flipped && after === "cobalt", `${before} → ${after}`);
  await page.screenshot({ path: `${OUT}/65-toy-frame-cobalt.png` });

  // Open palms let go; the OK sign opens one loupe.
  const closed = await waitFor(page, (s) => s.toy?.gate !== "open" && !s.toy?.frameVisible, 20000, "frame closed");
  check("sim: open palms let the frame go", !!closed);
  const loupe = await waitFor(page, (s) => s.toy?.loupes === 1, 20000, "loupe");
  if (loupe) {
    await sleep(700);
    await page.screenshot({ path: `${OUT}/66-toy-loupe.png` });
  }
  check("sim: the OK sign opens one loupe and no frame", loupe && loupe.s.toy.gate !== "open", loupe ? `pose ${loupe.s.toy.poseB}` : "no loupe");

  // Keys.
  await page.keyboard.press("t");
  await sleep(300);
  await page.screenshot({ path: `${OUT}/67-toy-trackers-off.png` });
  await page.keyboard.press("t");
  const effects = ["draw", "particles", "fog", "vanish", "frame"];
  for (const [i, effect] of effects.entries()) {
    await page.keyboard.press(String(((i + 1) % 5) + 1));
    const ok = await waitFor(page, (s) => s.toy?.effect === effect, 3000, `effect ${effect}`);
    check(`sim: key ${((i + 1) % 5) + 1} selects ${effect}`, !!ok);
  }

  // Each effect at a moment where it shows something.
  await page.keyboard.press("2");
  await waitFor(page, (s) => s.toy?.poseA === "point" || s.toy?.poseB === "point", 30000, "pointing beat");
  await sleep(1800);
  await page.screenshot({ path: `${OUT}/68-toy-draw.png` });
  await page.keyboard.press("3");
  await sleep(4000);
  const sparks = (await state(page)).sparks;
  await page.screenshot({ path: `${OUT}/69-toy-particles.png` });
  check("sim: moving hands shed sparks", sparks > 10, `${sparks} sparks`);
  await page.keyboard.press("4");
  await sleep(5000);
  await page.screenshot({ path: `${OUT}/70-toy-fog.png` });
  await page.keyboard.press("5");
  await page.keyboard.press("c");
  const plate = await waitFor(page, (s) => s.toy?.plate === "ready", 9000, "room memorised");
  check("sim: vanish memorises the room after the countdown", !!plate);
  const vopen = await waitFor(page, (s, d) => s.toy?.gate === "open" && d.frame?.visibility > 0.95, 30000, "vanish frame");
  if (vopen) {
    await sleep(400);
    await page.screenshot({ path: `${OUT}/71-toy-vanish.png` });
  }
  check("sim: the vanish frame opens with two L shapes", !!vopen);
  await page.keyboard.press("1");

  // Hide the controls: the bands collapse and the stage grows.
  const box = () => page.evaluate(() => {
    const r = document.querySelector(".stage").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const shown = await box();
  await page.keyboard.press("h");
  await sleep(500);
  const hidden = await box();
  await page.screenshot({ path: `${OUT}/72-toy-chrome-hidden.png` });
  check("sim: h hides the controls and the stage grows", hidden.h > shown.h + 40, `${Math.round(shown.h)} → ${Math.round(hidden.h)} px`);
  await page.keyboard.press("Escape");
  await sleep(400);
  const back = await box();
  check("sim: Esc brings the controls back", Math.abs(back.h - shown.h) < 2);

  const st = await status(page);
  results.metrics.sim = { renderFps: st.renderFps, trackFps: st.trackFps };
  check("sim: rendering stays smooth", st.renderFps >= 50, `${st.renderFps} fps`);
  check("sim: no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
}

// ── 3. Layout at three viewports, the panel, reduced motion ─────────────────
if (want("layout")) {
  const browser = await launch();
  for (const [name, viewport, extra] of [
    ["73-toy-1440x900", { width: 1440, height: 900 }, {}],
    ["74-toy-1366x650", { width: 1366, height: 650 }, {}],
    ["75-toy-390x844", { width: 390, height: 844 }, { deviceScaleFactor: 2, hasTouch: true, isMobile: true }],
  ]) {
    const page = await browser.newPage({ viewport, ...extra });
    const errors = watchErrors(page);
    await page.goto(url());
    await page.getByRole("button", { name: /simulated demo/i }).click();
    await waitFor(page, (s, d) => s.toy?.gate === "open" && d.frame?.visibility > 0.95, 30000, "frame open");
    await page.evaluate(() => document.fonts.ready);
    await sleep(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const m = await page.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom };
      };
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        stage: r(".stage"),
        top: r(".band--top"),
        bottom: r(".band--bottom"),
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    const ar = m.stage.w / m.stage.h;
    check(`${name}: no errors, no horizontal overflow`, errors.length === 0 && !m.overflow, errors.join(" | "));
    check(`${name}: the stage has the camera's shape`, Math.abs(ar - 16 / 9) < 0.02, `${Math.round(m.stage.w)}×${Math.round(m.stage.h)} = ${ar.toFixed(3)}`);
    check(
      `${name}: no control overlaps the picture`,
      m.top && m.bottom && m.top.b <= m.stage.y + 1 && m.bottom.y >= m.stage.b - 1 && m.stage.x >= -1 && m.stage.r <= m.vw + 1,
      `top band to ${Math.round(m.top?.b)}, stage ${Math.round(m.stage.y)}–${Math.round(m.stage.b)}, bottom band from ${Math.round(m.bottom?.y)}`,
    );
    if (name.includes("1440")) {
      await page.keyboard.press("p");
      await sleep(700);
      for (const tab of ["Look", "Anime", "Tracking", "Keys"]) {
        await page.getByRole("tab", { name: tab }).click();
        await sleep(350);
        await page.screenshot({ path: `${OUT}/76-toy-panel-${tab.toLowerCase()}.png` });
      }
      await page.keyboard.press("Escape");
    }
    if (name.includes("390")) {
      await page.getByRole("button", { name: /tune/i }).first().click();
      await sleep(700);
      await page.screenshot({ path: `${OUT}/77-toy-mobile-panel.png` });
    }
    await page.close();
  }

  const calm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const calmErrors = watchErrors(calm);
  await calm.goto(url());
  await calm.getByRole("button", { name: /simulated demo/i }).click();
  const calmOpen = await waitFor(calm, (s, d) => s.toy?.gate === "open" && d.frame?.visibility > 0.95, 30000, "frame open (reduced motion)");
  await calm.keyboard.press("f");
  await sleep(60);
  const tr = (await state(calm)).treatment;
  await calm.screenshot({ path: `${OUT}/78-toy-reduced-motion.png` });
  check("reduced motion: the frame opens and filter changes cross-fade instead of glitching", calmOpen && tr && tr.tiles === false && calmErrors.length === 0, JSON.stringify(tr));
  await browser.close();
}

// ── 4. Real MediaPipe landmarks on fake-webcam clips ────────────────────────
async function withClip(clip, opts, body) {
  const browser = await launch([
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve(join(CLIPS, `${clip}.mjpeg`))}`,
  ]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera"] });
  const page = await context.newPage();
  const errors = watchErrors(page);
  if (opts.settings) await settings(page, opts.settings);
  await page.goto(url(opts.query ?? ""));
  await page.getByRole("button", { name: /open the portal/i }).click();
  const ready = await waitFor(page, (s) => s.camera === "on" && s.tracker === "ready" && s.trackFps > 0, 90000, "tracker");
  try {
    if (!ready) check(`${clip}: camera and tracker start`, false);
    else await body(page, errors, ready);
  } finally {
    await browser.close();
  }
}

if (CLIPS && want("clips")) {
  const expectations = [
    // clip, what must be true after it has settled
    ["s_twoL", (s) => s.toy.gate === "open" && !s.toy.crossed, "two real L hands open a convex frame"],
    ["s_oneL", (s) => s.toy.gate !== "open" && s.hands === 1, "one L alone does not open a frame"],
    ["s_empty", (s) => s.toy.gate !== "open" && s.hands === 0, "no hands, no frame"],
    ["s_twoL_B_tipped", (s) => s.toy.gate === "open" && s.toy.crossed, "one hand tipped over gives a crossed frame"],
    ["a2_director_landscape", (s) => s.toy.gate === "open", "a director's frame (one palm, one back) opens the frame"],
    ["n1_two_index_up", (s) => s.toy.gate !== "open", "two raised index fingers with thumbs in do not open a frame"],
    ["mp_woman_hands", (s) => s.toy.gate !== "open", "two open hands do not open a frame"],
    ["d1_open_palm", (s) => s.toy.gate !== "open" && s.toy.loupes === 0, "an open palm does nothing"],
    ["c1_ok_right_palm", (s) => s.toy.loupes === 1 && s.toy.gate !== "open", "an OK sign opens one loupe"],
    ["c3_ok_over_eye", (s) => s.toy.loupes === 1, "an OK sign held over the eye opens a loupe"],
  ];
  for (const [clip, ok, label] of expectations) {
    await withClip(clip, {}, async (page, errors) => {
      await sleep(3500);
      const s = await status(page);
      const d = await state(page);
      await page.screenshot({ path: `${OUT}/80-clip-${clip}.png` });
      check(`${clip}: ${label}`, ok(s, d), `gate=${s.toy.gate} crossed=${s.toy.crossed} loupes=${s.toy.loupes} poses=${s.toy.poseA}/${s.toy.poseB} hands=${s.hands}`);
      check(`${clip}: no page errors`, errors.length === 0, errors.join(" | "));
      if (clip === "s_twoL") {
        results.metrics.camera = { renderFps: s.renderFps, trackFps: s.trackFps, inferenceMs: +s.inferenceMs.toFixed(1), tracker: s.trackerDetail };
        check("s_twoL: rendering stays smooth while tracking runs", s.renderFps >= 50, `${s.renderFps} fps, tracking ${s.trackFps} Hz, ${s.inferenceMs.toFixed(0)} ms`);
      }
    });
  }

  // The flip story: turned over once, back, tipped over once, back → exactly two filter steps.
  await withClip("story_flip", {}, async (page) => {
    const seen = [];
    let last = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 24000) {
      const d = await state(page).catch(() => null);
      if (d && d.filter !== last) {
        last = d.filter;
        seen.push(d.filter);
      }
      await sleep(150);
    }
    await page.screenshot({ path: `${OUT}/81-clip-story-flip.png` });
    // The clip loops every 20 s, so a 24 s watch can catch the start of a second pass.
    check("story: each turn-over steps the filter once", seen.slice(0, 3).join(",") === "rose,cobalt,violet", seen.join(" → "));
  });

  // The face box, forced on (the automatic mode waits for tracking headroom).
  await withClip("a2_director_landscape", { settings: { faceBox: "on" } }, async (page) => {
    const face = await waitFor(page, (s) => s.faceTracking === true && s.toy?.face === true, 30000, "face box");
    await sleep(800);
    await page.screenshot({ path: `${OUT}/82-clip-face-box.png` });
    const s = await status(page);
    check("face: the detector starts in the tracking worker and finds the face", !!face, `faceTracking=${s.faceTracking} face=${s.toy?.face} tracking ${s.trackFps} Hz`);
    results.metrics.withFace = { renderFps: s.renderFps, trackFps: s.trackFps, inferenceMs: +s.inferenceMs.toFixed(1) };
  });
}

// ── 5. Decart: a short real session (billed) ────────────────────────────────
if (CLIPS && DECART && want("decart")) {
  await withClip("a2_director_landscape", { query: "debug=onion" }, async (page) => {
    const open = await waitFor(page, (s) => s.toy?.gate === "open", 20000, "frame open");
    check("decart: the frame is open before anime is switched on", !!open);
    const t0 = Date.now();
    await page.keyboard.press("d");
    const live = await waitFor(page, (s) => ["live", "error", "unconfigured"].includes(s.anime.view), 90000, "anime live");
    const s1 = live?.s;
    check("decart: anime goes live", s1?.anime.view === "live", s1 ? `${s1.anime.view} ${s1.ai.detail} after ${Date.now() - t0} ms` : "timeout");
    if (s1?.anime.view === "live") {
      await sleep(5000);
      const s2 = await status(page);
      const d2 = await state(page);
      await page.screenshot({ path: `${OUT}/90-decart-anime-onion.png` });
      const size = await page.evaluate(() => {
        const v = [...document.querySelectorAll("video")].find((x) => x.srcObject && x.videoWidth && x.style.position === "fixed");
        return v ? `${v.videoWidth}x${v.videoHeight}` : "unknown";
      });
      results.metrics.decart = {
        model: s2.anime.model,
        connectToLiveMs: Date.now() - t0 - 5000,
        outputFps: s2.ai.fps,
        latencyMs: s2.ai.latencyMs,
        latencyKind: s2.ai.latencyKind,
        ttffMs: s2.ai.ttffMs,
        billedSeconds: s2.ai.seconds,
        outputSize: size,
        warning: s2.anime.warning,
        treatment: d2.treatment,
      };
      check("decart: the frame shows the AI picture", d2.treatment?.animeTo === 1, JSON.stringify(d2.treatment));
      check("decart: the AI frame has the shape that was sent", !s2.anime.warning, s2.anime.warning ?? size);
    }
    await page.keyboard.press("d");
    await sleep(1500);
    const off = await status(page);
    check("decart: d switches anime off and ends the session", off.anime.view === "off" && off.ai.state === "off", `${off.anime.view} / ${off.ai.state}`);
    results.metrics.decartBilledSeconds = off.ai.seconds;
  });
}

results.finishedAt = new Date().toISOString();
await writeFile(`${OUT}/toy-results.json`, JSON.stringify(results, null, 2));
const failed = results.checks.filter((c) => !c.ok).length;
console.log(`\n${results.checks.length - failed}/${results.checks.length} checks passed · metrics:`, JSON.stringify(results.metrics));
process.exit(failed ? 1 : 0);
