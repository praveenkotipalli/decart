// Runs MediaPipe (the same models and wasm the app ships) on still frames and writes the
// landmarks as a JSON fixture, so gesture logic can be unit-tested on real hands.
//
//   node scripts/qa/landmarks.mjs <frames_dir> <out.json> [--url http://localhost:5199/]
//
// Needs the dev server running (it serves /mediapipe and the tasks-vision bundle).
// The frames come from scripts/qa/make_frames.py. Only numbers are written, no pixels.
import { chromium } from "playwright";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [framesDir, outFile] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");
if (!framesDir || !outFile) {
  console.error("usage: node scripts/qa/landmarks.mjs <frames_dir> <out.json> [--url http://localhost:5199/]");
  process.exit(2);
}
const BASE = flag("--url") ?? "http://localhost:5199/";

async function launch() {
  // The bundled Chromium is usually not installed here; the system Chrome or Edge is.
  for (const channel of [undefined, "chrome", "msedge"]) {
    try {
      return await chromium.launch({ headless: true, args: ["--ignore-gpu-blocklist"], ...(channel ? { channel } : {}) });
    } catch (err) {
      if (channel === "msedge") throw err;
    }
  }
}

const files = (await readdir(framesDir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const images = [];
for (const f of files) {
  const bytes = await readFile(join(framesDir, f));
  const mime = /png$/i.test(f) ? "image/png" : "image/jpeg";
  images.push({ name: basename(f, extname(f)), url: `data:${mime};base64,${bytes.toString("base64")}` });
}

const browser = await launch();
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.log("  page:", m.text().slice(0, 200)));
// A blank same-origin page: the models and wasm load from the dev server, the app itself does not.
await page.route("**/__qa_blank", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>landmarks</title>" }));
await page.goto(new URL("__qa_blank", BASE).href);

const result = await page.evaluate(async (images) => {
  const vision = await import("/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs");
  const fileset = await vision.FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const hands = await vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/mediapipe/hand_landmarker.task", delegate: "CPU" },
    runningMode: "IMAGE",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  const faces = await vision.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/mediapipe/blaze_face_short_range.tflite", delegate: "CPU" },
    runningMode: "IMAGE",
  });
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const out = [];
  for (const { name, url } of images) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const h = hands.detect(img);
    const f = faces.detect(img);
    out.push({
      name,
      width: img.naturalWidth,
      height: img.naturalHeight,
      // Exactly what the tracking worker posts (RawHands): normalised, unmirrored.
      hands: {
        landmarks: h.landmarks.map((l) => l.map((p) => ({ x: r5(p.x), y: r5(p.y), z: r5(p.z) }))),
        world: h.worldLandmarks.map((l) => l.map((p) => ({ x: r5(p.x), y: r5(p.y), z: r5(p.z) }))),
        handedness: h.handedness.map((c) => ({ label: c[0]?.categoryName ?? "", score: r5(c[0]?.score ?? 0) })),
      },
      faces: f.detections.map((d) => ({
        x: r5((d.boundingBox?.originX ?? 0) / img.naturalWidth),
        y: r5((d.boundingBox?.originY ?? 0) / img.naturalHeight),
        w: r5((d.boundingBox?.width ?? 0) / img.naturalWidth),
        h: r5((d.boundingBox?.height ?? 0) / img.naturalHeight),
        score: r5(d.categories?.[0]?.score ?? 0),
      })),
    });
  }
  hands.close();
  faces.close();
  return out;
}, images);
await browser.close();

await writeFile(resolve(outFile), JSON.stringify({ generatedBy: "scripts/qa/landmarks.mjs", frames: result }));
for (const f of result) console.log(`${f.name.padEnd(28)} hands ${f.hands.landmarks.length}  faces ${f.faces.length}`);
console.log(`\n${result.length} frames → ${outFile}`);
