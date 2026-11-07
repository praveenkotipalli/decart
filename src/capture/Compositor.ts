/**
 * Flattens the GL canvas and the 2D tracker canvas into one picture, so snapshots and
 * recordings contain the tracker graphics. It is used only while recording or for a
 * snapshot: nothing is copied per frame in normal use.
 *
 * `compose` must run in the same task as the GL render: the WebGL drawing buffer is
 * not preserved once the frame has been presented.
 */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(
    private maxWidth = 1280,
    private maxHeight = 720,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
  }

  /** Output size for a source: fitted inside the maximum, never upscaled, even dimensions (video encoders need them). */
  static fit(srcW: number, srcH: number, maxW: number, maxH: number): { w: number; h: number } {
    const k = Math.min(1, maxW / Math.max(1, srcW), maxH / Math.max(1, srcH));
    const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
    return { w: even(srcW), h: even(srcH) };
  }

  compose(gl: HTMLCanvasElement, overlay: HTMLCanvasElement | null) {
    const { w, h } = Compositor.fit(gl.width, gl.height, this.maxWidth, this.maxHeight);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const g = this.ctx;
    g.imageSmoothingQuality = "high";
    g.drawImage(gl, 0, 0, w, h);
    if (overlay && overlay.width > 0 && overlay.height > 0) g.drawImage(overlay, 0, 0, w, h);
  }

  toBlob(type = "image/png"): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob(resolve, type));
  }
}
