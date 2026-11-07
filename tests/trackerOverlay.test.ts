import { describe, expect, it } from "vitest";
import {
  alignStroke,
  dashSegments,
  FINGERTIPS,
  formatCaption,
  formatCountdown,
  formatFaceLabel,
  formatTipLabel,
  formatZoom,
  hairlineWidth,
  TRACKER_STYLE,
  TrackerOverlay,
  type TrackerContext2D,
  type TrackerView,
} from "../src/render/TrackerOverlay";
import type { TrackerHand, TrackerScene } from "../src/toy/types";
import { framePose, syntheticHand } from "../src/tracking/syntheticHand";

// ── A recording stand-in for the 2D context ──────────────────────────────────

interface PathOp {
  op: "moveTo" | "lineTo" | "rect" | "arc";
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  from?: number;
  to?: number;
}

/** One thing that reached the canvas, with the state it was painted in. */
interface Call {
  op: "clearRect" | "stroke" | "fill" | "fillRect" | "fillText";
  alpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  path: PathOp[];
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const fontSize = (font: string) => Number(/([\d.]+)px/.exec(font)?.[1] ?? 10);

function recorder() {
  const calls: Call[] = [];
  const saved: Partial<TrackerContext2D>[] = [];
  let path: PathOp[] = [];
  const log = (op: Call["op"], extra: Partial<Call> = {}) =>
    calls.push({
      op,
      alpha: ctx.globalAlpha,
      fillStyle: String(ctx.fillStyle),
      strokeStyle: String(ctx.strokeStyle),
      lineWidth: ctx.lineWidth,
      font: ctx.font,
      textAlign: ctx.textAlign,
      path: [],
      text: "",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      ...extra,
    });
  const ctx: TrackerContext2D = {
    globalAlpha: 1,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    save() {
      const { globalAlpha, fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, font, textAlign, textBaseline } = ctx;
      saved.push({ globalAlpha, fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, font, textAlign, textBaseline });
    },
    restore() {
      Object.assign(ctx, saved.pop());
    },
    setTransform() {},
    setLineDash() {},
    clearRect(x: number, y: number, w: number, h: number) {
      log("clearRect", { x, y, w, h });
    },
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push({ op: "moveTo", x, y });
    },
    lineTo(x: number, y: number) {
      path.push({ op: "lineTo", x, y });
    },
    rect(x: number, y: number, w: number, h: number) {
      path.push({ op: "rect", x, y, w, h });
    },
    arc(x: number, y: number, r: number, from: number, to: number) {
      path.push({ op: "arc", x, y, r, from, to });
    },
    stroke() {
      log("stroke", { path: path.slice() });
    },
    fill() {
      log("fill", { path: path.slice() });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      log("fillRect", { x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      log("fillText", { text, x, y });
    },
    // A monospace face: every glyph is 0.6 em wide, like JetBrains Mono.
    measureText(text: string) {
      return { width: text.length * Math.round(fontSize(ctx.font) * 0.6) };
    },
  };
  const canvas = { width: 300, height: 150, getContext: (id: string) => (id === "2d" ? ctx : null) };
  return { calls, ctx, canvas, saved };
}

function setup() {
  const rec = recorder();
  return { ...rec, overlay: new TrackerOverlay(rec.canvas) };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const S = TRACKER_STYLE;
const SPACE = { w: 1280, h: 720 };
const BLUE = "#4a9eff";
const VIOLET = "#8c66ff";

/** A tracker hand with the landmark layout of the project's synthetic hand; an open palm unless told otherwise. */
function hand(role: "A" | "B", o: Partial<TrackerHand> = {}): TrackerHand {
  return {
    role,
    side: role === "A" ? "L" : "R",
    fresh: true,
    points: syntheticHand(framePose(role), 16 / 9).points.map((p) => ({ x: p.x, y: p.y })),
    pose: "palm",
    speedPx: 0,
    engaged: false,
    hold: 0,
    debugText: null,
    ...o,
  };
}

const scene = (o: Partial<TrackerScene> = {}): TrackerScene => ({
  enabled: true,
  debug: false,
  space: SPACE,
  hands: [],
  face: null,
  frameTag: null,
  loupes: [],
  countdown: null,
  ...o,
});

/** A 1280×720 canvas that is all stage, at dpr 1: canvas px equal label px. */
const view = (o: Partial<TrackerView> = {}): TrackerView => ({
  width: 1280,
  height: 720,
  dpr: 1,
  stage: { x: 0, y: 0, w: 1280, h: 720 },
  time: 0,
  ...o,
});

/** A stage point given in label pixels. */
const at = (x: number, y: number) => ({ x: x / SPACE.w, y: y / SPACE.h });

const texts = (calls: Call[]) => calls.filter((c) => c.op === "fillText" && c.fillStyle === S.text);
const shadows = (calls: Call[]) => calls.filter((c) => c.op === "fillText" && c.fillStyle === S.textShadow);
const textOf = (calls: Call[], pattern: RegExp) => texts(calls).filter((c) => pattern.test(c.text));
const strokes = (calls: Call[], style: string) => calls.filter((c) => c.op === "stroke" && c.strokeStyle === style);
const fills = (calls: Call[], style: string) => calls.filter((c) => c.op === "fill" && c.fillStyle === style);
const arcs = (c: Call) => c.path.filter((p) => p.op === "arc");
const rects = (c: Call) => c.path.filter((p) => p.op === "rect");
/** The alpha written inside an rgba() colour. */
const cssAlpha = (color: string) => Number(/,\s*([\d.]+)\)$/.exec(color)?.[1] ?? 1);

/** Straight segments of a path: every moveTo that is followed by a lineTo. */
function segments(c: Call) {
  const out: { x0: number; y0: number; x1: number; y1: number; length: number }[] = [];
  c.path.forEach((p, i) => {
    const q = c.path[i + 1];
    if (p.op === "moveTo" && q?.op === "lineTo") out.push({ x0: p.x, y0: p.y, x1: q.x, y1: q.y, length: Math.hypot(q.x - p.x, q.y - p.y) });
  });
  return out;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("label text", () => {
  it("formats a fingertip label like the reference: side, two-digit landmark, integer x,y", () => {
    expect(formatTipLabel("L", 8, 599, 131)).toBe("L08 599,131");
    expect(formatTipLabel("R", 4, 902.4, 387.6)).toBe("R04 902,388");
    expect(formatTipLabel("R", 20, 0, 0)).toBe("R20 0,0");
  });

  it("keeps a fingertip that left the picture readable", () => {
    expect(formatTipLabel("L", 12, -14.2, 733.5)).toBe("L12 -14,734");
    expect(formatTipLabel("L", 8, -0.2, Number.NaN)).toBe("L08 0,0");
  });

  it("writes the wrist caption as side word, palm speed and pose", () => {
    expect(formatCaption("R", 23.4, "L")).toBe("right · 23 px/s · L");
    expect(formatCaption("L", 0, "fist")).toBe("left · 0 px/s · fist");
    expect(formatCaption("L", 311.6, "OK")).toBe("left · 312 px/s · OK");
    expect(formatCaption("R", 140, "point")).toBe("right · 140 px/s · point");
  });

  it("leaves the pose out while none is named, and never shows a negative or broken speed", () => {
    expect(formatCaption("L", 12, null)).toBe("left · 12 px/s");
    expect(formatCaption("R", -3, "L")).toBe("right · 0 px/s · L");
    expect(formatCaption("R", Number.NaN, "L")).toBe("right · 0 px/s · L");
  });

  it("labels the face with its width, the loupe with its zoom and the countdown with whole seconds", () => {
    expect(formatFaceLabel(165.2)).toBe("face  165px");
    expect(formatZoom(2)).toBe("×2.0");
    expect(formatZoom(1.5)).toBe("×1.5");
    expect(formatCountdown(3)).toBe("3");
    expect(formatCountdown(2.4)).toBe("3");
    expect(formatCountdown(0.01)).toBe("1");
    expect(formatCountdown(0)).toBe("");
    expect(formatCountdown(-1)).toBe("");
    expect(formatCountdown(null)).toBe("");
  });

  it("puts labels and reticles on the five fingertips", () => {
    expect([...FINGERTIPS]).toEqual([4, 8, 12, 16, 20]);
  });
});

describe("hairlines", () => {
  it("are whole device pixels wide and never thinner than one", () => {
    expect(hairlineWidth(1)).toBe(1);
    expect(hairlineWidth(1.25)).toBe(1);
    expect(hairlineWidth(1.5)).toBe(1);
    expect(hairlineWidth(2)).toBe(2);
    expect(hairlineWidth(0.8)).toBe(1);
  });

  it("sit on half pixels when their width is odd and on whole pixels when it is even", () => {
    expect(alignStroke(10.3, 1)).toBe(10.5);
    expect(alignStroke(10.9, 1)).toBe(10.5);
    expect(alignStroke(10.3, 2)).toBe(10);
    expect(alignStroke(10.7, 2)).toBe(11);
    expect(alignStroke(10.7, 3)).toBe(10.5);
  });
});

describe("dashSegments", () => {
  const pairs = (length: number, capacity = 256) => {
    const out = new Float64Array(capacity * 2);
    const n = dashSegments(length, 4, 6, out);
    return Array.from({ length: n }, (_, i) => [out[i * 2], out[i * 2 + 1]]);
  };

  it("starts and ends with a full dash, so every corner of a box looks the same", () => {
    expect(pairs(14)).toEqual([
      [0, 4],
      [10, 14],
    ]);
    const side = pairs(166);
    expect(side[0]).toEqual([0, 4]);
    expect(side[1]).toEqual([10, 14]);
    expect(side[side.length - 1]).toEqual([162, 166]);
  });

  it("keeps every dash whole and every gap at least the nominal one, for any side length", () => {
    for (let length = 14; length <= 420; length++) {
      const side = pairs(length);
      expect(side[0][0], `start of ${length}`).toBe(0);
      expect(side[side.length - 1][1], `end of ${length}`).toBe(length);
      for (let i = 0; i < side.length; i++) {
        expect(side[i][1] - side[i][0], `dash ${i} of ${length}`).toBe(4);
        expect(Number.isInteger(side[i][0])).toBe(true);
        if (i > 0) {
          const gap = side[i][0] - side[i - 1][1];
          expect(gap, `gap ${i} of ${length}`).toBeGreaterThanOrEqual(6);
          expect(gap, `gap ${i} of ${length}`).toBeLessThan(16);
        }
      }
    }
  });

  it("is symmetric about the middle of the side", () => {
    for (const length of [14, 57, 166, 217, 400]) {
      const side = pairs(length);
      const mirrored = side.map(([a, b]) => [length - b, length - a]).reverse();
      side.forEach(([a, b], i) => {
        expect(Math.abs(a - mirrored[i][0]), `${length}`).toBeLessThanOrEqual(1);
        expect(Math.abs(b - mirrored[i][1]), `${length}`).toBeLessThanOrEqual(1);
      });
    }
  });

  it("draws a side that is too short for two dashes, or too long for the buffer, solid", () => {
    expect(pairs(10)).toEqual([[0, 10]]);
    expect(pairs(166, 4)).toEqual([[0, 166]]);
    expect(pairs(0)).toEqual([]);
    expect(pairs(-5)).toEqual([]);
  });
});

// ── Drawing ──────────────────────────────────────────────────────────────────

describe("TrackerOverlay canvas handling", () => {
  it("sizes the canvas to the view and clears all of it before drawing", () => {
    const { overlay, calls, canvas } = setup();
    overlay.draw(scene(), view());
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "clearRect", x: 0, y: 0, w: 1280, h: 720 });
  });

  it("resizes only when the size really changes, and clears on request", () => {
    const { overlay, calls, canvas } = setup();
    let writes = 0;
    let width = 300;
    Object.defineProperty(canvas, "width", {
      get: () => width,
      set: (v: number) => {
        width = v;
        writes++;
      },
    });
    overlay.resize(640, 360);
    overlay.resize(640, 360);
    overlay.resize(640.2, 360);
    expect([canvas.width, canvas.height, writes]).toEqual([640, 360, 1]);
    overlay.clear();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "clearRect", x: 0, y: 0, w: 640, h: 360 });
  });

  it("hands the shared context back in the state it found it", () => {
    const { overlay, ctx, saved } = setup();
    const a = hand("A", { pose: "L", engaged: true, hold: 0.5 });
    overlay.draw(scene({ hands: [a], countdown: 2 }), view());
    expect(saved).toHaveLength(0);
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.font).toBe("10px sans-serif");
    expect(ctx.textAlign).toBe("start");
    expect(ctx.fillStyle).toBe("#000000");
    expect(ctx.lineWidth).toBe(1);
  });

  it("does nothing, quietly, on a canvas that has no 2D context", () => {
    const overlay = new TrackerOverlay({ width: 1, height: 1, getContext: () => null });
    expect(() => {
      overlay.draw(scene({ hands: [hand("A")] }), view());
      overlay.clear();
    }).not.toThrow();
  });
});

describe("TrackerOverlay hands", () => {
  it("labels the five fingertips of each hand in the reference's format", () => {
    const { overlay, calls } = setup();
    const a = hand("A");
    a.points[8] = at(599, 131);
    const b = hand("B");
    b.points[4] = at(902, 388);
    overlay.draw(scene({ hands: [a, b] }), view());

    const drawn = texts(calls).map((c) => c.text);
    expect(drawn).toContain("L08 599,131");
    expect(drawn).toContain("R04 902,388");
    expect(drawn.filter((t) => t.startsWith("L")).map((t) => t.slice(0, 3))).toEqual(["L04", "L08", "L12", "L16", "L20"]);
    expect(drawn.filter((t) => t.startsWith("R")).map((t) => t.slice(0, 3))).toEqual(["R04", "R08", "R12", "R16", "R20"]);
    for (const t of drawn) expect(t).toMatch(/^[LR]\d\d \d+,\d+$/);
  });

  it("puts each label 13 px right of and 7 px above its fingertip, on whole pixels", () => {
    const { overlay, calls } = setup();
    const a = hand("A");
    a.points[8] = at(599.4, 131.4);
    overlay.draw(scene({ hands: [a] }), view());
    const label = textOf(calls, /^L08 /)[0];
    expect(label.text).toBe("L08 599,131");
    expect([label.x, label.y]).toEqual([599 + 13, 131 - 7]);
    expect(label.textAlign).toBe("left");
  });

  it("draws all type twice in JetBrains Mono: a dark copy one pixel down, then the text", () => {
    const { overlay, calls } = setup();
    overlay.draw(scene({ hands: [hand("A"), hand("B", { pose: "L", engaged: true })] }), view());
    const main = texts(calls);
    const dark = shadows(calls);
    expect(main).toHaveLength(11);
    expect(dark.map((c) => [c.text, c.x, c.y - 1])).toEqual(main.map((c) => [c.text, c.x, c.y]));
    // Every dark copy is down before the first label, so none of them can smudge a neighbouring label.
    expect(calls.indexOf(dark[dark.length - 1])).toBeLessThan(calls.indexOf(main[0]));
    expect(S.text).toBe("rgba(233, 237, 247, 0.92)");
    expect(S.textShadow).toBe("rgba(5, 6, 10, 0.6)");
    for (const c of main) expect(c.font).toBe('500 10px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace');
  });

  it("draws the skeleton as one hairline path and a dot on each of the 21 joints", () => {
    const { overlay, calls } = setup();
    const a = hand("A");
    overlay.draw(scene({ hands: [a] }), view());

    const [skeleton] = strokes(calls, "rgba(232, 242, 255, 0.6)");
    expect(skeleton.lineWidth).toBe(1);
    expect(segments(skeleton)).toHaveLength(21);
    expect(skeleton.path[0]).toEqual({ op: "moveTo", x: a.points[0].x * 1280, y: a.points[0].y * 720 });

    const [dots] = fills(calls, "rgba(240, 246, 255, 0.92)");
    expect(arcs(dots)).toHaveLength(21);
    arcs(dots).forEach((d, i) => {
      expect(d.r).toBe(1.8);
      expect(d.x).toBeCloseTo(a.points[i].x * 1280, 9);
      expect(d.y).toBeCloseTo(a.points[i].y * 720, 9);
    });
    // Each dot is its own sub-path: without the moveTo the dots would be joined by lines.
    expect(dots.path.filter((p) => p.op === "moveTo")).toHaveLength(21);
  });

  it("gives reticles and a wrist caption to engaged hands only: an open palm gets neither", () => {
    const { overlay, calls } = setup();
    const l = hand("A", { pose: "L", engaged: true, speedPx: 23.4 });
    const palm = hand("B", { pose: "palm", engaged: false, speedPx: 80 });
    overlay.draw(scene({ hands: [l, palm] }), view());

    expect(strokes(calls, BLUE)).toHaveLength(1);
    expect(rects(strokes(calls, BLUE)[0])).toHaveLength(5);
    expect(strokes(calls, VIOLET)).toHaveLength(0);
    expect(fills(calls, "#ffffff")).toHaveLength(1);

    expect(textOf(calls, /px\/s/).map((c) => c.text)).toEqual(["left · 23 px/s · L"]);

    // The palm keeps all 21 joint dots; on the engaged hand the reticle's own dot marks the fingertips.
    const [engagedDots, palmDots] = fills(calls, S.joint);
    expect(arcs(engagedDots)).toHaveLength(16);
    expect(arcs(palmDots)).toHaveLength(21);
  });

  it("draws each reticle as a 16 px square with four 5 px ticks through its sides and a white centre dot", () => {
    const { overlay, calls } = setup();
    const l = hand("A", { pose: "L", engaged: true });
    overlay.draw(scene({ hands: [l] }), view());

    const [reticles] = strokes(calls, BLUE);
    expect(reticles.alpha).toBeCloseTo(0.85, 9);
    expect(reticles.lineWidth).toBe(1);
    const squares = rects(reticles);
    const ticks = segments(reticles);
    expect(ticks).toHaveLength(20);
    const pips = arcs(fills(calls, "#ffffff")[0]);
    expect(pips).toHaveLength(5);

    FINGERTIPS.forEach((landmark, k) => {
      const sq = squares[k];
      expect([sq.w, sq.h]).toEqual([16, 16]);
      const cx = sq.x + 8;
      const cy = sq.y + 8;
      // Centred on the fingertip, to the pixel the fingertip is in.
      expect(Math.abs(cx - l.points[landmark].x * 1280)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(cy - l.points[landmark].y * 720)).toBeLessThanOrEqual(0.5);
      expect(pips[k]).toMatchObject({ x: cx, y: cy, r: 1.25 });

      const mids = ticks.slice(k * 4, k * 4 + 4).map((t) => {
        expect(t.length).toBe(5);
        return [(t.x0 + t.x1) / 2 - cx, (t.y0 + t.y1) / 2 - cy];
      });
      expect(mids).toEqual([
        [-8, 0],
        [8, 0],
        [0, -8],
        [0, 8],
      ]);
    });
  });

  it("colours a hand's reticles by its role: A blue, B violet", () => {
    const { overlay, calls } = setup();
    overlay.draw(scene({ hands: [hand("A", { pose: "point", engaged: true }), hand("B", { pose: "OK", engaged: true })] }), view());
    expect(strokes(calls, BLUE)).toHaveLength(1);
    expect(strokes(calls, VIOLET)).toHaveLength(1);
    expect(textOf(calls, /px\/s/).map((c) => c.text)).toEqual(["left · 0 px/s · point", "right · 0 px/s · OK"]);
  });

  it("centres the caption 48 px under the wrist", () => {
    const { overlay, calls } = setup();
    const l = hand("B", { pose: "L", engaged: true, speedPx: 23 });
    overlay.draw(scene({ hands: [l] }), view());
    const caption = textOf(calls, /px\/s/)[0];
    expect(caption.text).toBe("right · 23 px/s · L");
    const width = caption.text.length * 6;
    expect(Math.abs(caption.x + width / 2 - l.points[0].x * 1280)).toBeLessThanOrEqual(0.5);
    expect(caption.y).toBe(Math.round(l.points[0].y * 720 + 48));
  });

  it("keeps the caption on the picture when the wrist is at the bottom edge, and lets it go when the wrist has left", () => {
    const { overlay, calls } = setup();
    const l = hand("A", { pose: "L", engaged: true });
    l.points[0] = at(400, 700);
    overlay.draw(scene({ hands: [l] }), view());
    expect(textOf(calls, /px\/s/)[0].y).toBe(713);

    calls.length = 0;
    l.points[0] = at(400, 900);
    overlay.draw(scene({ hands: [l] }), view());
    expect(textOf(calls, /px\/s/)[0].y).toBeGreaterThan(720);
  });

  it("draws a coasting hand at half strength: the skeleton drops from 0.6 to 0.3", () => {
    const { overlay, calls } = setup();
    const fresh = hand("A", { pose: "L", engaged: true });
    const coasting = hand("B", { pose: "L", engaged: true, fresh: false });
    overlay.draw(scene({ hands: [fresh, coasting] }), view());

    const [skeletonA, skeletonB] = strokes(calls, S.skeleton);
    expect(skeletonA.alpha * cssAlpha(S.skeleton)).toBeCloseTo(0.6, 9);
    expect(skeletonB.alpha * cssAlpha(S.skeleton)).toBeCloseTo(0.3, 9);
    expect(fills(calls, S.joint).map((c) => c.alpha)).toEqual([1, 0.5]);
    expect(strokes(calls, BLUE)[0].alpha).toBeCloseTo(0.85, 9);
    expect(strokes(calls, VIOLET)[0].alpha).toBeCloseTo(0.425, 9);
    for (const c of textOf(calls, /^L|^left/)) expect(c.alpha).toBe(1);
    for (const c of textOf(calls, /^R|^right/)) expect(c.alpha).toBe(0.5);
    expect(textOf(calls, /^R|^right/)).toHaveLength(6);
  });

  it("maps stage points through the stage rect, while labels stay in camera pixels", () => {
    const { overlay, calls } = setup();
    const a = hand("A", { pose: "L", engaged: true });
    a.points[0] = { x: 0.5, y: 0.5 };
    a.points[8] = at(599.4, 131.4);
    const stage = { x: 100, y: 50, w: 640, h: 360 };
    overlay.draw(scene({ hands: [a] }), view({ width: 840, height: 460, stage }));

    expect(strokes(calls, S.skeleton)[0].path[0]).toEqual({ op: "moveTo", x: 420, y: 230 });
    expect(arcs(fills(calls, S.joint)[0])[0]).toMatchObject({ x: 420, y: 230 });

    // The index tip is at 100 + 599.4 / 2 = 399.7, 50 + 131.4 / 2 = 115.7 on this canvas.
    const label = textOf(calls, /^L08 /)[0];
    expect(label.text).toBe("L08 599,131");
    expect([label.x, label.y]).toEqual([399 + 13, 115 - 7]);
    const square = rects(strokes(calls, BLUE)[0])[1];
    expect([square.x + 8, square.y + 8]).toEqual([399.5, 115.5]);

    const caption = textOf(calls, /px\/s/)[0];
    expect(caption.y).toBe(230 + 48);
    expect(caption.x + (caption.text.length * 6) / 2).toBe(420);
  });

  it("shows the debug readout under the caption only in debug mode", () => {
    const { overlay, calls } = setup();
    const a = hand("A", { pose: "L", engaged: true, debugText: "phi 111 curl 81 53 40\ncPalm 0.77 cL -0.93" });
    const palm = hand("B", { debugText: "phi 46" });
    overlay.draw(scene({ debug: true, hands: [a, palm] }), view());

    const caption = textOf(calls, /^left/)[0];
    const lines = textOf(calls, /phi 111|cPalm/);
    expect(lines.map((c) => c.text)).toEqual(["phi 111 curl 81 53 40", "cPalm 0.77 cL -0.93"]);
    expect(lines.map((c) => c.y)).toEqual([caption.y + 13, caption.y + 26]);
    expect(lines[0].x).toBe(lines[1].x);
    // A hand without a caption keeps the caption's row free, so its readout sits at the same height.
    const palmLine = textOf(calls, /^phi 46$/)[0];
    expect(palmLine.y).toBe(Math.round(palm.points[0].y * 720 + 48) + 13);

    calls.length = 0;
    overlay.draw(scene({ debug: false, hands: [a, palm] }), view());
    expect(textOf(calls, /phi|cPalm/)).toHaveLength(0);
    expect(textOf(calls, /^left/)).toHaveLength(1);
  });
});

describe("TrackerOverlay label refresh", () => {
  it("rebuilds label strings at 10 Hz while their positions follow every frame", () => {
    const { overlay, calls } = setup();
    const a = hand("A");
    a.points[8] = at(599.4, 131.4);
    overlay.draw(scene({ hands: [a] }), view({ time: 1000 }));
    expect(textOf(calls, /^L08 /)[0].text).toBe("L08 599,131");

    calls.length = 0;
    a.points[8] = at(640.4, 131.4);
    overlay.draw(scene({ hands: [a] }), view({ time: 1050 }));
    let label = textOf(calls, /^L08 /)[0];
    expect(label.text).toBe("L08 599,131");
    expect(label.x).toBe(640 + 13);

    calls.length = 0;
    overlay.draw(scene({ hands: [a] }), view({ time: 1100 }));
    label = textOf(calls, /^L08 /)[0];
    expect(label.text).toBe("L08 640,131");
    expect(label.x).toBe(640 + 13);
  });

  it("refreshes each hand on its own clock", () => {
    const { overlay, calls } = setup();
    const a = hand("A");
    a.points[8] = at(100.4, 100.4);
    overlay.draw(scene({ hands: [a] }), view({ time: 0 }));
    // Hand B arrives 60 ms later and is labelled at once.
    const b = hand("B");
    b.points[8] = at(900.4, 100.4);
    a.points[8] = at(200.4, 100.4);
    calls.length = 0;
    overlay.draw(scene({ hands: [a, b] }), view({ time: 60 }));
    expect(textOf(calls, /^L08 /)[0].text).toBe("L08 100,100");
    expect(textOf(calls, /^R08 /)[0].text).toBe("R08 900,100");

    b.points[8] = at(950.4, 100.4);
    calls.length = 0;
    overlay.draw(scene({ hands: [a, b] }), view({ time: 100 }));
    expect(textOf(calls, /^L08 /)[0].text).toBe("L08 200,100");
    expect(textOf(calls, /^R08 /)[0].text).toBe("R08 900,100");
  });

  it("shows a new pose in the caption at once, because that is the confirmation the user waits for", () => {
    const { overlay, calls } = setup();
    const a = hand("A", { pose: "point", engaged: true, speedPx: 12 });
    overlay.draw(scene({ hands: [a] }), view({ time: 0 }));
    expect(textOf(calls, /px\/s/)[0].text).toBe("left · 12 px/s · point");

    calls.length = 0;
    a.pose = "L";
    a.speedPx = 40;
    overlay.draw(scene({ hands: [a] }), view({ time: 16 }));
    expect(textOf(calls, /px\/s/)[0].text).toBe("left · 40 px/s · L");

    // The speed alone waits for the next refresh.
    calls.length = 0;
    a.speedPx = 90;
    overlay.draw(scene({ hands: [a] }), view({ time: 32 }));
    expect(textOf(calls, /px\/s/)[0].text).toBe("left · 40 px/s · L");
    calls.length = 0;
    overlay.draw(scene({ hands: [a] }), view({ time: 100 }));
    expect(textOf(calls, /px\/s/)[0].text).toBe("left · 90 px/s · L");
  });

  it("captions a hand the moment it becomes engaged and drops the caption the moment it opens", () => {
    const { overlay, calls } = setup();
    const a = hand("A");
    overlay.draw(scene({ hands: [a] }), view({ time: 0 }));
    expect(textOf(calls, /px\/s/)).toHaveLength(0);

    calls.length = 0;
    Object.assign(a, { pose: "fist", engaged: true });
    overlay.draw(scene({ hands: [a] }), view({ time: 16 }));
    expect(textOf(calls, /px\/s/).map((c) => c.text)).toEqual(["left · 0 px/s · fist"]);

    calls.length = 0;
    Object.assign(a, { pose: "palm", engaged: false });
    overlay.draw(scene({ hands: [a] }), view({ time: 32 }));
    expect(textOf(calls, /px\/s/)).toHaveLength(0);
    expect(strokes(calls, BLUE)).toHaveLength(0);
  });

  it("relabels a slot at once when another hand takes it", () => {
    const { overlay, calls } = setup();
    overlay.draw(scene({ hands: [hand("A"), hand("B")] }), view({ time: 0 }));
    calls.length = 0;
    // Hand A is lost: B is now the first hand in the list.
    overlay.draw(scene({ hands: [hand("B")] }), view({ time: 16 }));
    const drawn = texts(calls).map((c) => c.text);
    expect(drawn).toHaveLength(5);
    for (const t of drawn) expect(t).toMatch(/^R/);
  });
});

describe("TrackerOverlay face, frame tag and loupe", () => {
  it("labels the face box with its width in camera pixels, 6 px above its top-left corner", () => {
    const { overlay, calls } = setup();
    const face = { x: 512.3 / 1280, y: 144.3 / 720, w: 165.2 / 1280, h: 216 / 720, score: 0.9, alpha: 1 };
    overlay.draw(scene({ face }), view());
    const label = textOf(calls, /^face/)[0];
    expect(label.text).toBe("face  165px");
    expect([label.x, label.y]).toEqual([512, 144 - 6]);
  });

  it("draws the face box as a dashed hairline with a full dash in every corner", () => {
    const { overlay, calls } = setup();
    const face = { x: 512.3 / 1280, y: 144.3 / 720, w: 165.2 / 1280, h: 216 / 720, score: 0.9, alpha: 1 };
    overlay.draw(scene({ face }), view());

    const [box] = strokes(calls, "rgba(232, 242, 255, 0.5)");
    expect(box.lineWidth).toBe(1);
    const dashes = segments(box);
    for (const d of dashes) {
      expect(d.length).toBe(4);
      expect(d.x0 === d.x1 || d.y0 === d.y1).toBe(true);
    }
    // The box runs from pixel 512 to pixel 677 across and 144 to 360 down; its lines are centred in those pixels.
    const top = dashes.filter((d) => d.y0 === 144.5 && d.y1 === 144.5).sort((p, q) => p.x0 - q.x0);
    const left = dashes.filter((d) => d.x0 === 512.5 && d.x1 === 512.5).sort((p, q) => p.y0 - q.y0);
    expect([top[0].x0, top[top.length - 1].x1]).toEqual([512, 678]);
    expect([left[0].y0, left[left.length - 1].y1]).toEqual([144, 361]);
    expect(dashes.filter((d) => d.y0 === 360.5 && d.y1 === 360.5)).toHaveLength(top.length);
    expect(dashes.filter((d) => d.x0 === 677.5 && d.x1 === 677.5)).toHaveLength(left.length);
    for (let i = 1; i < top.length; i++) expect(top[i].x0 - top[i - 1].x1).toBeGreaterThanOrEqual(6);
  });

  it("fades the face box and its label together, and draws neither without a face", () => {
    const { overlay, calls } = setup();
    const face = { x: 0.4, y: 0.2, w: 0.13, h: 0.3, score: 0.9, alpha: 0.4 };
    overlay.draw(scene({ face }), view());
    expect(strokes(calls, S.faceLine)[0].alpha).toBe(0.4);
    expect(textOf(calls, /^face/)[0].alpha).toBe(0.4);

    calls.length = 0;
    overlay.draw(scene({ face: { ...face, alpha: 0 } }), view());
    expect(calls.filter((c) => c.op !== "clearRect")).toHaveLength(0);
  });

  it("tags the frame 9 px right of and 20 px above its first corner, the text one cell in from the label below", () => {
    const { overlay, calls } = setup();
    const frameTag = { at: at(320.4, 180.4), text: "anime · rose", tone: "live" as const, swatch: "#F7B4C6" };
    overlay.draw(scene({ frameTag }), view());

    const label = textOf(calls, /anime/)[0];
    expect(label.text).toBe("anime · rose");
    expect([label.x, label.y]).toEqual([320 + 9 + 10, 180 - 20]);

    // A 5 px dot sitting on the baseline, its left edge 9 px right of the corner.
    const [toneDot] = fills(calls, BLUE);
    expect(arcs(toneDot)).toEqual([{ op: "arc", x: 320 + 9 + 2.5, y: 160 - 2.5, r: 2.5, from: 0, to: Math.PI * 2 }]);

    // The swatch follows the text by one character cell.
    const swatches = calls.filter((c) => c.op === "fillRect");
    expect(swatches).toHaveLength(1);
    expect(swatches[0]).toMatchObject({ fillStyle: "#F7B4C6", x: 339 + 12 * 6 + 6, y: 155, w: 5, h: 5 });

    // Dot and swatch get the same dark copy as the type, one pixel down.
    const [dark] = fills(calls, S.textShadow);
    expect(arcs(dark)[0]).toMatchObject({ x: 331.5, y: 158.5, r: 2.5 });
    expect(rects(dark)[0]).toMatchObject({ x: 417, y: 156, w: 5, h: 5 });
    expect(calls.indexOf(dark)).toBeLessThan(calls.indexOf(toneDot));
  });

  it("colours the tag's dot by the state of the anime stream and leaves the swatch out when there is none", () => {
    const tones = [
      ["live", "#4a9eff"],
      ["busy", "#8c66ff"],
      ["camera", "#a4acc2"],
    ] as const;
    for (const [tone, colour] of tones) {
      const { overlay, calls } = setup();
      overlay.draw(scene({ frameTag: { at: { x: 0.25, y: 0.25 }, text: "rose", tone, swatch: null } }), view());
      expect(fills(calls, colour), tone).toHaveLength(1);
      expect(calls.filter((c) => c.op === "fillRect"), tone).toHaveLength(0);
      expect(textOf(calls, /^rose$/), tone).toHaveLength(1);
    }
  });

  it("labels a visible loupe with its zoom at 45° outside the ring", () => {
    const { overlay, calls } = setup();
    const loupe = { handId: 2, center: { x: 0.5, y: 0.5 }, radius: 0.1, zoom: 2, visibility: 0.5 };
    overlay.draw(scene({ loupes: [loupe, { ...loupe, center: { x: 0.2, y: 0.2 }, visibility: 0 }] }), view());

    const labels = textOf(calls, /×/);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("×2.0");
    expect(labels[0].alpha).toBe(0.5);
    // The radius is 0.1 frame heights = 72 px; the label starts 7 px beyond it, up and to the right.
    const reach = (72 + 7) * Math.SQRT1_2;
    expect([labels[0].x, labels[0].y]).toEqual([Math.round(640 + reach), Math.round(360 - reach)]);
    expect(Math.hypot(labels[0].x - 640, labels[0].y - 360)).toBeGreaterThan(72);
  });
});

describe("TrackerOverlay hold ring and countdown", () => {
  const busyScene = (enabled: boolean) =>
    scene({
      enabled,
      debug: true,
      hands: [hand("A", { pose: "fist", engaged: true, hold: 0.5, debugText: "phi 20" }), hand("B")],
      face: { x: 0.4, y: 0.2, w: 0.13, h: 0.3, score: 0.9, alpha: 1 },
      frameTag: { at: { x: 0.3, y: 0.3 }, text: "rose", tone: "camera", swatch: "#F7B4C6" },
      loupes: [{ handId: 2, center: { x: 0.5, y: 0.5 }, radius: 0.1, zoom: 2, visibility: 1 }],
      countdown: 2.4,
    });

  it("draws nothing but the hold ring and the countdown when the trackers are off", () => {
    const { overlay, calls } = setup();
    overlay.draw(busyScene(false), view());
    const drawn = calls.filter((c) => c.op !== "clearRect");
    expect(drawn.map((c) => c.op)).toEqual(["stroke", "stroke", "fillText", "fillText"]);
    expect(drawn[0].strokeStyle).toBe("rgba(255, 255, 255, 0.18)");
    expect(drawn[1].strokeStyle).toBe(BLUE);
    expect(drawn[2].text).toBe("3");
    expect(drawn[3].text).toBe("3");
  });

  it("draws the same ring and countdown, plus everything else, when the trackers are on", () => {
    const off = setup();
    off.overlay.draw(busyScene(false), view());
    const on = setup();
    on.overlay.draw(busyScene(true), view());

    const ring = (calls: Call[]) =>
      calls
        .filter((c) => c.op === "stroke" && arcs(c).length === 1 && c.lineWidth === 3)
        .map(({ strokeStyle, alpha, path }) => ({ strokeStyle, alpha, path }));
    const digits = (calls: Call[]) =>
      calls.filter((c) => c.text === "3").map(({ fillStyle, alpha, font, x, y }) => ({ fillStyle, alpha, font, x, y }));
    expect(ring(off.calls)).toHaveLength(2);
    expect(ring(on.calls)).toEqual(ring(off.calls));
    expect(digits(off.calls)).toHaveLength(2);
    expect(digits(on.calls)).toEqual(digits(off.calls));
    expect(strokes(on.calls, S.skeleton)).toHaveLength(2);
    expect(textOf(on.calls, /^face|^rose$|×2\.0|px\/s|^phi 20$/)).toHaveLength(5);
  });

  it("draws the hold ring at the palm in the classic ring style, filling clockwise from the top", () => {
    const { overlay, calls } = setup();
    const fist = hand("B", { pose: "fist", engaged: true, hold: 0.25 });
    overlay.draw(scene({ enabled: false, hands: [fist] }), view());

    const palm = [0, 5, 9, 13, 17].reduce((s, i) => ({ x: s.x + fist.points[i].x / 5, y: s.y + fist.points[i].y / 5 }), { x: 0, y: 0 });
    const [track, progress] = calls.filter((c) => c.op === "stroke");
    for (const c of [track, progress]) {
      expect(c.lineWidth).toBe(3);
      expect(arcs(c)).toHaveLength(1);
      expect(arcs(c)[0].r).toBe(22);
      expect(arcs(c)[0].x).toBeCloseTo(palm.x * 1280, 6);
      expect(arcs(c)[0].y).toBeCloseTo(palm.y * 720, 6);
    }
    expect(arcs(track)[0]).toMatchObject({ from: 0, to: Math.PI * 2 });
    expect(track.alpha).toBe(1);
    expect(progress.strokeStyle).toBe(VIOLET);
    expect(progress.alpha).toBe(0.95);
    expect(arcs(progress)[0].from).toBeCloseTo(-Math.PI / 2, 9);
    expect(arcs(progress)[0].to).toBeCloseTo(0, 9);
  });

  it("shows no ring for a hold that has barely begun, and never more than a full turn", () => {
    const { overlay, calls } = setup();
    overlay.draw(scene({ hands: [hand("A", { hold: 0.05 })], enabled: false }), view());
    expect(calls.filter((c) => c.op === "stroke")).toHaveLength(0);

    overlay.draw(scene({ hands: [hand("A", { hold: 1.4 })], enabled: false }), view());
    const progress = calls.filter((c) => c.op === "stroke")[1];
    expect(arcs(progress)[0].to! - arcs(progress)[0].from!).toBeCloseTo(Math.PI * 2, 9);
  });

  it("counts down in large mono digits centred on the stage", () => {
    const { overlay, calls } = setup();
    overlay.draw(scene({ countdown: 2.4 }), view());
    const [dark, digit] = calls.filter((c) => c.op === "fillText");
    expect(digit.text).toBe("3");
    expect(digit.fillStyle).toBe(S.text);
    // A fifth of the 720 px stage; the baseline centres the digit's cap height (0.73 em) on the stage.
    expect(digit.font).toBe('500 144px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace');
    expect(digit.textAlign).toBe("center");
    expect([digit.x, digit.y]).toEqual([640, Math.round(360 + (144 * 0.73) / 2)]);
    expect(dark.fillStyle).toBe(S.textShadow);
    expect(dark.x).toBe(digit.x);
    expect(dark.y).toBeGreaterThan(digit.y);
  });

  it("centres the countdown on the stage rect and steps through the seconds", () => {
    const { overlay, calls } = setup();
    const stage = { x: 100, y: 50, w: 640, h: 360 };
    const shown = (countdown: number | null) => {
      calls.length = 0;
      overlay.draw(scene({ countdown }), view({ width: 840, height: 460, stage }));
      return texts(calls).map((c) => c.text);
    };
    expect(shown(3)).toEqual(["3"]);
    expect(texts(calls)[0].x).toBe(420);
    expect(texts(calls)[0].font).toMatch(/^500 72px /);
    expect(shown(2.999)).toEqual(["3"]);
    expect(shown(2)).toEqual(["2"]);
    expect(shown(0.2)).toEqual(["1"]);
    expect(shown(0)).toEqual([]);
    expect(shown(null)).toEqual([]);
  });

  it("starts each second at full strength and lets the digit settle", () => {
    const { overlay, calls } = setup();
    overlay.draw(scene({ countdown: 3 }), view());
    overlay.draw(scene({ countdown: 2.5 }), view());
    const [start, half] = texts(calls);
    expect(start.alpha).toBe(1);
    expect(half.alpha).toBeCloseTo(1 - S.countdownFade / 2, 9);
    expect(half.alpha).toBeGreaterThan(0.7);
  });
});

describe("TrackerOverlay pixel alignment", () => {
  const reticleAt = (dpr: number) => {
    const { overlay, calls } = setup();
    const a = hand("A", { pose: "L", engaged: true });
    a.points[8] = at(599.4, 131.4);
    overlay.draw(scene({ hands: [a] }), view({ width: 1280 * dpr, height: 720 * dpr, dpr, stage: { x: 0, y: 0, w: 1280 * dpr, h: 720 * dpr } }));
    const reticles = strokes(calls, BLUE)[0];
    return { calls, reticles, square: rects(reticles)[1], ticks: segments(reticles).slice(4, 8) };
  };
  const fraction = (v: number) => v - Math.floor(v);

  it("centres 1 px hairlines in their pixel at dpr 1", () => {
    const { reticles, square, ticks } = reticleAt(1);
    expect(reticles.lineWidth).toBe(1);
    expect([square.x, square.y, square.w]).toEqual([591.5, 123.5, 16]);
    // Ticks end on pixel edges.
    for (const t of ticks) expect([fraction(t.x0 + t.y0), fraction(t.x1 + t.y1)]).toEqual([0.5, 0.5]);
  });

  it("puts 2 px hairlines on whole pixels at dpr 2 and doubles every size", () => {
    const { calls, reticles, square, ticks } = reticleAt(2);
    expect(reticles.lineWidth).toBe(2);
    // The fingertip is at 1198.8, 262.8.
    expect([square.x, square.y, square.w]).toEqual([1199 - 16, 263 - 16, 32]);
    for (const t of ticks) expect(t.length).toBe(10);
    const label = textOf(calls, /^L08 /)[0];
    expect(label.text).toBe("L08 599,131");
    expect([label.x, label.y]).toEqual([1199 + 26, 263 - 14]);
    expect(label.font).toMatch(/^500 20px /);
    expect(strokes(calls, S.skeleton)[0].lineWidth).toBe(2);
    expect(arcs(fills(calls, S.joint)[0])[0].r).toBe(3.6);
    const dark = shadows(calls).find((c) => c.text === label.text)!;
    expect(dark.y - label.y).toBe(2);
  });

  it("keeps hairlines one crisp pixel on a 150% display", () => {
    const { calls, reticles, square, ticks } = reticleAt(1.5);
    expect(reticles.lineWidth).toBe(1);
    // The fingertip is at 899.1, 197.1.
    expect([square.x, square.y, square.w]).toEqual([899.5 - 12, 197.5 - 12, 24]);
    // 7.5 px ticks would end mid-pixel: they are 7 px, centred on the side's line.
    for (const t of ticks) {
      expect(t.length).toBe(7);
      expect([fraction(t.x0 + t.y0), fraction(t.x1 + t.y1)]).toEqual([0.5, 0.5]);
    }
    const label = textOf(calls, /^L08 /)[0];
    expect([label.x, label.y]).toEqual([899 + 20, 197 - 11]);
    expect(label.font).toMatch(/^500 15px /);
    // Bones run at any angle, so they keep their true 1.5 px weight.
    expect(strokes(calls, S.skeleton)[0].lineWidth).toBe(1.5);
  });
});
