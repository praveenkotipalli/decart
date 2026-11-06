// Copies the MediaPipe WASM runtime out of node_modules and downloads the hand
// landmarker and face detector models, so the app can run without reaching a CDN
// at runtime. Runs on `npm install` (postinstall). Failure is non-fatal: the
// browser falls back to the CDN copies of the same files.
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const outDir = join(root, "public", "mediapipe");
const wasmOut = join(outDir, "wasm");
const MODELS = [
  {
    file: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  },
  {
    file: "blaze_face_short_range.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
  },
];

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function copyWasm() {
  await mkdir(wasmOut, { recursive: true });
  const files = await readdir(wasmSrc);
  await Promise.all(files.map((f) => copyFile(join(wasmSrc, f), join(wasmOut, f))));
  console.log(`[assets] copied ${files.length} MediaPipe wasm files`);
}

async function downloadModel({ file, url }) {
  const out = join(outDir, file);
  if (await exists(out)) {
    console.log(`[assets] ${file} already present`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  const size = buf.length > 1e6 ? `${(buf.length / 1e6).toFixed(1)} MB` : `${Math.round(buf.length / 1e3)} kB`;
  console.log(`[assets] downloaded ${file} (${size})`);
}

try {
  await copyWasm();
} catch (err) {
  console.warn(`[assets] could not copy wasm (${err.message}); the app will use the CDN`);
}
for (const model of MODELS) {
  try {
    await downloadModel(model);
  } catch (err) {
    console.warn(`[assets] could not download ${model.file} (${err.message}); the app will use the CDN`);
  }
}
