// Compares hand-tracking configurations on a fake webcam clip.
//   node scripts/bench-tracking.mjs --video hands.y4m [--url http://localhost:5199/]
// Prints steady-state render fps, tracking fps and inference time for each mode.
import { chromium } from "playwright";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const VIDEO = resolve(opt("--video"));
const BASE = opt("--url") ?? "http://localhost:5199/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const a = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${VIDEO}`,
    "--ignore-gpu-blocklist",
  ];
  for (const channel of [undefined, "chrome", "msedge"]) {
    try {
      return await chromium.launch({ headless: true, args: a, ...(channel ? { channel } : {}) });
    } catch (e) {
      if (channel === "msedge") throw e;
    }
  }
}

const modes = [
  ["worker", "gpu"],
  ["worker", "cpu"],
  ["main", "gpu"],
  ["main", "cpu"],
];
const rows = [];
for (const [tracker, delegate] of modes) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() =>
    localStorage.setItem("domain-portal:settings:v1", JSON.stringify({ source: "test", particles: true })),
  );
  await page.goto(`${BASE}?qa&tracker=${tracker}&delegate=${delegate}`);
  await page.getByRole("button", { name: /open the portal/i }).click();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const s = await page.evaluate(() => window.__domain.status());
    if (s.tracker === "ready" && s.hands >= 1) break;
    await sleep(250);
  }
  await sleep(3000); // warm-up
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    samples.push(await page.evaluate(() => window.__domain.status()));
  }
  const avg = (k) => samples.reduce((s, x) => s + x[k], 0) / samples.length;
  const detail = samples.at(-1).trackerDetail;
  rows.push({ mode: `${tracker}/${delegate}`, detail, renderFps: +avg("renderFps").toFixed(1), trackFps: +avg("trackFps").toFixed(1), inferenceMs: +avg("inferenceMs").toFixed(1) });
  console.log(JSON.stringify(rows.at(-1)));
  await browser.close();
}
console.table(rows);
