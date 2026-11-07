// Compiles and links every program of the hand-frame toy (src/render/toyShaders.ts) in a
// real WebGL2 context and exits non-zero on any compile or link error. The static tests in
// tests/toyShaders.test.ts cannot see GLSL type errors; ANGLE's translator can.
//
//   npx tsx scripts/check-shaders.mjs            (tsx resolves the .ts import)
//   npx tsx scripts/check-shaders.mjs --channel msedge
//
// A listed uniform whose location comes back null is only a warning: the compiler drops a
// uniform that nothing reads. An active uniform missing from the table is a warning too,
// since the renderer could never set it. One headless browser is launched (the system
// Chrome or Edge, like scripts/qa.mjs: the bundled Chromium is not installed), about:blank
// is opened, and the browser is closed as soon as the results are in. No server is started.
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CHANNEL = opt("--channel");

const { TOY_PROGRAMS } = await import("../src/render/toyShaders.ts");

async function launch(extra = []) {
  const base = {
    headless: true,
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
  throw new Error("no browser could be launched");
}

/** Runs in the page: compiles and links each program, collecting logs. */
function compileAll(programs) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
  if (!gl) return { renderer: null, results: [] };
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const results = [];
  for (const [name, { vs, fs, uniforms }] of Object.entries(programs)) {
    const r = { name, ok: true, errors: [], warnings: [], missing: [], unlisted: [] };
    const compile = (type, src, label) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      const log = (gl.getShaderInfoLog(s) || "").trim();
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        r.ok = false;
        r.errors.push(`${label} shader: ${log || "(no info log)"}`);
      } else if (log) r.warnings.push(`${label} shader: ${log}`);
      return s;
    };
    const v = compile(gl.VERTEX_SHADER, vs, "vertex");
    const f = compile(gl.FRAGMENT_SHADER, fs, "fragment");
    if (r.ok) {
      const p = gl.createProgram();
      gl.attachShader(p, v);
      gl.attachShader(p, f);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        r.ok = false;
        r.errors.push(`link: ${(gl.getProgramInfoLog(p) || "").trim() || "(no info log)"}`);
      } else {
        for (const u of uniforms) if (gl.getUniformLocation(p, u) === null) r.missing.push(u);
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
          const info = gl.getActiveUniform(p, i);
          if (!info) continue;
          const base = info.name.replace(/\[0\]$/, "");
          if (!uniforms.includes(base)) r.unlisted.push(base);
        }
      }
      gl.deleteProgram(p);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    results.push(r);
  }
  return { renderer, results };
}

async function run(extra) {
  const browser = await launch(extra);
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    return await page.evaluate(compileAll, TOY_PROGRAMS);
  } finally {
    await browser.close();
  }
}

let outcome = null;
let lastErr = null;
// Two attempts: the default GPU path, then software ANGLE in case the headless GPU process has no WebGL2.
for (const extra of [[], ["--use-gl=angle", "--use-angle=swiftshader"]]) {
  try {
    outcome = await run(extra);
    if (outcome.renderer) break;
    console.log(`WARN  webgl2 context unavailable${extra.length ? ` with ${extra.join(" ")}` : ""}; retrying`);
  } catch (err) {
    lastErr = err;
    console.log(`WARN  browser launch failed: ${err?.message?.split("\n")[0] ?? err}`);
  }
}

if (!outcome || !outcome.renderer) {
  console.error("FAIL  could not get a WebGL2 context in a headless browser; the shaders were not compiled.");
  if (lastErr) console.error(String(lastErr?.message ?? lastErr));
  process.exit(2);
}

console.log(`renderer: ${outcome.renderer}`);
let failed = 0;
for (const r of outcome.results) {
  const prog = TOY_PROGRAMS[r.name];
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${prog.uniforms.length} uniforms)`);
  for (const e of r.errors) console.log(`      error: ${e.replace(/\n/g, "\n             ")}`);
  for (const w of r.warnings) console.log(`      note:  ${w.replace(/\n/g, "\n             ")}`);
  for (const u of r.missing) console.log(`      warn:  uniform ${u} has no location (unused in the shader, optimised out)`);
  for (const u of r.unlisted) console.log(`      warn:  active uniform ${u} is not in TOY_PROGRAMS.${r.name}.uniforms (the renderer never sets it)`);
  if (!r.ok) failed++;
}
console.log(`\n${outcome.results.length - failed}/${outcome.results.length} programs compile and link`);
process.exit(failed ? 1 : 0);
