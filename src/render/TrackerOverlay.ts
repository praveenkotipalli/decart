/**
 * Tracker graphics of the window frame style, drawn on a 2D canvas over the GL picture:
 * hand skeletons, fingertip coordinates, reticles on recognised poses, wrist captions,
 * the face box, the frame tag, the loupe label, hold rings and the capture countdown.
 *
 * The look is thin technical line work with nothing behind it, so two things carry it:
 *  - Hairlines are whole device pixels wide, and axis-aligned ones are centred so that
 *    their edges fall on pixel boundaries (hairlineWidth, alignStroke). Reticles and
 *    labels therefore move in whole pixels and stay crisp instead of shimmering.
 *  - Type is drawn twice, a dark copy one pixel down and then the text, because there is
 *    no backing and the video behind it can be any brightness.
 *
 * Sizes in TRACKER_STYLE are CSS px and are multiplied by the device pixel ratio.
 * The drawing code needs only the context methods in TrackerContext2D, so the tests drive
 * it with a recording stub instead of a DOM canvas.
 */
import type { LoupeSnapshot, PoseName, Rect, TrackerHand, TrackerScene } from "../toy/types";
import { HAND_CONNECTIONS } from "../tracking/landmarks";

/** The part of CanvasRenderingContext2D the overlay draws with. */
export interface TrackerContext2D {
  globalAlpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: number[]): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** The part of HTMLCanvasElement the overlay needs. */
export interface TrackerCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): TrackerContext2D | null;
}

export interface TrackerView {
  /** Drawing-buffer size, device px (the same as the GL canvas). */
  width: number;
  height: number;
  dpr: number;
  /** Where the stage sits on the canvas, device px: a stage point p is drawn at stage.xy + p * stage.wh. */
  stage: Rect;
  /**
   * The render tick's time, ms. Only the 10 Hz label refresh uses it. When it is left out
   * the overlay reads performance.now() itself.
   */
  time?: number;
}

/** Every number and colour of the tracker layer. Lengths are CSS px. */
export const TRACKER_STYLE = {
  /** Label strings follow their hand at 10 Hz: digits that change every frame cannot be read. */
  labelIntervalMs: 100,

  // Type
  fontPx: 10,
  fontWeight: 500,
  lineHeight: 13,
  text: "rgba(233, 237, 247, 0.92)",
  textShadow: "rgba(5, 6, 10, 0.6)",
  shadowDy: 1,

  // Hands
  skeleton: "rgba(232, 242, 255, 0.6)",
  skeletonWidth: 1,
  /** Applied to everything of a coasting hand: the skeleton's 0.6 becomes 0.3. */
  coastAlpha: 0.5,
  joint: "rgba(240, 246, 255, 0.92)",
  jointRadius: 1.8,
  labelDx: 13,
  labelDy: 7,

  // Reticles and captions (engaged hands)
  handA: "#4a9eff",
  handB: "#8c66ff",
  reticleAlpha: 0.85,
  reticleSize: 16,
  reticleTick: 5,
  reticleDot: "#ffffff",
  reticleDotRadius: 1.25,
  captionDy: 48,

  // Face box
  faceLine: "rgba(232, 242, 255, 0.5)",
  faceDash: 4,
  faceGap: 6,
  faceLabelDy: 6,

  // Frame tag
  tagDx: 9,
  tagDy: 20,
  tagDot: 5,
  /** Dot plus gap: the tag's text starts one character cell to the right of the fingertip label under it. */
  tagTextDx: 10,
  tagSwatchGap: 6,
  toneLive: "#4a9eff",
  toneBusy: "#8c66ff",
  toneCamera: "#a4acc2",

  // Loupe label
  loupeLabelAngleDeg: 45,
  loupeLabelGap: 7,

  // Hold ring (the classic overlay's ring)
  holdRadius: 22,
  holdWidth: 3,
  holdTrack: "rgba(255, 255, 255, 0.18)",
  holdAlpha: 0.95,
  /** Below this a ring would only flash for every passing fist. */
  holdMin: 0.08,

  // Countdown digits: a fraction of the stage height, within limits
  countdownScale: 0.2,
  countdownMinPx: 64,
  countdownMaxPx: 180,
  /** How far each digit dims over its second. */
  countdownFade: 0.28,
} as const;

/** Thumb, index, middle, ring, pinky tips: the landmarks that get a label and a reticle. */
export const FINGERTIPS: readonly number[] = [4, 8, 12, 16, 20];

const S = TRACKER_STYLE;
/** The same stack as Overlay.ts and canvasTextures.ts. */
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
/** Cap height of JetBrains Mono, em: what digits are centred by. */
const CAP_HEIGHT = 0.73;
const TAU = Math.PI * 2;
const LANDMARKS = 21;
/** Wrist and the four finger bases: their mean is the palm centre (as landmarks.palmCenter). */
const PALM: readonly number[] = [0, 5, 9, 13, 17];
/** HAND_CONNECTIONS flattened once, so the skeleton loop allocates nothing. */
const BONES = Uint8Array.from(HAND_CONNECTIONS.flatMap(([a, b]) => [a, b]));
const LOUPE_COS = Math.cos((S.loupeLabelAngleDeg * Math.PI) / 180);
const LOUPE_SIN = Math.sin((S.loupeLabelAngleDeg * Math.PI) / 180);
const NO_DASH: number[] = [];
const NO_LINES: readonly string[] = [];
const TEXT_CAPACITY = 96;
const DASH_CAPACITY = 1024;
const MAX_DEBUG_LINES = 8;

// ── Pure helpers ─────────────────────────────────────────────────────────────

const whole = (v: number): number => (Number.isFinite(v) ? Math.round(v) : 0);

/** A fingertip label in the reference's format, e.g. `L08 599,131`: side, two-digit landmark, x,y in label pixels. */
export function formatTipLabel(side: "L" | "R", landmark: number, x: number, y: number): string {
  return `${side}${landmark < 10 ? "0" : ""}${landmark} ${whole(x)},${whole(y)}`;
}

/** The wrist caption, e.g. `right · 23 px/s · L`: side word, palm speed, pose token (left out while no pose is named). */
export function formatCaption(side: "L" | "R", speedPx: number, pose: PoseName | null): string {
  const head = `${side === "L" ? "left" : "right"} · ${Math.max(0, whole(speedPx))} px/s`;
  return pose ? `${head} · ${pose}` : head;
}

/** The face box label, e.g. `face  165px` (two spaces, as in the reference). */
export function formatFaceLabel(widthPx: number): string {
  return `face  ${Math.max(0, whole(widthPx))}px`;
}

/** The loupe label, e.g. `×2.0`. */
export function formatZoom(zoom: number): string {
  return `×${(Number.isFinite(zoom) ? zoom : 1).toFixed(1)}`;
}

/** The number a countdown shows: 3 for anything in (2, 3], and 0 when there is nothing to count. */
const secondsShown = (secondsLeft: number | null): number =>
  secondsLeft !== null && Number.isFinite(secondsLeft) && secondsLeft > 0 ? Math.ceil(secondsLeft) : 0;

/** The countdown digits: whole seconds still to go, or "" when there is nothing to count. */
export function formatCountdown(secondsLeft: number | null): string {
  const n = secondsShown(secondsLeft);
  return n > 0 ? String(n) : "";
}

/**
 * Device-pixel width of a 1 px hairline: whole pixels, never thinner than one. This is
 * how browsers draw a 1px border, so the layer matches the weight of the chrome around it
 * on a 125% or 150% display instead of smearing 1.25 or 1.5 px lines over two pixels.
 */
export function hairlineWidth(dpr: number): number {
  return Math.max(1, Math.floor(dpr));
}

/**
 * Centre coordinate for an axis-aligned stroke of whole width `lineWidth`, so that both of
 * its edges fall on pixel boundaries: odd widths sit on half pixels, even widths on whole ones.
 */
export function alignStroke(v: number, lineWidth: number): number {
  return lineWidth % 2 === 1 ? Math.floor(v) + 0.5 : Math.round(v);
}

/**
 * Dashes along one side of a box, as [start, end) offsets from the side's first pixel.
 * The pattern is anchored at both ends, so every corner of the box gets a full dash and all
 * four corners look alike; what is left over is taken up in the middle, where the gap is
 * `gap` wide or a little more, with one extra centred dash when there is room for it. A
 * side too short for two dashes and a gap is one solid segment. Returns the number of
 * segments written to `out` (two numbers each).
 */
export function dashSegments(length: number, dash: number, gap: number, out: Float64Array): number {
  const capacity = out.length >> 1;
  if (!(length > 0) || !(dash > 0) || !(gap >= 0) || capacity < 1) return 0;
  const period = dash + gap;
  const perEnd = Math.floor(((length - gap) / 2 - dash) / period) + 1;
  const middle = length - 2 * ((perEnd - 1) * period + dash);
  const centred = middle >= dash + 2 * gap;
  if (length < 2 * dash + gap || perEnd * 2 + (centred ? 1 : 0) > capacity) {
    out[0] = 0;
    out[1] = length;
    return 1;
  }
  let n = 0;
  for (let k = 0; k < perEnd; k++, n++) {
    out[n * 2] = k * period;
    out[n * 2 + 1] = k * period + dash;
  }
  if (centred) {
    const start = Math.round((length - dash) / 2);
    out[n * 2] = start;
    out[n * 2 + 1] = start + dash;
    n++;
  }
  for (let k = perEnd - 1; k >= 0; k--, n++) {
    out[n * 2] = length - k * period - dash;
    out[n * 2 + 1] = length - k * period;
  }
  return n;
}

// ── Internals ────────────────────────────────────────────────────────────────

const clockNow = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const isFingertip = (i: number): boolean => i > 0 && i % 4 === 0;
const nearestOdd = (v: number): number => Math.max(1, 2 * Math.round((v - 1) / 2) + 1);
const nearestEven = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

/** A label coordinate: a stage coordinate in whole label pixels. */
const labelCoord = (v: number, extent: number): number => whole(v * extent);

/**
 * Keeps a label on the visible stage: `v` is clamped into [lo, hi] but moved by at most
 * `reach`, so a label whose anchor has really left the picture follows it out instead of
 * sticking to the edge.
 */
function clampReach(v: number, lo: number, hi: number, reach: number): number {
  if (lo > hi) return v;
  if (v < lo) return Math.min(lo, v + reach);
  if (v > hi) return Math.max(hi, v - reach);
  return v;
}

/** Adds a dot to the current path. The moveTo matters: arc() would join it to the previous dot with a line. */
function dot(g: TrackerContext2D, x: number, y: number, r: number) {
  g.moveTo(x + r, y);
  g.arc(x, y, r, 0, TAU);
}

/** TRACKER_STYLE in device px for one device pixel ratio. */
interface Metrics {
  dpr: number;
  /** Device px of a 1 px hairline. */
  hair: number;
  font: string;
  fontPx: number;
  shadowDy: number;
  line: number;
  jointR: number;
  labelDx: number;
  labelDy: number;
  reticleHalf: number;
  tickHalf: number;
  pipR: number;
  captionDy: number;
  dash: number;
  gap: number;
  faceLabelDy: number;
  tagDx: number;
  tagDy: number;
  tagDot: number;
  tagTextDx: number;
  tagSwatchGap: number;
  loupeGap: number;
  /** Margin kept between a caption and the edge of the picture, and how far a caption may be moved to keep it. */
  pad: number;
  reach: number;
}

function metricsFor(dpr: number): Metrics {
  const px = (css: number) => Math.round(css * dpr);
  const hair = hairlineWidth(dpr);
  // A tick is centred on a hairline, so its length has to share the hairline's parity for both ends to land on pixel edges.
  const tick = hair % 2 === 1 ? nearestOdd(S.reticleTick * dpr) : nearestEven(S.reticleTick * dpr);
  const fontPx = S.fontPx * dpr;
  return {
    dpr,
    hair,
    font: `${S.fontWeight} ${Number(fontPx.toFixed(2))}px ${MONO}`,
    fontPx,
    shadowDy: Math.max(1, px(S.shadowDy)),
    line: px(S.lineHeight),
    jointR: S.jointRadius * dpr,
    labelDx: px(S.labelDx),
    labelDy: px(S.labelDy),
    reticleHalf: Math.max(1, px(S.reticleSize / 2)),
    tickHalf: tick / 2,
    pipR: S.reticleDotRadius * dpr,
    captionDy: px(S.captionDy),
    dash: Math.max(1, px(S.faceDash)),
    gap: Math.max(1, px(S.faceGap)),
    faceLabelDy: px(S.faceLabelDy),
    tagDx: px(S.tagDx),
    tagDy: px(S.tagDy),
    tagDot: Math.max(1, px(S.tagDot)),
    tagTextDx: px(S.tagTextDx),
    tagSwatchGap: px(S.tagSwatchGap),
    loupeGap: S.loupeLabelGap * dpr,
    pad: px(4),
    reach: px(S.captionDy * 2),
  };
}

/** The cached label strings of one hand. */
interface HandLabels {
  side: "L" | "R" | null;
  /** Time of the last refresh, ms. */
  at: number;
  tipX: Int32Array;
  tipY: Int32Array;
  tips: string[];
  pose: PoseName | null;
  speed: number;
  caption: string;
  captionW: number;
  debugSrc: string | null;
  debugLines: readonly string[];
  debugW: number;
}

const newHandLabels = (): HandLabels => ({
  side: null,
  at: -Infinity,
  tipX: new Int32Array(FINGERTIPS.length),
  tipY: new Int32Array(FINGERTIPS.length),
  tips: FINGERTIPS.map(() => ""),
  pose: null,
  speed: -1,
  caption: "",
  captionW: 0,
  debugSrc: null,
  debugLines: NO_LINES,
  debugW: 0,
});

/**
 * Hairline tracker graphics over the stage. One instance per overlay canvas; `draw` once
 * per render frame with the scene from `ToyController.snapshot`.
 */
export class TrackerOverlay {
  private readonly ctx: TrackerContext2D | null;
  private m = metricsFor(1);

  /** Canvas px of the hand being drawn: 21 landmarks, then its five fingertips snapped for hairlines. One scratch buffer, no per-frame objects. */
  private readonly px = new Float64Array(LANDMARKS * 2);
  private readonly tip = new Float64Array(FINGERTIPS.length * 2);
  private readonly seg = new Float64Array(DASH_CAPACITY * 2);

  /** Text is queued while the line work is drawn, then painted in two passes (see flushText). */
  private readonly qText = new Array<string>(TEXT_CAPACITY).fill("");
  private readonly qX = new Float64Array(TEXT_CAPACITY);
  private readonly qY = new Float64Array(TEXT_CAPACITY);
  private readonly qAlpha = new Float64Array(TEXT_CAPACITY);
  private qn = 0;

  private readonly labels: HandLabels[] = [];
  private readonly faceLabel = { at: -Infinity, width: -1, text: "" };
  private readonly tagWidth = { at: -Infinity, text: "", width: 0 };
  private readonly zoomValue: number[] = [];
  private readonly zoomText: string[] = [];
  private readonly digits = { n: 0, text: "", size: 0, font: "" };

  /** The part of the stage that is on the canvas, device px. */
  private left = 0;
  private top = 0;
  private right = 0;
  private bottom = 0;

  constructor(readonly canvas: TrackerCanvas) {
    this.ctx = canvas.getContext("2d");
  }

  /** Sets the drawing-buffer size (device px). `draw` also does this, so the canvas can never lag behind the view. */
  resize(w: number, h: number): void {
    const W = Math.max(1, Math.round(w) || 1);
    const H = Math.max(1, Math.round(h) || 1);
    // Assigning a canvas size clears the canvas and resets its context, even to the same value: only on a real change.
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  clear(): void {
    const g = this.ctx;
    if (!g) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();
  }

  draw(scene: TrackerScene, view: TrackerView): void {
    const g = this.ctx;
    if (!g) return;
    this.resize(view.width, view.height);
    const W = this.canvas.width;
    const H = this.canvas.height;

    // The canvas is shared with the classic overlay: assume nothing about the context's
    // state, and hand it back as it was found.
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    const st = view.stage;
    if (st.w > 0 && st.h > 0) {
      const dpr = view.dpr > 0 && Number.isFinite(view.dpr) ? view.dpr : 1;
      if (dpr !== this.m.dpr) {
        this.m = metricsFor(dpr);
        this.remeasure();
      }
      const now = view.time ?? clockNow();
      this.left = Math.max(0, st.x);
      this.top = Math.max(0, st.y);
      this.right = Math.min(W, st.x + st.w);
      this.bottom = Math.min(H, st.y + st.h);
      this.qn = 0;

      g.globalAlpha = 1;
      g.lineCap = "butt";
      g.lineJoin = "miter";
      g.setLineDash(NO_DASH);
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      g.font = this.m.font;

      const hands = scene.hands;
      if (scene.enabled) {
        this.drawFace(g, scene, st, now);
        for (let i = 0; i < hands.length; i++) this.drawHand(g, hands[i], i, scene, st, now);
      }
      // Hold rings and the countdown are feedback, not decoration: they stay when the trackers are switched off.
      for (let i = 0; i < hands.length; i++) this.drawHoldRing(g, hands[i], st);
      if (scene.enabled) {
        this.drawFrameTag(g, scene.frameTag, st, now);
        this.queueLoupeLabels(scene.loupes, st);
        this.flushText(g);
      }
      this.drawCountdown(g, scene.countdown);
    }
    g.restore();
  }

  // ── Hands ──────────────────────────────────────────────────────────────────

  private drawHand(g: TrackerContext2D, hand: TrackerHand, slot: number, scene: TrackerScene, st: Rect, now: number) {
    const pts = hand.points;
    if (pts.length < LANDMARKS) return;
    const m = this.m;
    const px = this.px;
    for (let i = 0; i < LANDMARKS; i++) {
      px[i * 2] = st.x + pts[i].x * st.w;
      px[i * 2 + 1] = st.y + pts[i].y * st.h;
    }
    const tip = this.tip;
    for (let k = 0; k < FINGERTIPS.length; k++) {
      tip[k * 2] = alignStroke(px[FINGERTIPS[k] * 2], m.hair);
      tip[k * 2 + 1] = alignStroke(px[FINGERTIPS[k] * 2 + 1], m.hair);
    }
    // A hand the tracker lost a moment ago is still drawn where it is expected to be, dimmed.
    const group = hand.fresh ? 1 : S.coastAlpha;

    // One path per style: where bones share a joint the stroke covers it once, so the alpha stays even.
    g.globalAlpha = group;
    g.strokeStyle = S.skeleton;
    g.lineWidth = S.skeletonWidth * m.dpr;
    g.beginPath();
    for (let i = 0; i < BONES.length; i += 2) {
      const a = BONES[i] * 2;
      const b = BONES[i + 1] * 2;
      g.moveTo(px[a], px[a + 1]);
      g.lineTo(px[b], px[b + 1]);
    }
    g.stroke();

    g.fillStyle = S.joint;
    g.beginPath();
    for (let i = 0; i < LANDMARKS; i++) {
      // On an engaged hand the reticle's own, finer centre dot marks the fingertip.
      if (hand.engaged && isFingertip(i)) continue;
      dot(g, px[i * 2], px[i * 2 + 1], m.jointR);
    }
    g.fill();

    if (hand.engaged) this.drawReticles(g, hand, group);

    const labels = this.handLabels(g, slot, hand, scene, now);
    // Labels hang off the same snapped point as the reticle, so the two never jitter against each other.
    const half = m.hair % 2 === 1 ? 0.5 : 0;
    for (let k = 0; k < FINGERTIPS.length; k++) {
      this.push(labels.tips[k], tip[k * 2] - half + m.labelDx, tip[k * 2 + 1] - half - m.labelDy, group);
    }

    const debugLines = labels.debugLines.length;
    if (hand.engaged || debugLines > 0) {
      // The caption's row stays free under a hand that has none, so the debug readout does not jump as the pose comes and goes.
      const width = Math.max(labels.captionW, labels.debugW);
      const cx = clampReach(px[0], this.left + width / 2 + m.pad, this.right - width / 2 - m.pad, m.reach);
      const lowest = this.bottom - m.pad - m.fontPx * 0.3 - debugLines * m.line;
      const y = Math.round(clampReach(px[1] + m.captionDy, this.top + m.pad + m.fontPx, lowest, m.reach));
      if (hand.engaged) this.push(labels.caption, Math.round(cx - labels.captionW / 2), y, group);
      const x = Math.round(cx - labels.debugW / 2);
      for (let i = 0; i < debugLines; i++) this.push(labels.debugLines[i], x, y + (i + 1) * m.line, group);
    }
  }

  /** The confirmation that a pose was seen: a square with four ticks on every fingertip, in the hand's colour. */
  private drawReticles(g: TrackerContext2D, hand: TrackerHand, group: number) {
    const m = this.m;
    const tip = this.tip;
    const s = m.reticleHalf;
    const t = m.tickHalf;
    g.globalAlpha = group * S.reticleAlpha;
    g.strokeStyle = hand.role === "A" ? S.handA : S.handB;
    g.lineWidth = m.hair;
    g.beginPath();
    for (let k = 0; k < tip.length; k += 2) {
      const x = tip[k];
      const y = tip[k + 1];
      g.rect(x - s, y - s, s * 2, s * 2);
      g.moveTo(x - s - t, y);
      g.lineTo(x - s + t, y);
      g.moveTo(x + s - t, y);
      g.lineTo(x + s + t, y);
      g.moveTo(x, y - s - t);
      g.lineTo(x, y - s + t);
      g.moveTo(x, y + s - t);
      g.lineTo(x, y + s + t);
    }
    g.stroke();

    g.fillStyle = S.reticleDot;
    g.beginPath();
    for (let k = 0; k < tip.length; k += 2) dot(g, tip[k], tip[k + 1], m.pipR);
    g.fill();
  }

  /**
   * The label strings of one hand. They follow the hand at 10 Hz, which keeps the digits
   * readable and builds a string only when a number actually changed. A pose change is
   * shown at once: the caption is how the user sees that a gesture was recognised.
   */
  private handLabels(g: TrackerContext2D, slot: number, hand: TrackerHand, scene: TrackerScene, now: number): HandLabels {
    const c = this.labels[slot] ?? (this.labels[slot] = newHandLabels());
    const sideChanged = c.side !== hand.side;
    const poseChanged = c.pose !== hand.pose;
    const due = sideChanged || now - c.at >= S.labelIntervalMs || now < c.at;
    if (due) {
      c.at = now;
      c.side = hand.side;
      for (let k = 0; k < FINGERTIPS.length; k++) {
        const p = hand.points[FINGERTIPS[k]];
        const x = labelCoord(p.x, scene.space.w);
        const y = labelCoord(p.y, scene.space.h);
        if (sideChanged || x !== c.tipX[k] || y !== c.tipY[k]) {
          c.tipX[k] = x;
          c.tipY[k] = y;
          c.tips[k] = formatTipLabel(hand.side, FINGERTIPS[k], x, y);
        }
      }
    }
    c.pose = hand.pose;

    if (!hand.engaged) {
      c.caption = "";
      c.captionW = 0;
    } else if (due || poseChanged || c.caption === "") {
      const speed = Math.max(0, whole(hand.speedPx));
      if (sideChanged || poseChanged || speed !== c.speed || c.caption === "") {
        c.speed = speed;
        c.caption = formatCaption(hand.side, speed, hand.pose);
      }
      // Measured on every refresh, not only when the text changes: the web font may have arrived since.
      c.captionW = g.measureText(c.caption).width;
    }

    const debugText = scene.debug ? hand.debugText : null;
    if (!debugText) {
      c.debugSrc = null;
      c.debugLines = NO_LINES;
      c.debugW = 0;
    } else if (due || poseChanged || c.debugSrc === null) {
      if (c.debugSrc !== debugText) {
        c.debugSrc = debugText;
        const lines = debugText.split("\n");
        if (lines.length > MAX_DEBUG_LINES) lines.length = MAX_DEBUG_LINES;
        c.debugLines = lines;
      }
      let width = 0;
      for (let i = 0; i < c.debugLines.length; i++) width = Math.max(width, g.measureText(c.debugLines[i]).width);
      c.debugW = width;
    }
    return c;
  }

  /** Fist-to-clear progress, at the palm, in the classic overlay's ring style and the hand's colour. */
  private drawHoldRing(g: TrackerContext2D, hand: TrackerHand, st: Rect) {
    const pts = hand.points;
    if (!(hand.hold > S.holdMin) || pts.length < LANDMARKS) return;
    let x = 0;
    let y = 0;
    for (let i = 0; i < PALM.length; i++) {
      x += pts[PALM[i]].x;
      y += pts[PALM[i]].y;
    }
    x = st.x + (x / PALM.length) * st.w;
    y = st.y + (y / PALM.length) * st.h;
    const r = S.holdRadius * this.m.dpr;
    g.lineWidth = S.holdWidth * this.m.dpr;
    g.globalAlpha = 1;
    g.strokeStyle = S.holdTrack;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.stroke();
    g.globalAlpha = S.holdAlpha;
    g.strokeStyle = hand.role === "A" ? S.handA : S.handB;
    g.beginPath();
    g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, hand.hold) * TAU);
    g.stroke();
  }

  // ── Face, frame tag, loupes ────────────────────────────────────────────────

  private drawFace(g: TrackerContext2D, scene: TrackerScene, st: Rect, now: number) {
    const f = scene.face;
    if (!f || !(f.w > 0) || !(f.h > 0) || !(f.alpha > 0)) return;
    const m = this.m;
    const x0 = alignStroke(st.x + f.x * st.w, m.hair);
    const y0 = alignStroke(st.y + f.y * st.h, m.hair);
    const x1 = alignStroke(st.x + (f.x + f.w) * st.w, m.hair);
    const y1 = alignStroke(st.y + (f.y + f.h) * st.h, m.hair);
    // Strokes are centred on the edges, so the box's outer corner is half a line further out.
    const out = m.hair / 2;
    const alpha = Math.min(1, f.alpha);
    const seg = this.seg;

    // Dashes are laid out by hand rather than with setLineDash: they start flush in every
    // corner and begin and end on whole pixels, which a running dash pattern cannot promise.
    g.globalAlpha = alpha;
    g.strokeStyle = S.faceLine;
    g.lineWidth = m.hair;
    g.beginPath();
    let n = dashSegments(x1 - x0 + m.hair, m.dash, m.gap, seg);
    for (let i = 0; i < n; i++) {
      const a = x0 - out + seg[i * 2];
      const b = x0 - out + seg[i * 2 + 1];
      g.moveTo(a, y0);
      g.lineTo(b, y0);
      g.moveTo(a, y1);
      g.lineTo(b, y1);
    }
    n = dashSegments(y1 - y0 + m.hair, m.dash, m.gap, seg);
    for (let i = 0; i < n; i++) {
      const a = y0 - out + seg[i * 2];
      const b = y0 - out + seg[i * 2 + 1];
      g.moveTo(x0, a);
      g.lineTo(x0, b);
      g.moveTo(x1, a);
      g.lineTo(x1, b);
    }
    g.stroke();

    const c = this.faceLabel;
    if (now - c.at >= S.labelIntervalMs || now < c.at) {
      c.at = now;
      const width = labelCoord(f.w, scene.space.w);
      if (width !== c.width) {
        c.width = width;
        c.text = formatFaceLabel(width);
      }
    }
    this.push(c.text, x0 - out, y0 - out - m.faceLabelDy, alpha);
  }

  /** What is inside the frame, next to its first corner: a dot for the state of the anime stream, the name, the filter's colour. */
  private drawFrameTag(g: TrackerContext2D, tag: TrackerScene["frameTag"], st: Rect, now: number) {
    if (!tag) return;
    const m = this.m;
    const x = Math.round(st.x + tag.at.x * st.w) + m.tagDx;
    const base = Math.round(st.y + tag.at.y * st.h) - m.tagDy;
    const d = m.tagDot;
    const r = d / 2;
    const textX = x + m.tagTextDx;
    let swatchX = 0;
    if (tag.swatch) {
      const c = this.tagWidth;
      if (c.text !== tag.text || now - c.at >= S.labelIntervalMs || now < c.at) {
        c.text = tag.text;
        c.at = now;
        c.width = g.measureText(tag.text).width;
      }
      swatchX = textX + (tag.text ? Math.ceil(c.width) + m.tagSwatchGap : 0);
    }

    // The same double draw as the type, so the marks survive a bright background too.
    g.globalAlpha = 1;
    g.fillStyle = S.textShadow;
    g.beginPath();
    dot(g, x + r, base - r + m.shadowDy, r);
    if (tag.swatch) g.rect(swatchX, base - d + m.shadowDy, d, d);
    g.fill();
    g.fillStyle = tag.tone === "live" ? S.toneLive : tag.tone === "busy" ? S.toneBusy : S.toneCamera;
    g.beginPath();
    dot(g, x + r, base - r, r);
    g.fill();
    if (tag.swatch) {
      g.fillStyle = tag.swatch;
      g.fillRect(swatchX, base - d, d, d);
    }
    this.push(tag.text, textX, base, 1);
  }

  /** `×2.0` just outside each loupe's ring, up and to the right. The ring itself is drawn in GL. */
  private queueLoupeLabels(loupes: readonly LoupeSnapshot[], st: Rect) {
    for (let i = 0; i < loupes.length; i++) {
      const l = loupes[i];
      if (!(l.visibility > 0.01)) continue;
      if (this.zoomValue[i] !== l.zoom) {
        this.zoomValue[i] = l.zoom;
        this.zoomText[i] = formatZoom(l.zoom);
      }
      // A radius in frame heights is that fraction of the stage height in px.
      const d = l.radius * st.h + this.m.loupeGap;
      const x = Math.round(st.x + l.center.x * st.w + d * LOUPE_COS);
      const y = Math.round(st.y + l.center.y * st.h - d * LOUPE_SIN);
      this.push(this.zoomText[i], x, y, Math.min(1, l.visibility));
    }
  }

  // ── Type ───────────────────────────────────────────────────────────────────

  private push(text: string, x: number, y: number, alpha: number) {
    const n = this.qn;
    if (!text || n >= TEXT_CAPACITY) return;
    this.qText[n] = text;
    this.qX[n] = x;
    this.qY[n] = y;
    this.qAlpha[n] = alpha;
    this.qn = n + 1;
  }

  /**
   * Paints the queued labels: every dark copy first, then every label. Done per label
   * instead, the dark copy of one label would smudge a neighbour that overlaps it, and
   * labels are allowed to overlap (there is no collision handling, as in the reference).
   */
  private flushText(g: TrackerContext2D) {
    const n = this.qn;
    if (n === 0) return;
    const dy = this.m.shadowDy;
    let alpha = -1;
    g.fillStyle = S.textShadow;
    for (let i = 0; i < n; i++) {
      if (this.qAlpha[i] !== alpha) g.globalAlpha = alpha = this.qAlpha[i];
      g.fillText(this.qText[i], this.qX[i], this.qY[i] + dy);
    }
    alpha = -1;
    g.fillStyle = S.text;
    for (let i = 0; i < n; i++) {
      if (this.qAlpha[i] !== alpha) g.globalAlpha = alpha = this.qAlpha[i];
      g.fillText(this.qText[i], this.qX[i], this.qY[i]);
    }
  }

  /** Large digits in the middle of the picture: whoever is being counted down for has stepped away from the screen. */
  private drawCountdown(g: TrackerContext2D, secondsLeft: number | null) {
    const n = secondsShown(secondsLeft);
    if (n === 0 || secondsLeft === null) return;
    const m = this.m;
    const c = this.digits;
    if (n !== c.n) {
      c.n = n;
      c.text = String(n);
    }
    const size = Math.round(
      Math.min(S.countdownMaxPx * m.dpr, Math.max(S.countdownMinPx * m.dpr, (this.bottom - this.top) * S.countdownScale)),
    );
    if (size !== c.size) {
      c.size = size;
      c.font = `${S.fontWeight} ${size}px ${MONO}`;
    }
    const x = Math.round((this.left + this.right) / 2);
    // Digits are cap-height tall: centre that, not the em box.
    const base = Math.round((this.top + this.bottom) / 2 + (size * CAP_HEIGHT) / 2);
    g.font = c.font;
    g.textAlign = "center";
    // Each second starts bright and settles, so the count reads as running between digits.
    g.globalAlpha = 1 - S.countdownFade * (n - secondsLeft);
    g.fillStyle = S.textShadow;
    g.fillText(c.text, x, base + Math.max(m.shadowDy, Math.round(size * 0.02)));
    g.fillStyle = S.text;
    g.fillText(c.text, x, base);
  }

  /** Text widths depend on the font size: after a change of device pixel ratio every cached width is refreshed on its next use. */
  private remeasure() {
    for (const c of this.labels) c.at = -Infinity;
    this.tagWidth.at = -Infinity;
  }
}
