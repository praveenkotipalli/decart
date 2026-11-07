/**
 * GLSL of the hand-frame toy's WebGL2 passes, and the table of programs built from it.
 *
 * Coordinate conventions (the same in every shader here):
 *  - On screen, `vUv` from FULLSCREEN_VS has a TOP-LEFT origin, so `p = vUv * uRes` is canvas
 *    device px with y down: the space the frame corners and loupe centres are passed in.
 *    The stage is a px rectangle on the canvas (`uStage`: x, y, w, h) and stage uv is
 *    `st = (p - uStage.xy) / uStage.zw`. The stage is never assumed to be the whole canvas.
 *  - Video textures (camera, AI) keep the top row of the picture at v = 0, so
 *    `texture(uCam, st)` reads stage position `st` (x flipped when uCamMirror is 1).
 *    The AI picture arrives in display orientation and is never flipped.
 *  - Offscreen targets (paint, wipe mask, fog blur, plate) are all in stage-uv space with
 *    v = 0 at the TOP of the stage. A pass that writes into a target takes
 *    `vt = vec2(vUv.x, 1.0 - vUv.y)` as the stage uv of the texel it is writing (row 0 of a
 *    target is the bottom of clip space, where vUv.y is 1), and every target is later read
 *    with a plain `texture(uTarget, st)`. This is the convention STYLIZE_FS already uses.
 *  - "Frame heights" are the isotropic unit: stage y, or stage x multiplied by `uAspect`
 *    (stage width / height).
 *
 * Every program and the exact uniform names the renderer looks up are listed once, in
 * TOY_PROGRAMS. ToyRenderer, scripts/check-shaders.mjs and the tests all read that table.
 */
import { FULLSCREEN_VS, PARTICLE_FS, PARTICLE_VS } from "./shaders";

/**
 * What is shown inside the frame and the loupes: the scene (camera, or the remembered
 * empty-room plate), optionally replaced by the AI picture where it has pixels, then an
 * optional luminance ramp. `treat(st)` returns it for one stage position, including the
 * tile transition between two treatments.
 */
export const TREATMENT = /* glsl */ `
uniform sampler2D uCam, uAi, uPlate, uRamp;
uniform float uCamMirror;   // 1 = flip the scene texture in x (live camera, mirror on)
uniform float uPlateMix;    // 1 = vanish with a plate
uniform float uRampRows, uAspect;
uniform vec4  uAiRect;      // stage-uv rect covered by the AI frame, display orientation: x, y, w, h
uniform vec2  uAnime;       // AI mix: from, to
uniform vec2  uRow;         // LUT row: from, to; < 0 = no filter
uniform float uProg, uSeed, uTiles;   // progress 0..1 (1 = idle), per-change seed, 1 = tiles / 0 = cross-fade
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 ramp(vec3 c, float row) {
  if (row < 0.0) return c;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  return texture(uRamp, vec2(l * (255.0 / 256.0) + 0.5 / 256.0, (row + 0.5) / uRampRows)).rgb;
}
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float cs = cos(a), sn = sin(a);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}
vec3 treat(vec2 st) {
  st = clamp(st, 0.0, 1.0);
  vec3 base = texture(uCam, vec2(mix(st.x, 1.0 - st.x, uCamMirror), st.y)).rgb;
  // The plate is a stage-uv target: read as it is (no fetch at all outside vanish).
  if (uPlateMix > 0.0) base = mix(base, texture(uPlate, st).rgb, uPlateMix);
  vec2 a = (st - uAiRect.xy) / uAiRect.zw;
  float inAi = step(0.0, a.x) * step(a.x, 1.0) * step(0.0, a.y) * step(a.y, 1.0);
  vec3 ai = (uAnime.x + uAnime.y > 0.0) ? texture(uAi, a).rgb : base;   // AI arrives in display orientation: never flipped
  vec3 to = ramp(mix(base, ai, uAnime.y * inAi), uRow.y);
  if (uProg >= 1.0) return to;
  vec3 from = ramp(mix(base, ai, uAnime.x * inAi), uRow.x);
  if (uTiles < 0.5) return mix(from, to, smoothstep(0.0, 1.0, uProg));
  vec2 sp = st * vec2(720.0 * uAspect, 720.0);              // tile sizes are resolution independent
  vec2 cell = vec2(72.0, 54.0);
  vec2 g = floor(sp / cell);
  float h1 = h21(g + uSeed);
  vec2 sub = floor(fract(sp / cell) * vec2(1.0 + floor(h1 * 3.0), 1.0 + floor(fract(h1 * 7.31) * 2.0)));
  float h = h21(g * 7.0 + sub + uSeed * 1.7);
  float e = uProg * 1.3 - 0.15 - h;                          // > 0: this tile has switched
  vec3 c = mix(from, to, step(0.0, e));
  float flash = step(0.0, e) * (1.0 - smoothstep(0.06, 0.16, e)) * step(0.62, fract(h * 13.7));
  return mix(c, hueRot(to, -1.9), flash * 0.85);
}`;

/** Verbatim copy of the even-odd polygon SDF in PORTAL_FS (shaders.ts): a bow-tie fills both lobes. */
const SD_QUAD = /* glsl */ `
// Exact signed distance to the quad (Inigo Quilez's polygon SDF); negative inside.
float sdQuad(vec2 p) {
  float d = dot(p - uQ[0], p - uQ[0]);
  float s = 1.0;
  for (int i = 0, j = 3; i < 4; j = i, i++) {
    vec2 e = uQ[j] - uQ[i];
    vec2 w = p - uQ[i];
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= uQ[i].y, p.y < uQ[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s *= -1.0;
  }
  return s * sqrt(d);
}`;

/**
 * The hand frame, up to two loupes, the corner brackets and the loupe rings, in one
 * scissored pass. Output is premultiplied: blend with (ONE, ONE_MINUS_SRC_ALPHA).
 *
 * Differences from the listing in the design, all in main():
 *  - the brackets and rings are composited OVER the content instead of sharing one alpha,
 *    so the anti-aliased outer half of a bracket is ice white on the camera rather than a
 *    one-pixel fringe of filtered picture;
 *  - a loupe moves the sample position by its coverage instead of switching it, so the lens
 *    eases in and out with its fade and its rim meets the frame content without a step;
 *  - nothing is sampled where there is no content.
 */
export const FRAME_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform float uDpr;
uniform vec4 uStage;           // stage rect on the canvas, px: x, y, w, h
uniform vec2 uQ[4];            // px: A index, B index, B thumb, A thumb
uniform float uQuadVis;        // eased 0..1
uniform float uArm;            // bracket arm as a fraction of its edge: 0..1/6 (0.5 = locked, full outline)
uniform vec4 uLoupe[2];        // cx, cy, radius (px), zoom
uniform float uLoupeVis[2];
${TREATMENT}
${SD_QUAD}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
}
void main() {
  vec2 p = vUv * uRes;
  vec2 sp = p;                 // where the content is sampled: p, or a magnified position under a loupe
  float m = 0.0;               // content coverage
  float line = 0.0;            // bracket / ring coverage
  if (uQuadVis > 0.0) {
    m = clamp(0.5 - sdQuad(p) / uDpr, 0.0, 1.0) * uQuadVis;              // hard edge, 1 px anti-aliasing
    for (int i = 0; i < 4; i++) {                                         // corner brackets along each polygon edge
      vec2 a = uQ[i], b = uQ[(i + 1) & 3], arm = (b - a) * uArm;
      float d = min(sdSeg(p, a, a + arm), sdSeg(p, b - arm, b));
      line = max(line, (1.0 - smoothstep(uDpr * 0.5, uDpr * 1.5, d)) * uQuadVis);   // 2 CSS px
    }
  }
  for (int i = 0; i < 2; i++) {                                           // loupes draw over the frame
    if (uLoupeVis[i] <= 0.0) continue;
    vec2 rel = p - uLoupe[i].xy;
    float d = length(rel) - uLoupe[i].z;
    float ml = clamp(0.5 - d / uDpr, 0.0, 1.0) * uLoupeVis[i];
    sp = mix(sp, uLoupe[i].xy + rel / uLoupe[i].w, ml);
    m = max(m, ml);
    line = max(line, (1.0 - smoothstep(uDpr * 0.25, uDpr * 1.25, abs(d))) * uLoupeVis[i]);   // 1.5 px ring
  }
  float la = line * 0.96;
  float alpha = la + m * (1.0 - la);
  if (alpha <= 0.0) discard;
  vec3 col = vec3(0.0);
  if (m > 0.0) col = treat((sp - uStage.xy) / uStage.zw) * m;
  outColor = vec4(col * (1.0 - la) + vec3(0.957, 0.973, 1.0) * la, alpha);   // premultiplied
}`;

/**
 * One capsule (a segment with a radius) written into an offscreen target, premultiplied.
 * Ink and the fog wipe mask are both built from these; the renderer blends them with MAX,
 * so overlapping stamps never accumulate along a stroke.
 */
export const STAMP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uA;          // segment start, stage uv
uniform vec2 uB;          // segment end, stage uv
uniform float uR;         // radius, frame heights
uniform float uAspect;    // stage width / height
uniform float uSoft;      // width of the edge falloff, frame heights (at least one target texel)
uniform vec4 uColor;      // straight alpha
void main() {
  vec2 vt = vec2(vUv.x, 1.0 - vUv.y);                        // the stage uv this texel holds
  vec2 k = vec2(uAspect, 1.0);
  vec2 pa = (vt - uA) * k;
  vec2 ba = (uB - uA) * k;
  float d = length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0)) - uR;
  float a = uColor.a * clamp(0.5 - d / uSoft, 0.0, 1.0);
  outColor = vec4(uColor.rgb * a, a);
}`;

/** A constant. Drawn with blendEquation(FUNC_REVERSE_SUBTRACT) it lowers the wipe mask: the glass mists over again. */
export const DECAY_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform float uAmount;    // taken off every channel
void main() {
  outColor = vec4(uAmount);
}`;

/** Four bilinear taps around the texel centre: one step of the fog blur chain. */
export const DOWNSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTap;        // tap offset, source uv
uniform float uMirror;    // 1 = read the source flipped in x (the mirrored camera)
void main() {
  vec2 vt = vec2(vUv.x, 1.0 - vUv.y);
  vec2 uv = vec2(mix(vt.x, 1.0 - vt.x, uMirror), vt.y);
  vec3 c = texture(uSrc, uv - uTap).rgb + texture(uSrc, uv + vec2(uTap.x, -uTap.y)).rgb
         + texture(uSrc, uv + vec2(-uTap.x, uTap.y)).rgb + texture(uSrc, uv + uTap).rgb;
  outColor = vec4(c * 0.25, 1.0);
}`;

/**
 * Fogged glass over the whole canvas: a blurred, lifted, blue-grey copy of the scene with
 * fine grain, and the sharp camera wherever the wipe mask says the glass was wiped.
 * It replaces the background pass, so it is opaque.
 */
export const FOG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform float uDpr;
uniform vec4 uStage;
uniform sampler2D uCam;
uniform sampler2D uBlur;      // small blurred copy of the scene, stage-uv space
uniform sampler2D uMask;      // wipe mask, stage-uv space: alpha 1 = wiped clear
uniform float uCamMirror;
uniform vec2 uBlurTexel;      // 1 / size of uBlur
uniform float uDensity;       // overall fog amount 0..1
// Integer-lattice hash without visible repetition at pixel coordinates.
float grain(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 p = vUv * uRes;
  vec2 st = (p - uStage.xy) / uStage.zw;
  vec3 col = texture(uCam, vec2(mix(st.x, 1.0 - st.x, uCamMirror), st.y)).rgb;
  float f = uDensity * (1.0 - smoothstep(0.08, 0.62, texture(uMask, st).a));
  if (f > 0.0) {
    // Four half-texel taps rebuild the small blur without the diamond pattern of a single bilinear fetch.
    vec2 o = uBlurTexel * 0.5;
    vec3 blur = 0.25 * (texture(uBlur, st - o).rgb + texture(uBlur, st + vec2(o.x, -o.y)).rgb
                      + texture(uBlur, st + vec2(-o.x, o.y)).rgb + texture(uBlur, st + o).rgb);
    vec3 mist = mix(blur, vec3(0.74, 0.80, 0.93), 0.35);
    mist += (grain(floor(p / uDpr)) - 0.5) * 0.045;
    col = mix(col, mist, f);
  }
  outColor = vec4(col, 1.0);
}`;

/** The paint layer over the camera. The layer is premultiplied: blend with (ONE, ONE_MINUS_SRC_ALPHA). */
export const INK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec4 uStage;
uniform sampler2D uPaint;     // premultiplied ink, stage-uv space
void main() {
  vec2 st = (vUv * uRes - uStage.xy) / uStage.zw;
  outColor = texture(uPaint, st);
}`;

/** The scene in display orientation, written into the plate target with a constant alpha. */
export const PLATE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCam;
uniform float uCamMirror;
uniform float uAlpha;         // 1 = replace the plate; less = fold this frame into the running average
void main() {
  vec2 vt = vec2(vUv.x, 1.0 - vUv.y);
  outColor = vec4(texture(uCam, vec2(mix(vt.x, 1.0 - vt.x, uCamMirror), vt.y)).rgb, uAlpha);
}`;

/** Debug: the AI picture at 50% over the stage, to check its registration. Premultiplied. */
export const ONION_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec4 uStage;
uniform sampler2D uAi;
uniform vec4 uAiRect;         // stage-uv rect covered by the AI frame
void main() {
  vec2 st = (vUv * uRes - uStage.xy) / uStage.zw;
  vec2 a = (st - uAiRect.xy) / uAiRect.zw;
  float inAi = step(0.0, a.x) * step(a.x, 1.0) * step(0.0, a.y) * step(a.y, 1.0);
  outColor = vec4(texture(uAi, a).rgb, 1.0) * (0.5 * inAi);
}`;

const TREATMENT_UNIFORMS = [
  "uCam", "uAi", "uPlate", "uRamp", "uCamMirror", "uPlateMix", "uRampRows", "uAspect",
  "uAiRect", "uAnime", "uRow", "uProg", "uSeed", "uTiles",
] as const;

/** The uniform names of each program, as literal types: a misspelt name in the renderer does not compile. */
const UNIFORMS = {
  frame: ["uRes", "uDpr", "uStage", "uQ", "uQuadVis", "uArm", "uLoupe", "uLoupeVis", ...TREATMENT_UNIFORMS],
  stamp: ["uA", "uB", "uR", "uAspect", "uSoft", "uColor"],
  decay: ["uAmount"],
  downsample: ["uSrc", "uTap", "uMirror"],
  fog: ["uRes", "uDpr", "uStage", "uCam", "uBlur", "uMask", "uCamMirror", "uBlurTexel", "uDensity"],
  ink: ["uRes", "uStage", "uPaint"],
  plate: ["uCam", "uCamMirror", "uAlpha"],
  onion: ["uRes", "uStage", "uAi", "uAiRect"],
  sparks: ["uRes", "uBlue", "uViolet", "uAlpha"],
} as const;

export type ToyProgramName = keyof typeof UNIFORMS;
export type ToyUniformName<N extends ToyProgramName> = (typeof UNIFORMS)[N][number];

export interface ToyProgramSource {
  vs: string;
  fs: string;
  uniforms: string[];
}

/** Every program of the toy. `sparks` reuses the existing point shaders with its own program. */
export const TOY_PROGRAMS: Record<ToyProgramName, ToyProgramSource> = {
  frame: { vs: FULLSCREEN_VS, fs: FRAME_FS, uniforms: [...UNIFORMS.frame] },
  stamp: { vs: FULLSCREEN_VS, fs: STAMP_FS, uniforms: [...UNIFORMS.stamp] },
  decay: { vs: FULLSCREEN_VS, fs: DECAY_FS, uniforms: [...UNIFORMS.decay] },
  downsample: { vs: FULLSCREEN_VS, fs: DOWNSAMPLE_FS, uniforms: [...UNIFORMS.downsample] },
  fog: { vs: FULLSCREEN_VS, fs: FOG_FS, uniforms: [...UNIFORMS.fog] },
  ink: { vs: FULLSCREEN_VS, fs: INK_FS, uniforms: [...UNIFORMS.ink] },
  plate: { vs: FULLSCREEN_VS, fs: PLATE_FS, uniforms: [...UNIFORMS.plate] },
  onion: { vs: FULLSCREEN_VS, fs: ONION_FS, uniforms: [...UNIFORMS.onion] },
  sparks: { vs: PARTICLE_VS, fs: PARTICLE_FS, uniforms: [...UNIFORMS.sparks] },
};
