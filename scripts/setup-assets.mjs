// Copies the MediaPipe WASM runtime out of node_modules and downloads the hand
// landmarker model, so the app can run without reaching a CDN at runtime.
// Runs on `npm install` (postinstall). Failure is non-fatal: the browser falls
// back to the CDN copies of the same files.
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const outDir = join(root, "public", "mediapipe");
const wasmOut = join(outDir, "wasm");
const modelOut = join(outDir, "hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

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

async function downloadModel() {
  if (await exists(modelOut)) {
    console.log("[assets] hand_landmarker.task already present");
    return;
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(modelOut, buf);
  console.log(`[assets] downloaded hand_landmarker.task (${(buf.length / 1e6).toFixed(1)} MB)`);
}

try {
  await copyWasm();
} catch (err) {
  console.warn(`[assets] could not copy wasm (${err.message}); the app will use the CDN`);
}
try {
  await downloadModel();
} catch (err) {
  console.warn(`[assets] could not download model (${err.message}); the app will use the CDN`);
}
