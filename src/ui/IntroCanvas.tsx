import { useEffect, useRef } from "react";
import { applyHomography, squareToQuad } from "../geometry/homography";
import { classifyQuad } from "../geometry/quad";
import type { Quad, Vec2 } from "../geometry/vec";
import { HAND_CONNECTIONS, LM } from "../tracking/landmarks";
import { SimulatedHands } from "../tracking/SimulatedHands";

const ASPECT = 16 / 9;

/**
 * The start-screen illustration: the same synthetic hands the demo mode uses,
 * framing a portal whose interior grid is projected with the real homography.
 */
export function IntroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext("2d")!;
    const sim = new SimulatedHands();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last: Quad | null = null;

    const draw = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      // Loop the first 13 s of the choreography: open, rotate, scale, tilt.
      const t = reduced ? 5200 : 1800 + ((now * 0.85) % 11200);
      const frame = sim.frame(t, ASPECT);
      const S = Math.min(h * 2.1, (w / ASPECT) * 2.15);
      const px = (p: Vec2): Vec2 => ({ x: w / 2 + (p.x - 0.5) * ASPECT * S, y: h * 0.52 + (p.y - 0.53) * S });

      const [a, b] = frame.hands;
      if (a && b) {
        const q = [a.points[LM.INDEX_TIP], b.points[LM.INDEX_TIP], b.points[LM.THUMB_TIP], a.points[LM.THUMB_TIP]].map(
          px,
        ) as Quad;
        if (classifyQuad(q, 400) === "valid") last = q;
      }
      if (last) drawPortal(g, last, now / 1000);
      for (const hand of frame.hands) drawHand(g, hand.points.map(px));
      if (last) {
        ["P1", "P2", "P3", "P4"].forEach((label, i) => {
          const p = last![i];
          g.fillStyle = "#f4f8ff";
          g.beginPath();
          g.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
          g.fill();
          g.font = '500 10.5px "JetBrains Mono Variable", ui-monospace, monospace';
          g.fillStyle = "rgba(200, 216, 255, 0.85)";
          g.fillText(label, p.x + (i === 0 || i === 3 ? -24 : 9), p.y + (i < 2 ? -9 : 17));
        });
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} aria-hidden />;
}

function drawPortal(g: CanvasRenderingContext2D, q: Quad, t: number) {
  const H = squareToQuad(q);
  if (!H) return;
  g.save();
  g.beginPath();
  q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  const grad = g.createLinearGradient(q[0].x, q[0].y, q[2].x, q[2].y);
  grad.addColorStop(0, "rgba(74, 158, 255, 0.30)");
  grad.addColorStop(1, "rgba(140, 102, 255, 0.34)");
  g.fillStyle = grad;
  g.fill();
  g.clip();
  // Perspective grid: lines of the unit square pushed through the homography.
  g.strokeStyle = "rgba(200, 220, 255, 0.16)";
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const u = i / 8;
    for (const [p0, p1] of [
      [{ x: u, y: 0 }, { x: u, y: 1 }],
      [{ x: 0, y: u }, { x: 1, y: u }],
    ]) {
      const a = applyHomography(H, p0);
      const b = applyHomography(H, p1);
      if (!a || !b) continue;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }
  const c = applyHomography(H, { x: 0.5, y: 0.5 });
  if (c) {
    const r = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, 160);
    r.addColorStop(0, `rgba(168, 212, 255, ${0.22 + 0.06 * Math.sin(t * 2)})`);
    r.addColorStop(1, "rgba(168, 212, 255, 0)");
    g.fillStyle = r;
    g.fillRect(c.x - 200, c.y - 200, 400, 400);
  }
  g.restore();

  g.save();
  g.shadowColor = "rgba(74, 158, 255, 0.9)";
  g.shadowBlur = 18;
  g.strokeStyle = "rgba(190, 222, 255, 0.95)";
  g.lineWidth = 1.6;
  g.beginPath();
  q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.stroke();
  g.restore();
}

function drawHand(g: CanvasRenderingContext2D, pts: Vec2[]) {
  g.strokeStyle = "rgba(220, 230, 255, 0.34)";
  g.lineWidth = 1.2;
  g.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    g.moveTo(pts[a].x, pts[a].y);
    g.lineTo(pts[b].x, pts[b].y);
  }
  g.stroke();
  g.fillStyle = "rgba(220, 230, 255, 0.55)";
  for (const p of pts) {
    g.beginPath();
    g.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
    g.fill();
  }
}
