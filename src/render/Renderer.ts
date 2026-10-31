import { homogeneousW, invert3, squareToQuad, toGLMatrix } from "../geometry/homography";
import { boundingBox, centroid, estimateAspect, expandQuad, signedArea } from "../geometry/quad";
import type { Quad, Vec2 } from "../geometry/vec";
import { drawPreviewLabel, drawTestCard } from "./canvasTextures";
import { createProgram, createRenderTarget, createTexture, VideoTexture, type Program, type RenderTarget } from "./gl";
import { Particles } from "./particles";
import { BACKGROUND_FS, FULLSCREEN_VS, PARTICLE_FS, PARTICLE_VS, PORTAL_FS, STYLIZE_FS, TESTCARD_FS } from "./shaders";

export type ContentSource = "decart" | "local" | "test";
export type ContentFit = "cover" | "stretch";
export type ContentMapping = "projected" | "window";

export interface RenderFrame {
  /** Seconds, monotonic. */
  time: number;
  portal: {
    corners: Quad | null; // stage space
    visibility: number;
    locked: boolean;
    warn: boolean;
  };
  content: ContentSource;
  fit: ContentFit;
  mapping: ContentMapping;
  /** Full-screen transform: the AI output fills the frame and the portal shows reality. */
  fullscreenTransform: boolean;
  mirror: boolean;
  glow: number;
  energy: number;
  particles: boolean;
}

/** Cover-fit rectangle of the camera frame on the canvas, device px. */
export interface StageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BLUE: [number, number, number] = [0.29, 0.62, 1.0];
const VIOLET: [number, number, number] = [0.55, 0.38, 1.0];
const LOCAL_W = 960;
const LOCAL_H = 540;
/** Cover-crop keeps this fraction of the removed height above the window: webcam faces sit high. */
const CROP_ANCHOR_Y = 0.3;
const LABEL_ASPECT = 720 / 92;

const easeOutBack = (t: number) => {
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private gl!: WebGL2RenderingContext;
  private bg!: Program;
  private portal!: Program;
  private particleProg!: Program;
  private stylize!: Program;
  private testcard!: Program;
  private vao!: WebGLVertexArrayObject;
  private camTex!: VideoTexture;
  private aiTex!: VideoTexture;
  private labelTex!: WebGLTexture;
  private cardTex!: WebGLTexture;
  private localRT!: RenderTarget;
  private testRT!: RenderTarget;
  private particles!: Particles;
  private hinv = new Float32Array(9);
  private crop = { sx: 1, sy: 1 };
  private ready = 0;
  private lastTime = 0;
  private camVideo: HTMLVideoElement | null = null;
  private aiVideo: HTMLVideoElement | null = null;
  private pendingCapture: ((b: Blob | null) => void)[] = [];
  private lost = false;
  dpr = 1;
  stage: StageRect = { x: 0, y: 0, w: 1, h: 1 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.init();
      this.setCamera(this.camVideo);
      this.setAI(this.aiVideo);
      this.lost = false;
    });
    this.init();
  }

  private init() {
    const gl = this.canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      desynchronized: true,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    this.bg = createProgram(gl, FULLSCREEN_VS, BACKGROUND_FS, [
      "uRes", "uStage", "uCam", "uAlt", "uHasCam", "uMirror", "uAlt01", "uTime",
    ]);
    this.portal = createProgram(gl, FULLSCREEN_VS, PORTAL_FS, [
      "uRes", "uContent", "uHinv", "uSign", "uQ", "uCenter", "uSize", "uCrop", "uStage", "uWindow",
      "uContentMirror", "uTime", "uReveal", "uGlow", "uEnergy", "uLocked", "uWarn", "uReady", "uDpr",
      "uBlue", "uViolet",
    ]);
    this.particleProg = createProgram(gl, PARTICLE_VS, PARTICLE_FS, ["uRes", "uBlue", "uViolet", "uAlpha"]);
    this.stylize = createProgram(gl, FULLSCREEN_VS, STYLIZE_FS, [
      "uCam", "uLabel", "uTexel", "uLabelRect", "uMirror", "uTime", "uHasCam", "uBlue", "uViolet",
    ]);
    this.testcard = createProgram(gl, FULLSCREEN_VS, TESTCARD_FS, ["uCard", "uTime", "uBlue"]);

    this.camTex = new VideoTexture(gl);
    this.aiTex = new VideoTexture(gl);
    this.labelTex = this.uploadCanvas(drawPreviewLabel());
    this.cardTex = this.uploadCanvas(drawTestCard());
    this.localRT = createRenderTarget(gl, LOCAL_W, LOCAL_H);
    this.testRT = createRenderTarget(gl, 1280, 720);
    this.particles = new Particles(gl);
  }

  private uploadCanvas(c: HTMLCanvasElement): WebGLTexture {
    const gl = this.gl;
    const t = createTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    return t;
  }

  setCamera(video: HTMLVideoElement | null) {
    this.camVideo = video;
    this.camTex?.setVideo(video);
  }

  setAI(video: HTMLVideoElement | null) {
    this.aiVideo = video;
    this.aiTex?.setVideo(video);
    this.ready = 0;
  }

  /** Width / height of the stage (the displayed camera frame). */
  get stageAspect(): number {
    return this.stage.w / Math.max(1, this.stage.h);
  }

  /** Whether a decoded AI frame has reached the GPU, and how fresh it is. */
  aiStatus() {
    return { ready: this.aiTex.ready, frames: this.aiTex.frames, lastFrameAt: this.aiTex.lastFrameAt };
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = Math.min(dpr, 2);
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Cover-fit of the camera frame; without a camera the stage is the whole canvas. */
  private computeStage(): StageRect {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const { w: vw, h: vh } = this.camVideo?.videoWidth ? this.camTex.size : { w: W, h: H };
    const s = Math.max(W / vw, H / vh);
    const sw = vw * s;
    const sh = vh * s;
    return { x: (W - sw) / 2, y: (H - sh) / 2, w: sw, h: sh };
  }

  /** Stage space ([0,1]² of the displayed camera frame) → device px. */
  stageToPx(p: Vec2): Vec2 {
    return { x: this.stage.x + p.x * this.stage.w, y: this.stage.y + p.y * this.stage.h };
  }

  /** Resolves with a PNG of the next rendered frame. */
  capture(): Promise<Blob | null> {
    return new Promise((resolve) => this.pendingCapture.push(resolve));
  }

  render(f: RenderFrame) {
    if (this.lost) return;
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dt = this.lastTime ? f.time - this.lastTime : 1 / 60;
    this.lastTime = f.time;

    this.camTex.update();
    const hasCam = this.camTex.ready ? 1 : 0;
    this.stage = this.computeStage();
    const st = this.stage;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    // ── Content for the portal ───────────────────────────────────────────────
    let content: WebGLTexture;
    let contentAspect = 16 / 9;
    let readyTarget = 1;
    if (f.content === "decart") {
      this.aiTex.update();
      content = this.aiTex.tex;
      const s = this.aiTex.size;
      contentAspect = s.w / s.h;
      readyTarget = this.aiTex.ready ? 1 : 0;
    } else if (f.content === "local") {
      this.renderLocal(f, hasCam);
      content = this.localRT.tex;
    } else {
      this.renderTestCard(f);
      content = this.testRT.tex;
    }
    this.ready += (readyTarget - this.ready) * (1 - Math.exp(-dt / 0.25));
    const altTex = f.content === "decart" ? this.aiTex.tex : f.content === "local" ? this.localRT.tex : this.testRT.tex;

    // ── Background ───────────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.bg.program);
    gl.uniform2f(this.bg.u.uRes, W, H);
    gl.uniform4f(this.bg.u.uStage, st.x, st.y, st.w, st.h);
    gl.uniform1f(this.bg.u.uHasCam, hasCam);
    gl.uniform1f(this.bg.u.uMirror, f.mirror ? 1 : 0);
    gl.uniform1f(this.bg.u.uAlt01, f.fullscreenTransform ? this.ready : 0);
    gl.uniform1f(this.bg.u.uTime, f.time);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex.tex);
    gl.uniform1i(this.bg.u.uCam, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, altTex);
    gl.uniform1i(this.bg.u.uAlt, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ── Portal ───────────────────────────────────────────────────────────────
    const vis = f.portal.visibility;
    let pxQuad: Quad | null = null;
    if (f.portal.corners && vis > 0.002) {
      const raw = f.portal.corners.map((p) => this.stageToPx(p)) as Quad;
      pxQuad = expandQuad(raw, 0.8 + 0.2 * easeOutBack(Math.min(1, vis)));
      this.drawPortal(f, pxQuad, content, contentAspect, vis);
    }

    // ── Sparks ───────────────────────────────────────────────────────────────
    this.particles.update(dt, f.particles && vis > 0.5 ? pxQuad : null, f.energy, this.dpr, f.portal.locked);
    if (f.particles) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.particleProg.program);
      gl.uniform2f(this.particleProg.u.uRes, W, H);
      gl.uniform3fv(this.particleProg.u.uBlue, BLUE);
      gl.uniform3fv(this.particleProg.u.uViolet, VIOLET);
      gl.uniform1f(this.particleProg.u.uAlpha, Math.min(1, vis) * (0.4 + 0.6 * f.glow));
      this.particles.draw();
      gl.disable(gl.BLEND);
    } else this.particles.clear();

    if (this.pendingCapture.length) {
      const waiting = this.pendingCapture.splice(0);
      // toBlob snapshots the drawing buffer synchronously, before it is presented.
      this.canvas.toBlob((b) => waiting.forEach((r) => r(b)), "image/png");
    }
  }

  private drawPortal(f: RenderFrame, q: Quad, content: WebGLTexture, contentAspect: number, vis: number) {
    const gl = this.gl;
    const H = squareToQuad(q);
    const Hi = H && invert3(H);
    if (!Hi) return;
    const c = centroid(q);
    const area = Math.abs(signedArea(q));
    const size = Math.sqrt(area);

    // Content fit: crop the texture to the portal's apparent aspect, eased so it never pops.
    let sx = 1;
    let sy = 1;
    if (f.fit === "cover" && !f.fullscreenTransform) {
      const qa = Math.min(3, Math.max(0.33, estimateAspect(q)));
      if (qa < contentAspect) sx = qa / contentAspect;
      else sy = contentAspect / qa;
    }
    this.crop.sx += (sx - this.crop.sx) * 0.15;
    this.crop.sy += (sy - this.crop.sy) * 0.15;

    const glowW = Math.max(6 * this.dpr, size * 0.055) * (0.55 + 0.45 * f.glow);
    const margin = glowW * 9;
    const bb = boundingBox(q);
    const x0 = Math.max(0, Math.floor(bb.minX - margin));
    const x1 = Math.min(this.canvas.width, Math.ceil(bb.maxX + margin));
    // Scissor uses a bottom-left origin.
    const y0 = Math.max(0, Math.floor(this.canvas.height - (bb.maxY + margin)));
    const y1 = Math.min(this.canvas.height, Math.ceil(this.canvas.height - (bb.minY - margin)));
    if (x1 <= x0 || y1 <= y0) return;

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const u = this.portal.u;
    gl.useProgram(this.portal.program);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniformMatrix3fv(u.uHinv, false, toGLMatrix(Hi, this.hinv));
    gl.uniform1f(u.uSign, Math.sign(homogeneousW(Hi, c)) || 1);
    gl.uniform2fv(u.uQ, new Float32Array([q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]));
    gl.uniform2f(u.uCenter, c.x, c.y);
    gl.uniform1f(u.uSize, size);
    gl.uniform4f(u.uCrop, this.crop.sx, this.crop.sy, (1 - this.crop.sx) / 2, (1 - this.crop.sy) * CROP_ANCHOR_Y);
    gl.uniform4f(u.uStage, this.stage.x, this.stage.y, this.stage.w, this.stage.h);
    gl.uniform1f(u.uWindow, f.mapping === "window" || f.fullscreenTransform ? 1 : 0);
    gl.uniform1f(u.uContentMirror, f.fullscreenTransform && f.mirror ? 1 : 0);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uReveal, Math.min(1, vis));
    gl.uniform1f(u.uGlow, f.glow);
    gl.uniform1f(u.uEnergy, f.energy);
    gl.uniform1f(u.uLocked, f.portal.locked ? 1 : 0);
    gl.uniform1f(u.uWarn, f.portal.warn ? 1 : 0);
    gl.uniform1f(u.uReady, f.fullscreenTransform ? 1 : this.ready);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform3fv(u.uBlue, BLUE);
    gl.uniform3fv(u.uViolet, VIOLET);
    gl.activeTexture(gl.TEXTURE0);
    // Full-screen transform inverts the roles: the portal becomes a window back to the camera.
    gl.bindTexture(gl.TEXTURE_2D, f.fullscreenTransform ? this.camTex.tex : content);
    gl.uniform1i(u.uContent, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  private renderLocal(f: RenderFrame, hasCam: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.localRT.fbo);
    gl.viewport(0, 0, LOCAL_W, LOCAL_H);
    const u = this.stylize.u;
    gl.useProgram(this.stylize.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex.tex);
    gl.uniform1i(u.uCam, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
    gl.uniform1i(u.uLabel, 1);
    const { w, h } = this.camTex.size;
    gl.uniform2f(u.uTexel, 1 / w, 1 / h);
    const r = this.visibleContentRect(f);
    const lw = Math.min(0.5, r.w * 0.62);
    gl.uniform4f(u.uLabelRect, r.x + r.w * 0.04, r.y + r.h * 0.06, lw, (lw / LABEL_ASPECT) * (LOCAL_W / LOCAL_H));
    gl.uniform1f(u.uMirror, f.mirror ? 1 : 0);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uHasCam, hasCam);
    gl.uniform3fv(u.uBlue, BLUE);
    gl.uniform3fv(u.uViolet, VIOLET);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * The part of the content image the viewer can actually see, in content uv. The
   * "not AI output" label is placed inside it so cropping can never hide it.
   */
  private visibleContentRect(f: RenderFrame): { x: number; y: number; w: number; h: number } {
    if (f.fullscreenTransform || !f.portal.corners) return { x: 0, y: 0, w: 1, h: 1 };
    if (f.mapping === "window") {
      // Window mode samples the content in stage space: the portal's own footprint.
      const xs = f.portal.corners.map((p) => p.x);
      const ys = f.portal.corners.map((p) => p.y);
      const x = Math.max(0, Math.min(...xs));
      const y = Math.max(0, Math.min(...ys));
      return { x, y, w: Math.max(0.05, Math.min(1, Math.max(...xs)) - x), h: Math.max(0.05, Math.min(1, Math.max(...ys)) - y) };
    }
    const { sx, sy } = this.crop;
    return { x: (1 - sx) / 2, y: (1 - sy) * CROP_ANCHOR_Y, w: sx, h: sy };
  }

  private renderTestCard(f: RenderFrame) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.testRT.fbo);
    gl.viewport(0, 0, this.testRT.width, this.testRT.height);
    gl.useProgram(this.testcard.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cardTex);
    gl.uniform1i(this.testcard.u.uCard, 0);
    gl.uniform1f(this.testcard.u.uTime, f.time);
    gl.uniform3fv(this.testcard.u.uBlue, BLUE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose() {
    this.camTex.dispose();
    this.aiTex.dispose();
    this.particles.dispose();
  }
}
