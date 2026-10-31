/** Fullscreen triangle; vUv has its origin at the top-left like screen pixels. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const NOISE = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v / 0.875;
}`;

/**
 * Background: the camera, cover-fitted and mirrored. With a full-screen transform the
 * AI output replaces it (it already arrives mirrored, in display orientation).
 */
export const BACKGROUND_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec4 uStage;      // stage rect in px: offset.xy, size.zw
uniform sampler2D uCam;
uniform sampler2D uAlt;
uniform float uHasCam;
uniform float uMirror;
uniform float uAlt01;     // 1 = draw the AI output instead of the camera
uniform float uTime;
${NOISE}
void main() {
  vec2 p = vUv * uRes;
  vec2 st = (p - uStage.xy) / uStage.zw;
  vec3 cam = texture(uCam, vec2(mix(st.x, 1.0 - st.x, uMirror), st.y)).rgb;
  vec3 alt = texture(uAlt, st).rgb;
  // No camera (simulated hands): a quiet void so the portal still reads.
  vec2 q = vUv - 0.5;
  vec3 voidCol = vec3(0.016, 0.019, 0.032) + vec3(0.02, 0.03, 0.06) * (1.0 - dot(q, q) * 2.2);
  voidCol += 0.012 * vnoise(p * 0.004 + uTime * 0.05);
  vec3 c = mix(voidCol, cam, uHasCam);
  outColor = vec4(mix(c, alt, uAlt01), 1.0);
}`;

export const PORTAL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2 uRes;
uniform sampler2D uContent;
uniform mat3 uHinv;        // screen px -> content uv (homogeneous)
uniform float uSign;       // sign of w inside the portal
uniform vec2 uQ[4];        // corners, px, P1..P4
uniform vec2 uCenter;
uniform float uSize;       // sqrt(area), px
uniform vec4 uCrop;        // uv * xy + zw
uniform vec4 uStage;       // for window mode
uniform float uWindow;     // 1 = aligned window, 0 = projected texture
uniform float uContentMirror;
uniform float uTime;
uniform float uReveal;
uniform float uGlow;
uniform float uEnergy;
uniform float uLocked;
uniform float uWarn;
uniform float uReady;
uniform float uDpr;
uniform vec3 uBlue;
uniform vec3 uViolet;
${NOISE}

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
}

void main() {
  vec2 p = vUv * uRes;
  float sd = sdQuad(p);
  vec2 rel = p - uCenter;
  float ang = atan(rel.y, rel.x);
  vec2 dir = rel / max(length(rel), 1e-3);
  float glowW = max(6.0 * uDpr, uSize * 0.055) * (0.55 + 0.45 * uGlow);
  float flick = mix(1.0, 0.25, uLocked);
  float r = sd / glowW;
  // Noise is sampled on a (slowly turning) unit circle, not on the angle, so there is
  // no seam where atan() wraps; scaling with r makes the energy flow outward.
  float spin = uTime * 0.11 * flick;
  vec2 cd = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * dir;
  float n = fbm(cd * (2.3 + 0.5 * r) + vec2(0.0, -uTime * 0.9 * flick));
  float n2 = fbm(cd * (5.2 + 1.1 * r) + vec2(uTime * 0.7 * flick, 0.0) + 7.3);
  vec3 energy = mix(uBlue, uViolet, 0.5 + 0.5 * sin(ang * 2.0 + uTime * 0.7));
  energy = mix(energy, vec3(0.62, 0.52, 0.95), uWarn * (0.6 + 0.4 * sin(uTime * 9.0)));

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  float cover = clamp(0.5 - sd / uDpr, 0.0, 1.0);
  if (cover > 0.0) {
    vec3 h = uHinv * vec3(p, 1.0);
    if (h.z * uSign > 0.0) {
      vec2 uv = h.xy / h.z;
      float depth = clamp(-sd / (uSize * 0.2), 0.0, 1.0);
      float edge = 1.0 - depth;
      vec2 cuv = uv - 0.5;
      vec2 udir = cuv / max(length(cuv), 1e-4);
      // Refraction near the rim: the boundary between realities is unstable.
      uv += udir * (n - 0.5) * uEnergy * edge * edge * 0.05;
      vec2 tuv = mix(uv * uCrop.xy + uCrop.zw, (p - uStage.xy) / uStage.zw, uWindow);
      tuv.x = mix(tuv.x, 1.0 - tuv.x, uContentMirror);
      float ca = edge * edge * 0.006 * uEnergy;
      vec3 c;
      c.r = texture(uContent, tuv + udir * ca).r;
      c.g = texture(uContent, tuv).g;
      c.b = texture(uContent, tuv - udir * ca).b;
      vec3 voidCol = vec3(0.012, 0.016, 0.04) + energy * (0.08 + 0.18 * n * n);
      c = mix(voidCol, c, uReady);
      c *= mix(0.5, 1.0, smoothstep(0.0, 0.4, depth));          // depth falloff into the frame
      c += energy * pow(edge, 7.0) * 0.6 * uGlow;                // inner rim light
      col = c * cover;
      alpha = cover;
    }
  }

  // Distance from the rim: glow spreads outward, and only a thin band inward so the
  // content stays clear.
  float rim = sd >= 0.0 ? sd : -sd * 3.5;
  float halo = exp(-rim / glowW) * (0.35 + 0.65 * n);
  float filaments = pow(n2, 3.2) * exp(-rim / (glowW * 2.4)) * 2.4 * uEnergy * flick;
  float line = exp(-abs(sd) / (1.1 * uDpr));
  vec3 lineCol = mix(energy, vec3(1.0), 0.55 + 0.35 * uLocked);
  vec3 glow = energy * (halo * 0.5 + filaments) * uGlow + lineCol * line * (0.7 + 0.3 * uLocked);

  outColor = vec4((col + glow) * uReveal, alpha * uReveal);
}`;

export const PARTICLE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aPos;   // x, y (px), size (px), life 0..1
layout(location = 1) in float aHue;
uniform vec2 uRes;
out float vLife;
out float vHue;
void main() {
  vLife = aPos.w;
  vHue = aHue;
  vec2 clip = (aPos.xy / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = aPos.z * (0.35 + 0.65 * sin(3.14159 * aPos.w));
}`;

export const PARTICLE_FS = /* glsl */ `#version 300 es
precision mediump float;
in float vLife;
in float vHue;
out vec4 outColor;
uniform vec3 uBlue;
uniform vec3 uViolet;
uniform float uAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  float core = smoothstep(0.35, 0.0, r);
  vec3 col = mix(uBlue, uViolet, vHue) * a + vec3(1.0) * core * 0.6;
  float fade = sin(3.14159 * vLife);
  outColor = vec4(col * fade * uAlpha, 0.0);
}`;

/**
 * Local preview: a stylisation of the camera computed on this machine. It is not
 * AI output and carries a burnt-in label saying so.
 */
export const STYLIZE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCam;
uniform sampler2D uLabel;
uniform vec2 uTexel;
uniform vec4 uLabelRect;   // uv rect: x, y, w, h
uniform float uMirror;
uniform float uTime;
uniform float uHasCam;
uniform vec3 uBlue;
uniform vec3 uViolet;
${NOISE}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float L(vec2 uv) { return luma(texture(uCam, uv).rgb); }
void main() {
  // Offscreen target: row 0 is the bottom of clip space, so flip to image coordinates.
  vec2 vt = vec2(vUv.x, 1.0 - vUv.y);
  vec2 uv = vec2(mix(vt.x, 1.0 - vt.x, uMirror), vt.y);
  vec3 c = texture(uCam, uv).rgb;
  vec2 t = uTexel * 1.5;
  float gx = L(uv + vec2(t.x, -t.y)) + 2.0 * L(uv + vec2(t.x, 0.0)) + L(uv + t)
           - L(uv - t) - 2.0 * L(uv - vec2(t.x, 0.0)) - L(uv + vec2(-t.x, t.y));
  float gy = L(uv + vec2(-t.x, t.y)) + 2.0 * L(uv + vec2(0.0, t.y)) + L(uv + t)
           - L(uv - t) - 2.0 * L(uv - vec2(0.0, t.y)) - L(uv + vec2(t.x, -t.y));
  float e = clamp(length(vec2(gx, gy)) * 1.6, 0.0, 1.0);
  float l = luma(c);
  float bands = floor(l * 4.0 + 0.5) / 4.0;
  float tone = mix(l, bands, 0.7);
  vec3 base = mix(vec3(0.02, 0.025, 0.07), vec3(0.78, 0.9, 1.0), smoothstep(0.05, 0.95, tone));
  base = mix(base, c * vec3(0.7, 0.86, 1.15), 0.22);
  base *= 1.0 - smoothstep(0.3, 0.75, e) * 0.85;                 // ink lines
  base += uBlue * smoothstep(0.45, 1.0, e) * 0.9;                // glowing contours
  float n = fbm(vec2(vt.x * 4.0, vt.y * 3.0 + uTime * 0.6));
  base += mix(uBlue, uViolet, vt.y) * pow(n, 5.0) * 1.4;        // drifting energy
  base = mix(vec3(0.02, 0.025, 0.05) + uBlue * 0.12 * n, base, uHasCam);

  vec2 lp = (vt - uLabelRect.xy) / uLabelRect.zw;
  if (lp.x >= 0.0 && lp.y >= 0.0 && lp.x <= 1.0 && lp.y <= 1.0) {
    vec4 lab = texture(uLabel, lp);
    base = mix(base, lab.rgb, lab.a);
  }
  outColor = vec4(base, 1.0);
}`;

export const TESTCARD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCard;
uniform float uTime;
uniform vec3 uBlue;
void main() {
  vec2 vt = vec2(vUv.x, 1.0 - vUv.y);
  vec3 c = texture(uCard, vt).rgb;
  float sweep = exp(-abs(vt.x - fract(uTime * 0.25)) * 140.0);
  float ring = exp(-abs(length((vt - 0.5) * vec2(16.0 / 9.0, 1.0)) - fract(uTime * 0.5) * 0.9) * 90.0);
  outColor = vec4(c + uBlue * (sweep * 0.9 + ring * 0.5), 1.0);
}`;
