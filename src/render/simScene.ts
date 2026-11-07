/**
 * The stand-in picture for when there is no camera: a calm, flat illustration of a room
 * (window light from the left, a lamp on the right, a head-and-shoulders figure in the
 * middle) drawn once with Canvas2D and uploaded as the scene texture.
 *
 * It is deliberately a drawing: flat shapes, a printed dot grid, hatched shading and a
 * burnt-in label, so it can never be taken for real video. The tones run from near-black
 * (hair, far corner) to near-white (window glass), so every colour filter has its whole
 * ramp to show. Greys throughout, with the app's blue and violet as the only accents.
 */

const FONT_MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

/** Burnt into the bottom-left corner of the picture. */
export const SIM_SCENE_LABEL = "SIMULATED CAMERA — NO VIDEO";

type Stop = readonly [offset: number, color: string];

/**
 * @param width  canvas width in px
 * @param height canvas height in px
 * The composition is laid out for a height of 720 and scales uniformly; other aspect
 * ratios move the window and the lamp with the side edges and keep the figure centred.
 */
export function drawSimScene(width = 1280, height = 720): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(width));
  c.height = Math.max(2, Math.round(height));
  const g = c.getContext("2d")!;
  const k = c.height / 720;
  g.scale(k, k);
  const W = c.width / k;
  const H = 720;
  const cx = W / 2;
  const floorY = 566;

  const linear = (x0: number, y0: number, x1: number, y1: number, stops: readonly Stop[]) => {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    return grad;
  };
  const radial = (x: number, y: number, r0: number, r1: number, stops: readonly Stop[]) => {
    const grad = g.createRadialGradient(x, y, r0, x, y, r1);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    return grad;
  };
  const ellipse = (x: number, y: number, rx: number, ry: number) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  };

  // ── Wall ───────────────────────────────────────────────────────────────────
  g.fillStyle = linear(0, 0, 0, floorY, [[0, "#161b28"], [1, "#202637"]]);
  g.fillRect(0, 0, W, floorY);
  // The far side of the room falls away towards black.
  g.fillStyle = linear(W * 0.38, 0, W, 0, [[0, "rgba(5, 6, 10, 0)"], [1, "rgba(5, 6, 10, 0.64)"]]);
  g.fillRect(0, 0, W, floorY);
  // Printed dot grid: the first thing that says "drawing".
  g.fillStyle = "rgba(233, 237, 247, 0.06)";
  for (let y = 15; y < floorY - 10; y += 16) {
    for (let x = 15; x < W; x += 16) g.fillRect(x, y, 1.5, 1.5);
  }

  // ── Window (left) ──────────────────────────────────────────────────────────
  const wx = Math.round(W * 0.072);
  const wy = 76;
  const ww = 292;
  const wh = 376;
  // Its light on the wall.
  g.fillStyle = radial(wx + ww / 2, wy + wh / 2, 110, 640, [[0, "rgba(160, 190, 245, 0.32)"], [1, "rgba(160, 190, 245, 0)"]]);
  g.fillRect(0, 0, W, floorY);
  g.fillStyle = "#0a0c13";
  g.fillRect(wx - 12, wy - 12, ww + 24, wh + 24);
  g.fillStyle = linear(0, wy, 0, wy + wh, [[0, "#fcfdff"], [0.55, "#dde8ff"], [1, "#b4ccf7"]]);
  g.fillRect(wx, wy, ww, wh);
  g.save();
  g.beginPath();
  g.rect(wx, wy, ww, wh);
  g.clip();
  // Sun and two ridgelines outside.
  g.fillStyle = "rgba(255, 255, 255, 0.5)";
  ellipse(wx + ww * 0.69, wy + wh * 0.25, 46, 46);
  g.fill();
  g.fillStyle = "#ffffff";
  ellipse(wx + ww * 0.69, wy + wh * 0.25, 27, 27);
  g.fill();
  g.fillStyle = "#93aee2";
  g.beginPath();
  g.moveTo(wx, wy + wh * 0.76);
  g.bezierCurveTo(wx + ww * 0.3, wy + wh * 0.64, wx + ww * 0.62, wy + wh * 0.86, wx + ww, wy + wh * 0.69);
  g.lineTo(wx + ww, wy + wh);
  g.lineTo(wx, wy + wh);
  g.closePath();
  g.fill();
  g.fillStyle = "#6c8ac6";
  g.beginPath();
  g.moveTo(wx, wy + wh * 0.9);
  g.bezierCurveTo(wx + ww * 0.34, wy + wh * 0.8, wx + ww * 0.7, wy + wh * 0.97, wx + ww, wy + wh * 0.85);
  g.lineTo(wx + ww, wy + wh);
  g.lineTo(wx, wy + wh);
  g.closePath();
  g.fill();
  g.restore();
  // Glazing bars and sill.
  g.fillStyle = "#0a0c13";
  g.fillRect(wx + ww / 2 - 4, wy, 8, wh);
  g.fillRect(wx, wy + wh * 0.44 - 4, ww, 8);
  g.fillStyle = "#2c3447";
  g.fillRect(wx - 26, wy + wh + 12, ww + 52, 12);
  g.fillStyle = "rgba(214, 226, 255, 0.55)";
  g.fillRect(wx - 26, wy + wh + 12, ww + 52, 2);

  // A band of daylight across the wall.
  const sx = wx + ww + 12;
  g.fillStyle = linear(sx, 0, sx + 620, 0, [[0, "rgba(176, 202, 250, 0.17)"], [1, "rgba(176, 202, 250, 0)"]]);
  g.beginPath();
  g.moveTo(sx, wy + 4);
  g.lineTo(sx + 620, wy + 150);
  g.lineTo(sx + 620, floorY);
  g.lineTo(sx, wy + wh - 26);
  g.closePath();
  g.fill();

  // ── Picture on the wall (right of the figure) ──────────────────────────────
  const ax = Math.round(W * 0.662);
  const ay = 128;
  const aw = 128;
  const ah = 170;
  g.fillStyle = "#3a4257";
  g.fillRect(ax - 5, ay - 5, aw + 10, ah + 10);
  g.fillStyle = "#0b0d14";
  g.fillRect(ax, ay, aw, ah);
  g.fillStyle = "#4a9eff";
  ellipse(ax + aw * 0.44, ay + ah * 0.4, 29, 29);
  g.fill();
  g.strokeStyle = "#8c66ff";
  g.lineWidth = 6;
  g.lineCap = "round";
  g.beginPath();
  g.arc(ax + aw * 0.44, ay + ah * 0.4, 45, -0.7, 1.55);
  g.stroke();
  g.strokeStyle = "rgba(233, 237, 247, 0.85)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(ax + 18, ay + ah * 0.8);
  g.lineTo(ax + aw - 18, ay + ah * 0.8);
  g.stroke();

  // ── Floor ──────────────────────────────────────────────────────────────────
  g.fillStyle = linear(0, floorY, 0, H, [[0, "#0c0f17"], [1, "#06070b"]]);
  g.fillRect(0, floorY, W, H - floorY);
  g.fillStyle = "#11151f";
  g.fillRect(0, floorY - 6, W, 6);
  g.fillStyle = "rgba(233, 237, 247, 0.1)";
  g.fillRect(0, floorY - 7, W, 1);
  // Daylight on the floor.
  g.fillStyle = linear(0, floorY, 0, H, [[0, "rgba(170, 198, 250, 0.17)"], [1, "rgba(170, 198, 250, 0.05)"]]);
  g.beginPath();
  g.moveTo(wx + 30, floorY);
  g.lineTo(wx + ww + 44, floorY);
  g.lineTo(wx + ww + 262, H);
  g.lineTo(wx + 156, H);
  g.closePath();
  g.fill();

  // ── Lamp (right): the violet light ─────────────────────────────────────────
  const lx = Math.round(W - 176);
  g.globalCompositeOperation = "lighter";
  g.fillStyle = radial(lx, 268, 18, 372, [[0, "rgba(140, 102, 255, 0.36)"], [1, "rgba(140, 102, 255, 0)"]]);
  g.fillRect(0, 0, W, H);
  g.fillStyle = radial(lx, floorY + 58, 4, 168, [[0, "rgba(140, 102, 255, 0.2)"], [1, "rgba(140, 102, 255, 0)"]]);
  g.save();
  g.translate(0, (floorY + 58) * 0.82);
  g.scale(1, 0.18); // flatten the pool of light onto the floor
  g.fillRect(lx - 180, floorY + 58 - 180, 360, 360);
  g.restore();
  g.globalCompositeOperation = "source-over";
  g.fillStyle = "#090b11";
  g.fillRect(lx - 2, 288, 4, floorY + 50 - 288);
  ellipse(lx, floorY + 52, 42, 8);
  g.fill();
  g.fillStyle = linear(0, 206, 0, 294, [[0, "#d6caff"], [0.5, "#a78bff"], [1, "#6a43e0"]]);
  g.beginPath();
  g.moveTo(lx - 30, 206);
  g.lineTo(lx + 30, 206);
  g.lineTo(lx + 55, 294);
  g.lineTo(lx - 55, 294);
  g.closePath();
  g.fill();

  // ── Figure: head and shoulders, lit from the window, rimmed by the lamp ────
  const torso = () => {
    g.beginPath();
    g.moveTo(cx - 268, H);
    g.bezierCurveTo(cx - 266, 612, cx - 226, 548, cx - 128, 512);
    g.lineTo(cx - 46, 484);
    g.quadraticCurveTo(cx, 508, cx + 46, 484);
    g.lineTo(cx + 128, 512);
    g.bezierCurveTo(cx + 226, 548, cx + 266, 612, cx + 268, H);
    g.closePath();
  };
  const head = () => ellipse(cx, 296, 94, 116);
  const hatch = (alpha: number) => {
    // Hatched shading that fades in towards the side away from the window.
    g.strokeStyle = linear(cx - 6, 0, cx + 118, 0, [[0, "rgba(6, 7, 12, 0)"], [1, `rgba(6, 7, 12, ${alpha})`]]);
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = cx - 60; x < cx + 480; x += 7) {
      g.moveTo(x, 150);
      g.lineTo(x - 330, 722);
    }
    g.stroke();
  };

  // Ears sit behind the head.
  g.fillStyle = "#dfe5f1";
  ellipse(cx - 94, 306, 11, 24);
  g.fill();
  g.fillStyle = "#3d4558";
  ellipse(cx + 94, 306, 11, 24);
  g.fill();

  // Neck, with the shadow of the chin.
  const neck = () => {
    g.beginPath();
    g.moveTo(cx - 40, 372);
    g.lineTo(cx - 46, 486);
    g.quadraticCurveTo(cx, 512, cx + 46, 486);
    g.lineTo(cx + 40, 372);
    g.closePath();
  };
  g.fillStyle = linear(cx - 46, 0, cx + 46, 0, [[0, "#c5ccdc"], [0.5, "#8790a6"], [1, "#454c60"]]);
  neck();
  g.fill();
  g.save();
  neck();
  g.clip();
  g.fillStyle = "rgba(8, 10, 16, 0.42)";
  ellipse(cx + 6, 414, 52, 24);
  g.fill();
  hatch(0.3);
  g.restore();

  // Shoulders.
  g.fillStyle = linear(cx - 268, 0, cx + 268, 0, [[0, "#465066"], [0.4, "#262c3c"], [1, "#11141d"]]);
  torso();
  g.fill();
  // Collar.
  g.lineCap = "round";
  g.lineWidth = 9;
  g.strokeStyle = linear(cx - 50, 0, cx + 50, 0, [[0, "#7e88a1"], [1, "#2b3244"]]);
  g.beginPath();
  g.moveTo(cx - 46, 485);
  g.quadraticCurveTo(cx, 509, cx + 46, 485);
  g.stroke();
  // Window light along the near shoulder, lamp light along the far one.
  g.lineWidth = 2.5;
  g.strokeStyle = "rgba(214, 228, 255, 0.6)";
  g.beginPath();
  g.moveTo(cx - 266, 640);
  g.bezierCurveTo(cx - 258, 590, cx - 222, 547, cx - 130, 513);
  g.stroke();
  g.strokeStyle = "rgba(140, 102, 255, 0.72)";
  g.beginPath();
  g.moveTo(cx + 266, 640);
  g.bezierCurveTo(cx + 258, 590, cx + 222, 547, cx + 130, 513);
  g.stroke();
  // The one blue detail on the figure.
  g.fillStyle = "#4a9eff";
  ellipse(cx - 98, 606, 7, 7);
  g.fill();
  g.strokeStyle = "rgba(74, 158, 255, 0.42)";
  g.lineWidth = 1.5;
  ellipse(cx - 98, 606, 12.5, 12.5);
  g.stroke();

  // Head.
  g.fillStyle = linear(cx - 94, 0, cx + 94, 0, [[0, "#f4f7fd"], [0.34, "#d0d7e5"], [0.64, "#8d96ab"], [1, "#434b5f"]]);
  head();
  g.fill();
  g.save();
  head();
  g.clip();
  hatch(0.34);
  g.restore();
  g.lineWidth = 2.5;
  g.strokeStyle = "rgba(140, 102, 255, 0.78)";
  g.beginPath();
  g.ellipse(cx, 296, 93, 115, 0, -0.62, 0.95);
  g.stroke();

  // Face: three marks, no likeness.
  g.fillStyle = "rgba(10, 12, 19, 0.84)";
  for (const ex of [cx - 37, cx + 35]) {
    g.beginPath();
    g.ellipse(ex, 314, 12, 3.6, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "rgba(10, 12, 19, 0.62)";
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(cx - 19, 379);
  g.quadraticCurveTo(cx, 388, cx + 19, 379);
  g.stroke();
  g.strokeStyle = "rgba(10, 12, 19, 0.26)";
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(cx + 3, 326);
  g.quadraticCurveTo(cx - 9, 350, cx + 5, 355);
  g.stroke();

  // Hair: the darkest shape in the picture.
  g.fillStyle = linear(cx - 110, 0, cx + 110, 0, [[0, "#1c2130"], [0.45, "#0c0e15"], [1, "#06070b"]]);
  g.beginPath();
  g.moveTo(cx - 99, 314);
  g.bezierCurveTo(cx - 124, 196, cx - 64, 150, cx + 4, 152);
  g.bezierCurveTo(cx + 80, 154, cx + 126, 204, cx + 99, 318);
  g.bezierCurveTo(cx + 95, 264, cx + 72, 234, cx + 34, 227);
  g.bezierCurveTo(cx - 6, 220, cx - 38, 252, cx - 78, 247);
  g.bezierCurveTo(cx - 91, 264, cx - 97, 288, cx - 99, 314);
  g.closePath();
  g.fill();
  g.strokeStyle = "rgba(190, 208, 245, 0.5)";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx - 96, 250);
  g.bezierCurveTo(cx - 102, 198, cx - 56, 168, cx - 8, 164);
  g.stroke();

  // ── Vignette ───────────────────────────────────────────────────────────────
  g.fillStyle = radial(cx, H * 0.46, H * 0.56, Math.hypot(cx, H * 0.62), [[0, "rgba(3, 4, 7, 0)"], [1, "rgba(3, 4, 7, 0.52)"]]);
  g.fillRect(0, 0, W, H);

  // ── Label ──────────────────────────────────────────────────────────────────
  // Set letter by letter: canvas letter-spacing is not available everywhere.
  g.fillStyle = "#4a9eff";
  ellipse(31, H - 30, 3, 3);
  g.fill();
  g.font = `500 12px ${FONT_MONO}`;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillStyle = "rgba(233, 237, 247, 0.84)";
  let tx = 44;
  for (const ch of SIM_SCENE_LABEL) {
    g.fillText(ch, tx, H - 26);
    tx += g.measureText(ch).width + 2.2;
  }
  return c;
}
