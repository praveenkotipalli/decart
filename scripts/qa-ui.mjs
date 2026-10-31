// Screenshots of the UI chrome (Tune panel tabs, mobile layout) in the simulated demo.
//   node scripts/qa-ui.mjs [--url http://localhost:5199/]
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const args = process.argv.slice(2);
const URL = (args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:5199/") + "?qa";
const OUT = "qa-output";
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  for (const channel of [undefined, "chrome", "msedge"]) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch (e) {
      if (channel === "msedge") throw e;
    }
  }
}

const browser = await launch();
const errors = [];

const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desk.on("pageerror", (e) => errors.push(e.message));
await desk.goto(URL);
await desk.getByRole("button", { name: /simulated demo/i }).click();
await sleep(2500);
await desk.getByRole("button", { name: "Tune" }).click();
for (const tab of ["Transform", "Portal", "Tracking", "Gestures", "Keys"]) {
  await desk.getByRole("tab", { name: tab }).click();
  await sleep(500);
  await desk.screenshot({ path: `${OUT}/40-panel-${tab.toLowerCase()}.png` });
}

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
phone.on("pageerror", (e) => errors.push(e.message));
await phone.goto(URL);
await phone.getByRole("button", { name: /simulated demo/i }).click();
await sleep(3500);
await phone.screenshot({ path: `${OUT}/50-mobile-demo.png` });
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
await phone.getByRole("button", { name: "Tune" }).click();
await sleep(700);
await phone.screenshot({ path: `${OUT}/51-mobile-panel.png` });

console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors", "· mobile overflow:", overflow);
await browser.close();
