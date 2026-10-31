import { centroid } from "../geometry/quad";
import type { Vec2 } from "../geometry/vec";
import type { GestureProgress } from "../gestures/GestureMachine";
import { CORNER_NAMES } from "../portal/cornerMapping";
import type { PortalSnapshot } from "../portal/PortalController";
import type { TrackedHand } from "../tracking/handAssignment";
import { HAND_CONNECTIONS } from "../tracking/landmarks";
import type { StageRect } from "./Renderer";

export interface OverlayFrame {
  stage: StageRect;
  dpr: number;
  hands: TrackedHand[];
  skeleton: boolean;
  labels: boolean;
  portal: PortalSnapshot;
  gestures: GestureProgress[];
}

const ROLE_COLOR = { A: "90, 168, 255", B: "150, 120, 255" };
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

/**
 * Crisp 2D annotations over the GL canvas: corner markers and labels, where the
 * fingertips really are, the debug skeleton, and gesture hold rings.
 */
export class Overlay {
  private ctx: CanvasRenderingContext2D;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(f: OverlayFrame) {
    const g = this.ctx;
    const d = f.dpr;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const px = (p: Vec2): Vec2 => ({ x: f.stage.x + p.x * f.stage.w, y: f.stage.y + p.y * f.stage.h });

    if (f.skeleton) {
      for (const h of f.hands) {
        const col = ROLE_COLOR[h.role];
        const pts = h.obs.points.map(px);
        g.globalAlpha = h.fresh ? 1 : 0.35;
        g.strokeStyle = `rgba(${col}, 0.75)`;
        g.lineWidth = 1.5 * d;
        g.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          g.moveTo(pts[a].x, pts[a].y);
          g.lineTo(pts[b].x, pts[b].y);
        }
        g.stroke();
        g.fillStyle = "rgba(240, 246, 255, 0.95)";
        for (const p of pts) {
          g.beginPath();
          g.arc(p.x, p.y, 2.2 * d, 0, Math.PI * 2);
          g.fill();
        }
        const w = pts[0];
        g.font = `500 ${10 * d}px ${MONO}`;
        g.fillStyle = `rgba(${col}, 1)`;
        g.fillText(`${h.role} · #${h.id}${h.fresh ? "" : " · coasting"}`, w.x + 8 * d, w.y + 16 * d);
        g.globalAlpha = 1;
      }
    }

    const s = f.portal;
    const vis = s.visibility;
    // Fingertips: always shown faintly so you can see what is being tracked.
    s.fingers.forEach((p, i) => {
      if (!p) return;
      const fp = px(p);
      const corner = s.corners ? px(s.corners[i]) : null;
      g.globalAlpha = s.fresh[i] ? 0.9 : 0.4;
      if (corner && Math.hypot(corner.x - fp.x, corner.y - fp.y) > 8 * d) {
        g.setLineDash([3 * d, 4 * d]);
        g.strokeStyle = "rgba(200, 214, 255, 0.45)";
        g.lineWidth = 1 * d;
        g.beginPath();
        g.moveTo(fp.x, fp.y);
        g.lineTo(corner.x, corner.y);
        g.stroke();
        g.setLineDash([]);
      }
      g.strokeStyle = "rgba(232, 242, 255, 0.85)";
      g.lineWidth = 1.25 * d;
      g.beginPath();
      g.arc(fp.x, fp.y, 5 * d, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    });

    if (s.corners && vis > 0.05) {
      const corners = s.corners.map(px);
      const c = centroid([corners[0], corners[1], corners[2], corners[3]]);
      g.globalAlpha = Math.min(1, vis);
      corners.forEach((p, i) => {
        const r = (s.locked ? 7 : 9) * d;
        g.fillStyle = s.locked ? "rgba(255,255,255,0.95)" : "rgba(10, 14, 26, 0.55)";
        g.strokeStyle = s.locked ? "rgba(255,255,255,1)" : "rgba(232, 242, 255, 0.95)";
        g.lineWidth = 1.5 * d;
        if (s.locked) {
          g.fillRect(p.x - r / 2, p.y - r / 2, r, r);
        } else {
          g.beginPath();
          g.arc(p.x, p.y, r, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.fillStyle = "rgba(255,255,255,0.95)";
          g.beginPath();
          g.arc(p.x, p.y, 2.2 * d, 0, Math.PI * 2);
          g.fill();
        }
        if (f.labels) {
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const l = Math.hypot(dx, dy) || 1;
          const lx = p.x + (dx / l) * 22 * d;
          const ly = p.y + (dy / l) * 22 * d;
          g.font = `600 ${10.5 * d}px ${MONO}`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillStyle = "rgba(4, 6, 12, 0.6)";
          const tw = g.measureText(CORNER_NAMES[i]).width + 10 * d;
          g.fillRect(lx - tw / 2, ly - 8 * d, tw, 16 * d);
          g.fillStyle = "rgba(232, 242, 255, 0.95)";
          g.fillText(CORNER_NAMES[i], lx, ly + 0.5 * d);
        }
      });
      g.globalAlpha = 1;
      g.textAlign = "start";
      g.textBaseline = "alphabetic";
    }

    for (const gp of f.gestures) {
      if (gp.progress < 0.08) continue;
      const p = px(gp.anchor);
      const r = 22 * d;
      g.lineWidth = 3 * d;
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = gp.action === "lock" ? "rgba(255,255,255,0.95)" : "rgba(150, 120, 255, 0.95)";
      g.beginPath();
      g.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + gp.progress * Math.PI * 2);
      g.stroke();
      g.font = `600 ${9.5 * d}px ${MONO}`;
      g.fillStyle = "rgba(240, 246, 255, 0.95)";
      g.textAlign = "center";
      g.fillText(gp.action === "lock" ? (s.locked ? "UNLOCK" : "LOCK") : "RESET", p.x, p.y + r + 14 * d);
      g.textAlign = "start";
    }
  }
}
