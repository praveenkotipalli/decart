import type { Quad } from "../geometry/vec";

const MAX = 420;
const STRIDE = 5; // x, y, size, life, hue

/**
 * Cursed-energy sparks shed from the portal rim. A few hundred points simulated
 * on the CPU (trivial cost) and drawn as additive GL points.
 */
export class Particles {
  private data = new Float32Array(MAX * STRIDE);
  private vel = new Float32Array(MAX * 2);
  private age = new Float32Array(MAX);
  private ttl = new Float32Array(MAX);
  private baseSize = new Float32Array(MAX);
  private count = 0;
  private spawnDebt = 0;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext) {
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE * 4, 16);
    gl.bindVertexArray(null);
  }

  /**
   * @param quad portal corners in device px (null = no portal; existing sparks die out)
   * @param intensity 0..1 effect intensity
   */
  update(dt: number, quad: Quad | null, intensity: number, dpr: number, locked: boolean) {
    dt = Math.min(dt, 0.05);
    // Age and integrate; compact dead particles in place.
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.ttl[i]) continue;
      const o = i * STRIDE;
      const vx = this.vel[i * 2] * (1 - dt * 0.8);
      const vy = this.vel[i * 2 + 1] * (1 - dt * 0.8) - 18 * dpr * dt; // drift upward
      const no = w * STRIDE;
      this.data[no] = this.data[o] + vx * dt;
      this.data[no + 1] = this.data[o + 1] + vy * dt;
      this.data[no + 2] = this.baseSize[i];
      this.data[no + 3] = this.age[i] / this.ttl[i];
      this.data[no + 4] = this.data[o + 4];
      this.vel[w * 2] = vx;
      this.vel[w * 2 + 1] = vy;
      this.age[w] = this.age[i];
      this.ttl[w] = this.ttl[i];
      this.baseSize[w] = this.baseSize[i];
      w++;
    }
    this.count = w;

    if (!quad || intensity <= 0) return;
    const edges = [0, 1, 2, 3].map((i) => {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
    });
    const perimeter = edges.reduce((s, e) => s + e.len, 0);
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

    const rate = (perimeter / dpr) * 0.09 * intensity * (locked ? 0.35 : 1); // sparks per second
    this.spawnDebt += rate * dt;
    while (this.spawnDebt >= 1 && this.count < MAX) {
      this.spawnDebt -= 1;
      let r = Math.random() * perimeter;
      let e = edges[0];
      for (const edge of edges) {
        if (r <= edge.len) {
          e = edge;
          break;
        }
        r -= edge.len;
      }
      const t = e.len > 0 ? r / e.len : 0;
      const x = e.a.x + (e.b.x - e.a.x) * t;
      const y = e.a.y + (e.b.y - e.a.y) * t;
      let nx = x - cx;
      let ny = y - cy;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const tx = -ny;
      const ty = nx;
      const speed = (14 + Math.random() * 46) * dpr;
      const swirl = (Math.random() - 0.5) * 40 * dpr;
      const i = this.count++;
      const o = i * STRIDE;
      this.data[o] = x;
      this.data[o + 1] = y;
      this.baseSize[i] = (2 + Math.random() * 5) * dpr;
      this.data[o + 2] = this.baseSize[i];
      this.data[o + 3] = 0;
      this.data[o + 4] = Math.random();
      this.vel[i * 2] = nx * speed + tx * swirl;
      this.vel[i * 2 + 1] = ny * speed + ty * swirl;
      this.age[i] = 0;
      this.ttl[i] = 0.5 + Math.random() * 1.1;
    }
    this.spawnDebt = Math.min(this.spawnDebt, 4);
  }

  draw() {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * STRIDE);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }

  clear() {
    this.count = 0;
  }

  dispose() {
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteVertexArray(this.vao);
  }
}
