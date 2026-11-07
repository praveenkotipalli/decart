/**
 * The WebGL2 passes of the hand-frame toy. The Renderer owns the canvas, the camera and
 * AI textures and the background pass; this class adds what the toy draws:
 *
 *  - `prepare` does the offscreen work: ink and fog-wipe stamps, the fog's blurred copy of
 *    the scene, the mist creeping back over wiped glass, and the empty-room plate.
 *  - `draw` does the on-screen work for the scene's effect, over the background the caller
 *    has already drawn (fog covers the stage itself: see `needsBackground`).
 *
 * Conventions (see toyShaders.ts): stage space is [0,1]² with y down; the stage is the px
 * rectangle `env.stage` on the canvas; every offscreen target is in stage-uv space and is
 * read with a plain texture(target, st).
 *
 * GL state contract, both ways: on entry the default framebuffer is bound, the viewport
 * is the full canvas, BLEND and SCISSOR_TEST are off and the full-screen VAO is bound;
 * `prepare` and `draw` hand the context back in exactly that state.
 */
import type { Quad } from "../geometry/vec";
import { buildLut, LUT_ROWS, LUT_WIDTH } from "../toy/filters";
import { quadBounds } from "../toy/frameMath";
import { StampBuffer, type EffectId, type Rect, type ToyScene } from "../toy/types";
import { createProgram, createRenderTarget, createTexture, type RenderTarget } from "./gl";
import { TOY_PROGRAMS, type ToyProgramName, type ToyUniformName } from "./toyShaders";

export interface ToyRenderEnv {
  /** Drawing-buffer px. */
  width: number;
  height: number;
  dpr: number;
  /** Px rect of the stage on the canvas. */
  stage: { x: number; y: number; w: number; h: number };
  /** The scene texture: the live camera, or the simulated scene picture. */
  camera: WebGLTexture;
  /** Sample `camera` flipped in x. */
  cameraMirror: boolean;
  cameraSize: { w: number; h: number };
  /** A new camera frame was uploaded this tick. */
  newCameraFrame: boolean;
  /** Latest AI frame (display orientation). */
  ai: WebGLTexture;
  /** Stage-uv rect covered by the AI frame. */
  aiRect: Rect;
  /** Debug: draw the AI frame at 50% over the whole stage. */
  onion: boolean;
}

/** Numbers of the GL passes. Sizes are for a 16:9 camera; other shapes keep the height and scale the width. */
export const TOY_GL = {
  /** The paint layer is the stage at up to this size. */
  paintMaxW: 1280,
  paintMaxH: 720,
  /** The plate is the camera frame, scaled down only when it is larger than this. */
  plateMaxW: 1280,
  plateMaxH: 720,
  /** Height of the fog wipe mask (640 × 360 at 16:9). */
  maskH: 360,
  /** Heights of the fog blur chain (320 × 180 → 160 × 90 → 80 × 45 at 16:9). */
  blurH: [180, 90, 45],
  /** Each due decay step takes this much off the wipe mask. */
  decayStep: 4 / 255,
  /** Weight of a new camera frame folded into the plate. */
  plateBlend: 0.25,
  /** Edge falloff of a fog wipe as a fraction of its radius: the glass mists over from the edge of a wipe inward. */
  wipeFeather: 0.35,
  /** Below this visibility the frame and the loupes are not drawn at all. */
  minVisibility: 0.002,
  /** Brightness of the sparks. */
  sparkAlpha: 1,
  /** Sparks the point buffer holds before it has to grow. */
  sparkCapacity: 640,
} as const;

/** Ice white, blue and violet of the existing point shaders. */
const BLUE = [0.29, 0.62, 1.0] as const;
const VIOLET = [0.55, 0.38, 1.0] as const;
const SPARK_STRIDE = 5;
/** Decay steps that empty a fully wiped mask; after that many, decaying is a no-op and is skipped. */
const MASK_FULL_STEPS = Math.ceil(1 / TOY_GL.decayStep);

/** Which programs an effect needs, so they are compiled when the effect is selected and not at the first gesture. */
const EFFECT_PROGRAMS: Record<EffectId, readonly ToyProgramName[]> = {
  frame: ["frame"],
  vanish: ["frame", "plate"],
  draw: ["stamp", "ink"],
  particles: ["sparks"],
  fog: ["downsample", "stamp", "decay", "fog"],
};

export interface PxBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Width / height, or 16:9 when the size is not usable yet; kept within sane limits so target sizes stay bounded. */
export function safeAspect(w: number, h: number): number {
  const a = w / h;
  return Number.isFinite(a) && a > 0 ? Math.min(4, Math.max(0.25, a)) : 16 / 9;
}

/** The largest whole-pixel size of the given aspect that fits inside maxW × maxH. */
export function fitSize(aspect: number, maxW: number, maxH: number): { w: number; h: number } {
  if (aspect >= maxW / maxH) return { w: maxW, h: Math.max(1, Math.round(maxW / aspect)) };
  return { w: Math.max(1, Math.round(maxH * aspect)), h: maxH };
}

/**
 * A box in px with y down (a canvas, or a stage-uv target) as gl.scissor arguments,
 * clipped to the surface; null when nothing of it is on the surface. The canvas has its
 * scissor origin at the bottom-left (`flipY`); a stage-uv target does not need the flip,
 * because its row 0 is the top of the stage.
 */
export function scissorBox(b: PxBounds, width: number, height: number, flipY: boolean): { x: number; y: number; w: number; h: number } | null {
  const x0 = Math.max(0, Math.floor(b.x0));
  const x1 = Math.min(width, Math.ceil(b.x1));
  const top = Math.max(0, Math.floor(b.y0));
  const bottom = Math.min(height, Math.ceil(b.y1));
  if (!(x1 > x0) || !(bottom > top)) return null;
  return { x: x0, y: flipY ? height - bottom : top, w: x1 - x0, h: bottom - top };
}

/**
 * Canvas-px bounds (y down) of everything the frame pass draws: the quad and the visible
 * loupes, grown by the bracket and ring thickness. Null when nothing is visible.
 */
export function frameBounds(scene: ToyScene, stage: { x: number; y: number; w: number; h: number }, dpr: number): PxBounds | null {
  // Brackets reach 1.5 CSS px outside the polygon; the rest is slack for rounding.
  const pad = Math.ceil(2 * dpr) + 2;
  let out: PxBounds | null = null;
  const grow = (b: PxBounds) => {
    out = out ? { x0: Math.min(out.x0, b.x0), y0: Math.min(out.y0, b.y0), x1: Math.max(out.x1, b.x1), y1: Math.max(out.y1, b.y1) } : b;
  };
  const f = scene.frame;
  if (f && f.visibility > TOY_GL.minVisibility) {
    const px = f.quad.map((p) => ({ x: stage.x + p.x * stage.w, y: stage.y + p.y * stage.h })) as Quad;
    grow(quadBounds(px, pad));
  }
  let shown = 0;
  for (const l of scene.loupes) {
    if (shown === 2) break;
    if (!(l.visibility > TOY_GL.minVisibility) || !(l.radius > 0)) continue;
    shown++;
    const cx = stage.x + l.center.x * stage.w;
    const cy = stage.y + l.center.y * stage.h;
    const r = l.radius * stage.h + pad;
    grow({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r });
  }
  return out;
}

/**
 * The tile hash loses precision when its seed is large, so the transition's counter is
 * folded into a small range; consecutive seeds still land far apart.
 */
export function foldSeed(seed: number): number {
  const s = Number.isFinite(seed) ? seed : 0;
  const t = (s * 0.6180339887498949) % 1;
  return (t < 0 ? t + 1 : t) * 61;
}

type ToyProgram<N extends ToyProgramName> = {
  program: WebGLProgram;
  u: Record<ToyUniformName<N>, WebGLUniformLocation | null>;
};

export class ToyRenderer {
  private readonly gl: WebGL2RenderingContext;
  /** The caller's empty VAO for full-screen triangles; re-bound after the sparks. */
  private readonly vao: WebGLVertexArrayObject;
  /** Compiled programs; null = failed to compile, and its pass is skipped. */
  private readonly programs = new Map<ToyProgramName, { program: WebGLProgram } | null>();
  private warmed: EffectId | null = null;
  /** The filter lookup texture: one luminance ramp per row. */
  private readonly ramp: WebGLTexture;
  /** 1 × 1 transparent black: stands in for the wipe mask and the plate before they exist. */
  private readonly zero: WebGLTexture;

  private paint: RenderTarget | null = null;
  /** Stage-uv bounds of the ink on the paint layer; null = the layer is empty. */
  private inkBounds: PxBounds | null = null;

  private mask: RenderTarget | null = null;
  /** Upper bound of decay steps until the mask is empty again. */
  private maskSteps = 0;
  private blur: RenderTarget[] = [];
  private blurValid = false;
  private blurCamera: WebGLTexture | null = null;
  private blurMirror = false;

  private plate: RenderTarget | null = null;
  private plateValid = false;

  private sparkVao: WebGLVertexArrayObject | null = null;
  private sparkVbo: WebGLBuffer | null = null;
  private sparkData = new Float32Array(0);

  private readonly q8 = new Float32Array(8);
  private readonly loupe8 = new Float32Array(8);
  private readonly loupeVis2 = new Float32Array(2);
  private disposed = false;

  /** `vao` is the renderer's empty VAO used for full-screen triangles. */
  constructor(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject) {
    this.gl = gl;
    this.vao = vao;
    // createTexture gives LINEAR + CLAMP_TO_EDGE: the ramp is read between texel centres along x, never across rows.
    this.ramp = createTexture(gl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_WIDTH, LUT_ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut());
    this.zero = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  /** Offscreen passes only. */
  prepare(scene: ToyScene, env: ToyRenderEnv): void {
    if (this.disposed) return;
    this.warm(scene.effect, env.onion);
    const ink = this.prepareInk(scene, env);
    const fog = this.prepareFog(scene, env);
    const plate = this.preparePlate(scene, env);
    if (ink || fog || plate) this.restore(env);
  }

  /** False only when this renderer covers the whole stage itself (fog). */
  needsBackground(scene: ToyScene): boolean {
    return !this.coversStage(scene);
  }

  /** On-screen passes, drawn over the background the caller already drew. */
  draw(scene: ToyScene, env: ToyRenderEnv): void {
    if (this.disposed) return;
    let touched = false;
    switch (scene.effect) {
      case "fog":
        touched = this.drawFog(scene, env);
        break;
      case "frame":
      case "vanish":
        touched = this.drawFrame(scene, env);
        break;
      case "draw":
        touched = this.drawInk(env);
        break;
      case "particles":
        touched = this.drawSparks(scene, env);
        break;
    }
    if (env.onion) touched = this.drawOnion(env) || touched;
    if (touched) this.restore(env);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const p of this.programs.values()) if (p) gl.deleteProgram(p.program);
    this.programs.clear();
    for (const t of [this.paint, this.mask, this.plate, ...this.blur]) this.free(t);
    this.paint = this.mask = this.plate = null;
    this.blur = [];
    this.inkBounds = null;
    gl.deleteTexture(this.ramp);
    gl.deleteTexture(this.zero);
    if (this.sparkVbo) gl.deleteBuffer(this.sparkVbo);
    if (this.sparkVao) gl.deleteVertexArray(this.sparkVao);
    this.sparkVbo = this.sparkVao = null;
  }

  // ── Programs and targets ───────────────────────────────────────────────────

  /** Compiles on first use. A shader that fails is reported once and its pass is skipped: one bad program must not blank the picture. */
  private program<N extends ToyProgramName>(name: N): ToyProgram<N> | null {
    const cached = this.programs.get(name);
    if (cached !== undefined) return cached as ToyProgram<N> | null;
    let made: ToyProgram<N> | null = null;
    try {
      const src = TOY_PROGRAMS[name];
      made = createProgram(this.gl, src.vs, src.fs, src.uniforms) as ToyProgram<N>;
    } catch (err) {
      console.error(`[toy] the "${name}" shader is unavailable; its pass is skipped.`, err);
    }
    this.programs.set(name, made);
    return made;
  }

  private warm(effect: EffectId, onion: boolean) {
    if (this.warmed !== effect) {
      this.warmed = effect;
      for (const name of EFFECT_PROGRAMS[effect]) this.program(name);
    }
    if (onion) this.program("onion");
  }

  /** The target at the wanted size: the current one, or a new, empty one (its old content is gone). */
  private sized(current: RenderTarget | null, w: number, h: number): RenderTarget {
    if (current && current.width === w && current.height === h) return current;
    this.free(current);
    // A new texture reads as transparent black: no ink, a fully misted mask.
    return createRenderTarget(this.gl, w, h);
  }

  private free(t: RenderTarget | null) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  private bindTarget(t: RenderTarget) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fbo);
    this.gl.viewport(0, 0, t.width, t.height);
  }

  private clearTarget(t: RenderTarget) {
    const gl = this.gl;
    this.bindTarget(t);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private bindTexture(unit: number, tex: WebGLTexture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  /** Hands the context back in the state the caller guarantees on entry. */
  private restore(env: ToyRenderEnv) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, env.width, env.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
  }

  // ── Stamps (ink and fog wipes) ─────────────────────────────────────────────

  /**
   * Writes capsules into a stage-uv target, each scissored to its own box. They are blended
   * with MAX: along a stroke the stamps overlap every frame, and "over" would let each new
   * colour stamp paint out the white core of the one before it.
   * Returns the stage-uv bounds of what was written, or null.
   */
  private stamp(target: RenderTarget, stamps: StampBuffer, aspect: number, feather: number): PxBounds | null {
    const gl = this.gl;
    const prog = this.program("stamp");
    if (!prog) return null;
    const { u } = prog;
    this.bindTarget(target);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(prog.program);
    gl.uniform1f(u.uAspect, aspect);
    // One texel in frame heights, on the coarser axis: the narrowest edge that does not alias.
    const texel = Math.max(aspect / target.width, 1 / target.height);
    const d = stamps.data;
    const n = Math.min(stamps.count, Math.floor(d.length / StampBuffer.STRIDE));
    let bounds: PxBounds | null = null;
    for (let i = 0; i < n; i++) {
      const o = i * StampBuffer.STRIDE;
      const ax = d[o];
      const ay = d[o + 1];
      const bx = d[o + 2];
      const by = d[o + 3];
      const r = d[o + 4];
      if (!(r > 0) || !Number.isFinite(ax + ay + bx + by)) continue;
      const soft = Math.max(texel, r * feather);
      // Coverage ends half a falloff outside the radius; one texel more for the box rounding.
      const reach = r + soft * 0.5 + texel;
      const x0 = Math.min(ax, bx) - reach / aspect;
      const x1 = Math.max(ax, bx) + reach / aspect;
      const y0 = Math.min(ay, by) - reach;
      const y1 = Math.max(ay, by) + reach;
      const box = scissorBox({ x0: x0 * target.width, y0: y0 * target.height, x1: x1 * target.width, y1: y1 * target.height }, target.width, target.height, false);
      if (!box) continue;
      gl.scissor(box.x, box.y, box.w, box.h);
      gl.uniform2f(u.uA, ax, ay);
      gl.uniform2f(u.uB, bx, by);
      gl.uniform1f(u.uR, r);
      gl.uniform1f(u.uSoft, soft);
      gl.uniform4f(u.uColor, d[o + 5], d[o + 6], d[o + 7], d[o + 8]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const b: PxBounds = { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(1, x1), y1: Math.min(1, y1) };
      bounds = bounds ? { x0: Math.min(bounds.x0, b.x0), y0: Math.min(bounds.y0, b.y0), x1: Math.max(bounds.x1, b.x1), y1: Math.max(bounds.y1, b.y1) } : b;
    }
    return bounds;
  }

  // ── Draw: the paint layer ──────────────────────────────────────────────────

  private prepareInk(scene: ToyScene, env: ToyRenderEnv): boolean {
    const ink = scene.ink;
    if (!ink) return false; // Another effect is selected: the layer keeps what was drawn.
    let touched = false;
    if (ink.clear && this.paint && this.inkBounds) {
      this.clearTarget(this.paint);
      this.inkBounds = null;
      touched = true;
    }
    if (ink.stamps.count > 0) {
      // Sized from the camera's shape, not the canvas: resizing the window or hiding the chrome never erases a drawing.
      const size = fitSize(safeAspect(env.cameraSize.w, env.cameraSize.h), TOY_GL.paintMaxW, TOY_GL.paintMaxH);
      const target = this.sized(this.paint, size.w, size.h);
      if (target !== this.paint) {
        this.paint = target;
        this.inkBounds = null;
      }
      const b = this.stamp(target, ink.stamps, safeAspect(env.stage.w, env.stage.h), 0);
      if (b) {
        const cur: PxBounds | null = this.inkBounds;
        this.inkBounds = cur ? { x0: Math.min(cur.x0, b.x0), y0: Math.min(cur.y0, b.y0), x1: Math.max(cur.x1, b.x1), y1: Math.max(cur.y1, b.y1) } : b;
      }
      touched = true;
    }
    return touched;
  }

  private drawInk(env: ToyRenderEnv): boolean {
    const b = this.inkBounds;
    if (!this.paint || !b) return false;
    const prog = this.program("ink");
    if (!prog) return false;
    const { stage } = env;
    const box = scissorBox(
      { x0: stage.x + b.x0 * stage.w - 1, y0: stage.y + b.y0 * stage.h - 1, x1: stage.x + b.x1 * stage.w + 1, y1: stage.y + b.y1 * stage.h + 1 },
      env.width,
      env.height,
      true,
    );
    if (!box) return false;
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, box.y, box.w, box.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog.program);
    gl.uniform2f(prog.u.uRes, env.width, env.height);
    gl.uniform4f(prog.u.uStage, stage.x, stage.y, stage.w, stage.h);
    this.bindTexture(3, this.paint.tex);
    gl.uniform1i(prog.u.uPaint, 3);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  // ── Fog ────────────────────────────────────────────────────────────────────

  /** Fog covers the stage itself, but only if its shaders are there to do it. */
  private coversStage(scene: ToyScene): boolean {
    return !this.disposed && scene.effect === "fog" && scene.fog !== null && this.program("fog") !== null && this.program("downsample") !== null;
  }

  private prepareFog(scene: ToyScene, env: ToyRenderEnv): boolean {
    const fog = scene.fog;
    if (!fog) return false;
    const gl = this.gl;
    let touched = false;

    if (fog.reset && this.mask && this.maskSteps > 0) {
      this.clearTarget(this.mask);
      this.maskSteps = 0;
      touched = true;
    }
    if (fog.decaySteps > 0 && this.mask && this.maskSteps > 0) {
      const prog = this.program("decay");
      if (prog) {
        this.bindTarget(this.mask);
        gl.disable(gl.SCISSOR_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(prog.program);
        // Saturating subtraction: one draw of n steps equals n draws of one step.
        gl.uniform1f(prog.u.uAmount, Math.min(1, fog.decaySteps * TOY_GL.decayStep));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.maskSteps = Math.max(0, this.maskSteps - fog.decaySteps);
        touched = true;
      }
    }
    if (fog.stamps.count > 0) {
      const h = TOY_GL.maskH;
      const w = Math.max(1, Math.round(h * safeAspect(env.cameraSize.w, env.cameraSize.h)));
      const target = this.sized(this.mask, w, h);
      this.mask = target;
      if (this.stamp(target, fog.stamps, safeAspect(env.stage.w, env.stage.h), TOY_GL.wipeFeather)) this.maskSteps = MASK_FULL_STEPS;
      touched = true;
    }
    if (scene.effect === "fog" && fog.density > 0 && this.updateBlur(env)) touched = true;
    return touched;
  }

  /**
   * The blurred copy of the scene the mist is made of: three 4-tap steps down to 80 × 45.
   * Redone only when the scene texture has a new frame. Returns true when it drew.
   */
  private updateBlur(env: ToyRenderEnv): boolean {
    const prog = this.program("downsample");
    if (!prog) return false;
    const gl = this.gl;
    const aspect = safeAspect(env.cameraSize.w, env.cameraSize.h);
    let fresh = this.blurValid && this.blurCamera === env.camera && this.blurMirror === env.cameraMirror;
    for (let i = 0; i < TOY_GL.blurH.length; i++) {
      const h = TOY_GL.blurH[i];
      const target = this.sized(this.blur[i] ?? null, Math.max(1, Math.round(h * aspect)), h);
      if (target !== this.blur[i]) {
        this.blur[i] = target;
        fresh = false;
      }
    }
    if (fresh && !env.newCameraFrame) return false;

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.program);
    gl.uniform1i(prog.u.uSrc, 0);
    let src = env.camera;
    for (let i = 0; i < this.blur.length; i++) {
      const dst = this.blur[i];
      this.bindTarget(dst);
      this.bindTexture(0, src);
      // The first step covers each target texel's footprint exactly once (taps a quarter of a
      // texel out); the later ones reach twice as far, which is where most of the blur comes from.
      const k = i === 0 ? 0.25 : 0.5;
      gl.uniform2f(prog.u.uTap, k / dst.width, k / dst.height);
      gl.uniform1f(prog.u.uMirror, i === 0 && env.cameraMirror ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = dst.tex;
    }
    this.blurValid = true;
    this.blurCamera = env.camera;
    this.blurMirror = env.cameraMirror;
    return true;
  }

  private drawFog(scene: ToyScene, env: ToyRenderEnv): boolean {
    const fog = scene.fog;
    if (!fog || !this.coversStage(scene)) return false;
    const prog = this.program("fog");
    if (!prog) return false;
    const gl = this.gl;
    const density = clamp01(fog.density);
    // Normally prepare() has done this; a caller that skipped it still gets a valid picture.
    if (density > 0 && (!this.blurValid || this.blurCamera !== env.camera) && this.updateBlur(env)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
    }
    const blur = this.blurValid ? this.blur[this.blur.length - 1] : null;
    const { u } = prog;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog.program);
    gl.uniform2f(u.uRes, env.width, env.height);
    gl.uniform1f(u.uDpr, env.dpr > 0 ? env.dpr : 1);
    gl.uniform4f(u.uStage, env.stage.x, env.stage.y, env.stage.w, env.stage.h);
    gl.uniform1f(u.uCamMirror, env.cameraMirror ? 1 : 0);
    gl.uniform2f(u.uBlurTexel, blur ? 1 / blur.width : 0, blur ? 1 / blur.height : 0);
    gl.uniform1f(u.uDensity, blur ? density : 0);
    this.bindTexture(0, env.camera);
    gl.uniform1i(u.uCam, 0);
    this.bindTexture(1, blur ? blur.tex : this.zero);
    gl.uniform1i(u.uBlur, 1);
    this.bindTexture(3, this.mask ? this.mask.tex : this.zero);
    gl.uniform1i(u.uMask, 3);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  // ── Vanish: the empty-room plate ───────────────────────────────────────────

  private preparePlate(scene: ToyScene, env: ToyRenderEnv): boolean {
    const capture = scene.plate.capture;
    if (capture === "none") return false;
    const prog = this.program("plate");
    if (!prog) return false;
    const gl = this.gl;
    const cw = Math.max(1, Math.round(env.cameraSize.w));
    const ch = Math.max(1, Math.round(env.cameraSize.h));
    const fits = cw <= TOY_GL.plateMaxW && ch <= TOY_GL.plateMaxH;
    const size = fits ? { w: cw, h: ch } : fitSize(safeAspect(cw, ch), TOY_GL.plateMaxW, TOY_GL.plateMaxH);
    const target = this.sized(this.plate, size.w, size.h);
    if (target !== this.plate) {
      this.plate = target;
      this.plateValid = false;
    }
    // Averaging into a plate that holds nothing yet would average with black.
    const replace = capture === "replace" || !this.plateValid;
    this.bindTarget(target);
    gl.disable(gl.SCISSOR_TEST);
    if (replace) gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      // Colour: a running average. Alpha: left at 1.
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    }
    gl.useProgram(prog.program);
    this.bindTexture(0, env.camera);
    gl.uniform1i(prog.u.uCam, 0);
    gl.uniform1f(prog.u.uCamMirror, env.cameraMirror ? 1 : 0);
    gl.uniform1f(prog.u.uAlpha, replace ? 1 : TOY_GL.plateBlend);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.plateValid = true;
    return true;
  }

  // ── Frame and vanish: quad, loupes, brackets ───────────────────────────────

  private drawFrame(scene: ToyScene, env: ToyRenderEnv): boolean {
    const { stage } = env;
    const dpr = env.dpr > 0 ? env.dpr : 1;
    const bounds = frameBounds(scene, stage, dpr);
    if (!bounds) return false;
    const box = scissorBox(bounds, env.width, env.height, true);
    if (!box) return false;
    const prog = this.program("frame");
    if (!prog) return false;
    const gl = this.gl;
    const { u } = prog;

    const f = scene.frame;
    const quadVis = f && f.visibility > TOY_GL.minVisibility ? clamp01(f.visibility) : 0;
    const q = this.q8;
    q.fill(0);
    if (f && quadVis > 0) {
      for (let i = 0; i < 4; i++) {
        q[i * 2] = stage.x + f.quad[i].x * stage.w;
        q[i * 2 + 1] = stage.y + f.quad[i].y * stage.h;
      }
    }
    const lp = this.loupe8;
    const lv = this.loupeVis2;
    lp.fill(0);
    lv.fill(0);
    let shown = 0;
    for (const l of scene.loupes) {
      if (shown === 2) break;
      if (!(l.visibility > TOY_GL.minVisibility) || !(l.radius > 0)) continue;
      lp[shown * 4] = stage.x + l.center.x * stage.w;
      lp[shown * 4 + 1] = stage.y + l.center.y * stage.h;
      lp[shown * 4 + 2] = l.radius * stage.h;
      lp[shown * 4 + 3] = l.zoom > 0 ? l.zoom : 1;
      lv[shown] = clamp01(l.visibility);
      shown++;
    }

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, box.y, box.w, box.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog.program);
    gl.uniform2f(u.uRes, env.width, env.height);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform4f(u.uStage, stage.x, stage.y, stage.w, stage.h);
    gl.uniform2fv(u.uQ, q);
    gl.uniform1f(u.uQuadVis, quadVis);
    gl.uniform1f(u.uArm, f ? Math.min(0.5, Math.max(0, f.arm)) : 0);
    gl.uniform4fv(u.uLoupe, lp);
    gl.uniform1fv(u.uLoupeVis, lv);

    // Treatment. Texture units: camera 0, AI 1, ramp 2, plate 3.
    const t = scene.treatment;
    const ai = env.aiRect;
    const aiOk = ai.w > 1e-6 && ai.h > 1e-6;
    const plate = this.plate && this.plateValid ? this.plate : null;
    this.bindTexture(0, env.camera);
    gl.uniform1i(u.uCam, 0);
    this.bindTexture(1, env.ai);
    gl.uniform1i(u.uAi, 1);
    this.bindTexture(2, this.ramp);
    gl.uniform1i(u.uRamp, 2);
    this.bindTexture(3, plate ? plate.tex : this.zero);
    gl.uniform1i(u.uPlate, 3);
    gl.uniform1f(u.uCamMirror, env.cameraMirror ? 1 : 0);
    gl.uniform1f(u.uPlateMix, plate ? clamp01(scene.plate.mix) : 0);
    gl.uniform1f(u.uRampRows, LUT_ROWS);
    gl.uniform1f(u.uAspect, safeAspect(stage.w, stage.h));
    if (aiOk) gl.uniform4f(u.uAiRect, ai.x, ai.y, ai.w, ai.h);
    else gl.uniform4f(u.uAiRect, 0, 0, 1, 1);
    gl.uniform2f(u.uAnime, aiOk ? clamp01(t.animeFrom) : 0, aiOk ? clamp01(t.animeTo) : 0);
    gl.uniform2f(u.uRow, t.rowFrom, t.rowTo);
    gl.uniform1f(u.uProg, t.progress >= 0 ? Math.min(1, t.progress) : 1);
    gl.uniform1f(u.uSeed, foldSeed(t.seed));
    gl.uniform1f(u.uTiles, t.tiles ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  // ── Particles ──────────────────────────────────────────────────────────────

  private drawSparks(scene: ToyScene, env: ToyRenderEnv): boolean {
    const s = scene.sparks;
    if (!s) return false;
    const n = Math.min(s.count, Math.floor(s.data.length / SPARK_STRIDE));
    if (!(n > 0)) return false;
    const prog = this.program("sparks");
    if (!prog) return false;
    const gl = this.gl;
    const { stage } = env;

    // Stage space → the px the point shader takes.
    let grown = false;
    if (this.sparkData.length < n * SPARK_STRIDE) {
      this.sparkData = new Float32Array(Math.max(TOY_GL.sparkCapacity, n * 2) * SPARK_STRIDE);
      grown = true;
    }
    const out = this.sparkData;
    for (let i = 0; i < n; i++) {
      const o = i * SPARK_STRIDE;
      out[o] = stage.x + s.data[o] * stage.w;
      out[o + 1] = stage.y + s.data[o + 1] * stage.h;
      out[o + 2] = s.data[o + 2] * stage.h;
      out[o + 3] = s.data[o + 3];
      out[o + 4] = s.data[o + 4];
    }

    if (!this.sparkVao || !this.sparkVbo) {
      this.sparkVao = gl.createVertexArray();
      this.sparkVbo = gl.createBuffer();
      gl.bindVertexArray(this.sparkVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, SPARK_STRIDE * 4, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, SPARK_STRIDE * 4, 16);
      grown = true;
    } else {
      gl.bindVertexArray(this.sparkVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
    }
    if (grown) gl.bufferData(gl.ARRAY_BUFFER, out.byteLength, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * SPARK_STRIDE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(prog.program);
    gl.uniform2f(prog.u.uRes, env.width, env.height);
    gl.uniform3f(prog.u.uBlue, BLUE[0], BLUE[1], BLUE[2]);
    gl.uniform3f(prog.u.uViolet, VIOLET[0], VIOLET[1], VIOLET[2]);
    gl.uniform1f(prog.u.uAlpha, TOY_GL.sparkAlpha);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return true; // restore() re-binds the full-screen VAO
  }

  // ── Debug ──────────────────────────────────────────────────────────────────

  private drawOnion(env: ToyRenderEnv): boolean {
    const ai = env.aiRect;
    if (!(ai.w > 1e-6) || !(ai.h > 1e-6)) return false;
    const prog = this.program("onion");
    if (!prog) return false;
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog.program);
    gl.uniform2f(prog.u.uRes, env.width, env.height);
    gl.uniform4f(prog.u.uStage, env.stage.x, env.stage.y, env.stage.w, env.stage.h);
    gl.uniform4f(prog.u.uAiRect, ai.x, ai.y, ai.w, ai.h);
    this.bindTexture(1, env.ai);
    gl.uniform1i(prog.u.uAi, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}
