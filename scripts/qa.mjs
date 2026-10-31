// End-to-end visual QA. Drives the running app (npm run dev) in Chromium.
//
//   node scripts/qa.mjs                       start screen + simulated demo
//   node scripts/qa.mjs --video hands.y4m     + real MediaPipe tracking on a fake webcam clip
//   node scripts/qa.mjs --video hands.y4m --decart   + a short, real Decart session (billed!)
//
// Screenshots and results.json go to qa-output/.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const URL = opt("--url") ?? "http://localhost:5199/?qa";
const VIDEO = opt("--video");
const DECART = args.includes("--decart");
const ONLY_CAMERA = args.includes("--camera-only");
const HEADED = args.includes("--headed");
const OUT = resolve("qa-output");
await mkdir(OUT, { recursive: true });

const results = { url: URL, startedAt: new Date().toISOString(), checks: [], metrics: {} };
const check = (name, ok, detail = "") => {
  results.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNEL = opt("--channel");
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

async function settings(page, patch) {
  await page.addInitScript((p) => {
    const key = "domain-portal:settings:v1";
    const cur = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(key, JSON.stringify({ ...cur, ...p }));
  }, patch);
}

const state = (page) => page.evaluate(() => window.__domain.state());
const status = (page) => page.evaluate(() => window.__domain.status());

async function waitFor(page, fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await status(page).catch(() => null);
    const d = await state(page).catch(() => null);
    if (s && d && fn(s, d)) return { s, d, ms: Date.now() - t0 };
    await sleep(150);
  }
  console.log(`  (timed out waiting for ${label})`);
  return null;
}

const angle = (q) => (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180) / Math.PI;

// ── 1. Start screen ─────────────────────────────────────────────────────────
if (!ONLY_CAMERA) {
  const browser = await launch();
  for (const [name, viewport] of [
    ["01-start-desktop", { width: 1440, height: 900 }],
    ["02-start-mobile", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: name.includes("mobile") ? 2 : 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(URL);
    await page.waitForSelector(".start__title");
    await page.evaluate(() => document.fonts.ready);
    await sleep(1200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`${name}: renders without page errors`, errors.length === 0, errors.join(" | "));
    check(`${name}: no horizontal overflow`, !overflow);
    await page.close();
  }
  await browser.close();
}

// ── 2. Simulated hands demo (no camera) ─────────────────────────────────────
if (!ONLY_CAMERA) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await settings(page, { source: "test", showSkeleton: true });
  await page.goto(URL);
  await page.getByRole("button", { name: /simulated demo/i }).click();
  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2");
    const ext = c?.getExtension("WEBGL_debug_renderer_info");
    return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  results.metrics.webglRenderer = gl;

  const beats = [
    ["03-sim-open", /portal opens/i],
    ["04-sim-rotate", /Rotate/],
    ["05-sim-scale", /Scale/],
    ["06-sim-tilt", /Tilt/],
    ["07-sim-locked", /Locked: hands move/],
    ["08-sim-crossed", /Fingers cross/],
  ];
  const seen = {};
  for (const [name, re] of beats) {
    const hit = await waitFor(page, (s) => re.test(s.simCaption), 30000, name);
    await sleep(name === "08-sim-crossed" ? 1300 : 900);
    const d = await state(page);
    seen[name] = d;
    await page.screenshot({ path: `${OUT}/${name}.png` });
    if (!hit) check(`${name}: beat reached`, false);
  }
  const open = seen["03-sim-open"];
  check("sim: portal opens from four tracked corners", open.phase === "tracking" && open.corners && open.visibility > 0.9, `phase=${open.phase} vis=${open.visibility?.toFixed(2)}`);
  check("sim: rotation turns the portal", Math.abs(angle(seen["04-sim-rotate"].corners)) > 4, `top edge ${angle(seen["04-sim-rotate"].corners).toFixed(1)}°`);
  check("sim: pinch locks the portal", seen["07-sim-locked"].locked === true);
  const crossed = seen["08-sim-crossed"];
  check("sim: crossed corners detected and last valid shape held", crossed.validity !== "valid" && crossed.corners !== null, `validity=${crossed.validity}`);
  const st = await status(page);
  results.metrics.sim = { renderFps: st.renderFps, trackFps: st.trackFps };
  check("sim: no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
}

// ── 3. Real hand tracking on a fake webcam clip ──────────────────────────────
if (VIDEO) {
  const browser = await launch([
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve(VIDEO)}`,
  ]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => /decart|tracker|livekit/i.test(m.text()) && console.log(`  console.${m.type()}:`, m.text().slice(0, 300)));
  // AI state timeline, for diagnosing connection problems.
  let lastAI = "";
  const aiTimer = setInterval(async () => {
    const s = await status(page).catch(() => null);
    const line = s ? `${s.ai.state}${s.ai.detail ? ` — ${s.ai.detail}` : ""}` : "";
    if (line && line !== lastAI) {
      lastAI = line;
      console.log(`  ai: ${line}`);
    }
  }, 250);
  await settings(page, { source: "test", showSkeleton: true, mode: "two-hand" });
  await page.goto(URL);
  await page.getByRole("button", { name: /open the portal/i }).click();

  const ready = await waitFor(page, (s) => s.camera === "on" && s.tracker === "ready", 60000, "tracker");
  check("camera: starts and MediaPipe loads", !!ready, ready ? `${ready.s.trackerDetail} in ${ready.ms} ms` : "");
  const tracked = await waitFor(page, (s, d) => s.hands >= 2 && d.phase === "tracking", 30000, "two hands");
  check("camera: MediaPipe detects both hands and opens the portal", !!tracked, tracked ? `after ${tracked.ms} ms` : "");

  const angles = [];
  for (const [i, wait] of [[0, 400], [1, 1800], [2, 1800], [3, 1800], [4, 1800]]) {
    await sleep(wait);
    const d = await state(page);
    if (d.corners) angles.push(angle(d.corners));
    await page.screenshot({ path: `${OUT}/1${i}-camera-test-pattern.png` });
  }
  const spread = angles.length ? Math.max(...angles) - Math.min(...angles) : 0;
  check("camera: portal rotates with the hands", spread > 6, `top-edge angle range ${spread.toFixed(1)}° over ${angles.length} samples`);
  const st = await status(page);
  results.metrics.camera = { renderFps: st.renderFps, trackFps: st.trackFps, inferenceMs: +st.inferenceMs.toFixed(1), tracker: st.trackerDetail };
  check("camera: rendering stays smooth while tracking runs", st.renderFps >= 50, `${st.renderFps} fps`);
  const ceiling = 1000 / Math.max(st.inferenceMs, 1);
  check(
    "camera: tracking keeps pace with inference (no queueing)",
    st.trackFps >= Math.min(25, ceiling) * 0.75,
    `${st.trackFps} Hz with ${st.inferenceMs.toFixed(1)} ms inference (ceiling ≈ ${ceiling.toFixed(0)} Hz)`,
  );
  console.log(`NOTE  tracking rate ${st.trackFps} Hz vs the 30 Hz goal — bound by inference time on this machine`);

  // Local preview: must be labelled as not AI output (burnt into the texture).
  await page.keyboard.press("t");
  await page.getByRole("radio", { name: "Local preview" }).click();
  await page.keyboard.press("Escape");
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/20-camera-local-preview.png` });
  check("camera: local preview selected", (await status(page)).content === "local");

  if (DECART) {
    await page.keyboard.press("a");
    const live = await waitFor(page, (s) => s.ai.state === "live" || s.ai.state === "error" || s.ai.state === "unconfigured", 60000, "decart live");
    const s1 = live?.s;
    check("decart: session goes live", s1?.ai.state === "live", s1 ? `${s1.ai.state} ${s1.ai.detail} (${live.ms} ms)` : "timeout");
    if (s1?.ai.state === "live") {
      const frames = await waitFor(page, (s) => s.ai.fps > 0, 20000, "decart frames");
      await sleep(5000);
      const s2 = await status(page);
      await page.screenshot({ path: `${OUT}/30-decart-live.png` });
      await sleep(3000);
      await page.screenshot({ path: `${OUT}/31-decart-live.png` });
      results.metrics.decart = {
        connectToLiveMs: live.ms,
        outputFps: s2.ai.fps,
        latencyMs: s2.ai.latencyMs,
        latencyKind: s2.ai.latencyKind,
        ttffMs: s2.ai.ttffMs,
        billedSeconds: s2.ai.seconds,
        quality: s2.ai.quality,
        content: s2.content,
      };
      check("decart: transformed frames arrive and render in the portal", !!frames && s2.content === "decart", `${s2.ai.fps} fps`);
    }
    await page.keyboard.press("a");
    await sleep(1500);
    const off = await status(page);
    check("decart: switching AI off ends the session", off.ai.state === "off", off.ai.state);
    results.metrics.decartBilledSeconds = off.ai.seconds;
  }
  check("camera: no page errors", errors.length === 0, errors.join(" | "));
  clearInterval(aiTimer);
  await browser.close();
}

results.finishedAt = new Date().toISOString();
await writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.checks.filter((c) => !c.ok).length;
console.log(`\n${results.checks.length - failed}/${results.checks.length} checks passed · metrics:`, JSON.stringify(results.metrics));
process.exit(failed ? 1 : 0);
