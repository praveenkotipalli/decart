import { useEffect, useRef } from "react";
import { applyHomography, squareToQuad } from "../geometry/homography";
import { classifyQuad } from "../geometry/quad";
import type { Quad, Vec2 } from "../geometry/vec";
import { classifyHand, type HandShape } from "../gestures/classifier";
import { drawSimScene } from "../render/simScene";
import { TrackerOverlay } from "../render/TrackerOverlay";
import { FILTERS, nextFilter, sampleRamp, type FilterDef } from "../toy/filters";
import { bracketSegments } from "../toy/frameMath";
import { SimulatedToy } from "../toy/SimulatedToy";
import { ToyController } from "../toy/ToyController";
import type { FilterId, TintId } from "../toy/types";
import { HandAssigner } from "../tracking/handAssignment";
import { HAND_CONNECTIONS, LM } from "../tracking/landmarks";
import { DEFAULT_ONE_EURO } from "../tracking/oneEuro";
import { SimulatedHands } from "../tracking/SimulatedHands";

const ASPECT = 16 / 9;

/** The start-screen illustration: a small, live preview of whichever experience is selected. */
export function IntroCanvas({ toy }: { toy: boolean }) {
  return toy ? <ToyIntro /> : <PortalIntro />;
}

// ── The hand-frame toy ──────────────────────────────────────────────────────

const SCENE_W = 960;
const SCENE_H = 540;
const TRACK_INTERVAL_MS = 33;

/** The simulated scene pushed through one filter's colour ramp (done once per filter, on first use). */
function tintScene(scene: HTMLCanvasElement, def: FilterDef): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = scene.width;
  out.height = scene.height;
  const g = out.getContext("2d")!;
  g.drawImage(scene, 0, 0);
  if (!def.stops) return out;
  const img = g.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  // 256-entry table: the same mapping the frame shader reads from its lookup texture.
  const lut = Array.from({ length: 256 }, (_, i) => sampleRamp(def.stops!, i / 255));
  for (let i = 0; i < d.length; i += 4) {
    const c = lut[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])];
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
  }
  g.putImageData(img, 0, 0);
  return out;
}

/**
 * The real toy in miniature: the scripted demo hands drive the same controller the app
 * uses, and its scene is drawn with 2D canvas calls instead of WebGL. Nothing here is a
 * mock-up of the behaviour — only the picture is a drawn stand-in for a camera.
 */
function ToyIntro() {
  const picture = useRef<HTMLCanvasElement>(null);
  const trackers = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = picture.current!;
    const g = canvas.getContext("2d")!;
    const overlay = new TrackerOverlay(trackers.current!);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = drawSimScene(SCENE_W, SCENE_H);
    const tinted = new Map<number, HTMLCanvasElement>();
    const treated = (row: number) => {
      let c = tinted.get(row);
      if (!c) {
        c = tintScene(scene, Object.values(FILTERS).find((f) => f.row === row) ?? FILTERS.none);
        tinted.set(row, c);
      }
      return c;
    };

    const sim = new SimulatedToy();
    const assigner = new HandAssigner();
    const shapes = new Map<number, HandShape>();
    let filter: FilterId = "rose";
    let lastTint: TintId = "rose";
    const toy = new ToyController({
      effect: "frame",
      filter,
      lastTint,
      glitch: !reduced,
      loupeZoom: 2,
      smoothing: DEFAULT_ONE_EURO,
      trackers: true,
    });
    const space = { w: 1280, h: 720 };

    const track = (t: number) => {
      const hands = assigner.update(sim.frame(t, ASPECT), "two-hand");
      for (const h of hands) if (h.fresh) shapes.set(h.id, classifyHand(h.obs.world, shapes.get(h.id)));
      for (const e of toy.onTracking(t, hands, shapes, ASPECT, space)) {
        if (e.type !== "flip") continue;
        // One hand turned over: step the filter, exactly as the app does.
        filter = nextFilter(filter, 1, true);
        lastTint = filter === "none" ? lastTint : filter;
        toy.setOptions({ filter, lastTint });
      }
    };

    let raf = 0;
    let lastTrack = 0;
    let last = 0;

    const draw = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const W = Math.round(w * dpr);
      const H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        overlay.resize(W, H);
      }
      // The stage: the largest 16:9 box that fits, centred.
      const sw = Math.min(W, H * ASPECT);
      const sh = sw / ASPECT;
      const stage = { x: Math.round((W - sw) / 2), y: Math.round((H - sh) / 2), w: Math.round(sw), h: Math.round(sh) };
      const px = (p: Vec2): Vec2 => ({ x: stage.x + p.x * stage.w, y: stage.y + p.y * stage.h });

      if (now - lastTrack >= TRACK_INTERVAL_MS) {
        lastTrack = now;
        track(now);
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const { scene: s, trackers: tr } = toy.snapshot(now, dt, {
        animeShowing: false,
        animeTag: null,
        animeTone: "camera",
        reducedMotion: reduced,
        lowFps: false,
        space,
        debug: false,
      });

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.imageSmoothingQuality = "high";
      g.drawImage(scene, stage.x, stage.y, stage.w, stage.h);

      // Inside the frame: the same picture through the filter, cross-faded while it changes.
      const paintTreated = () => {
        const tm = s.treatment;
        if (tm.progress >= 1 || tm.rowTo === tm.rowFrom) {
          g.drawImage(treated(tm.rowTo), stage.x, stage.y, stage.w, stage.h);
          return;
        }
        g.drawImage(treated(tm.rowFrom), stage.x, stage.y, stage.w, stage.h);
        const alpha = g.globalAlpha;
        g.globalAlpha = alpha * tm.progress;
        g.drawImage(treated(tm.rowTo), stage.x, stage.y, stage.w, stage.h);
        g.globalAlpha = alpha;
      };

      if (s.frame && s.frame.visibility > 0.01) {
        const q = s.frame.quad.map(px) as Quad;
        g.save();
        g.globalAlpha = Math.min(1, s.frame.visibility);
        g.beginPath();
        q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.clip("evenodd"); // a twisted frame fills both lobes, like the shader
        paintTreated();
        g.restore();

        g.save();
        g.globalAlpha = Math.min(1, s.frame.visibility);
        g.strokeStyle = "rgba(244, 248, 255, 0.96)";
        g.lineWidth = 2 * dpr;
        g.lineCap = "butt";
        g.beginPath();
        for (const [a, b] of bracketSegments(q, s.frame.arm)) {
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        g.stroke();
        g.restore();
      }

      for (const l of s.loupes) {
        if (l.visibility <= 0.01) continue;
        const c = px(l.center);
        const r = l.radius * stage.h;
        g.save();
        g.globalAlpha = Math.min(1, l.visibility);
        g.beginPath();
        g.arc(c.x, c.y, r, 0, Math.PI * 2);
        g.clip();
        // Magnify about the loupe's centre.
        g.translate(c.x, c.y);
        g.scale(l.zoom, l.zoom);
        g.translate(-c.x, -c.y);
        paintTreated();
        g.restore();
        g.save();
        g.globalAlpha = Math.min(1, l.visibility);
        g.strokeStyle = "rgba(244, 248, 255, 0.96)";
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        g.arc(c.x, c.y, r, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }

      overlay.draw(tr, { width: W, height: H, dpr, stage, time: now });
      if (!reduced) raf = requestAnimationFrame(draw);
    };

    if (reduced) {
      // One still picture: run the script up to a moment where the frame is open, then draw it.
      const at = 5200;
      for (let t = 0; t <= at; t += TRACK_INTERVAL_MS) track(t);
      lastTrack = at;
      last = at - 16;
      draw(at);
      const redraw = () => draw(at);
      window.addEventListener("resize", redraw);
      return () => window.removeEventListener("resize", redraw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <canvas ref={picture} aria-hidden />
      <canvas ref={trackers} aria-hidden />
    </>
  );
}

// ── The classic portal ──────────────────────────────────────────────────────

/** The same synthetic hands the classic demo uses, framing a portal whose grid is projected with the real homography. */
function PortalIntro() {
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
