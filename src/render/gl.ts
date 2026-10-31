export type Uniforms = Record<string, WebGLUniformLocation | null>;

export interface Program {
  program: WebGLProgram;
  u: Uniforms;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return s;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): Program {
  const program = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const u: Uniforms = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

export function createTexture(gl: WebGL2RenderingContext, filter: number = gl.LINEAR): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 1x1 placeholder so sampling an empty texture is defined.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([5, 6, 10, 255]));
  return t;
}

export interface RenderTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export function createRenderTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget {
  const tex = createTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, width, height };
}

/**
 * A texture fed from a <video>. Uploads only when the browser reports a new
 * decoded frame (requestVideoFrameCallback), so a 25 fps AI stream costs 25
 * uploads/s, not 60 — and there is never a queue: the latest frame wins.
 */
export class VideoTexture {
  readonly tex: WebGLTexture;
  private video: HTMLVideoElement | null = null;
  private dirty = true;
  private rvfc = 0;
  private allocated = { w: 0, h: 0 };
  /** Wall time of the last new frame, ms (performance.now clock). */
  lastFrameAt = 0;
  frames = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.tex = createTexture(gl);
  }

  setVideo(video: HTMLVideoElement | null) {
    if (this.video && this.rvfc && "cancelVideoFrameCallback" in this.video) {
      this.video.cancelVideoFrameCallback(this.rvfc);
    }
    this.video = video;
    this.dirty = true;
    this.frames = 0;
    this.lastFrameAt = 0;
    if (video && "requestVideoFrameCallback" in video) {
      const onFrame = () => {
        this.dirty = true;
        this.rvfc = video.requestVideoFrameCallback(onFrame);
      };
      this.rvfc = video.requestVideoFrameCallback(onFrame);
    }
  }

  get ready(): boolean {
    const v = this.video;
    return !!v && v.readyState >= 2 && v.videoWidth > 0 && this.frames > 0;
  }

  get size(): { w: number; h: number } {
    return { w: this.video?.videoWidth || 16, h: this.video?.videoHeight || 9 };
  }

  /** Upload the newest frame if there is one. Returns true when a new frame was uploaded. */
  update(): boolean {
    const v = this.video;
    const gl = this.gl;
    if (!v || v.readyState < 2 || !v.videoWidth) return false;
    const hasRvfc = "requestVideoFrameCallback" in v;
    if (hasRvfc && !this.dirty) return false;
    this.dirty = false;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (this.allocated.w !== v.videoWidth || this.allocated.h !== v.videoHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      this.allocated = { w: v.videoWidth, h: v.videoHeight };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
    }
    this.frames++;
    this.lastFrameAt = performance.now();
    return true;
  }

  dispose() {
    this.setVideo(null);
    this.gl.deleteTexture(this.tex);
  }
}
