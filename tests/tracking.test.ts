import { describe, expect, it } from "vitest";
import { classifyQuad, signedArea } from "../src/geometry/quad";
import type { Quad } from "../src/geometry/vec";
import {
  DEFAULT_ONE_HAND_MAPPING,
  DEFAULT_TWO_HAND_MAPPING,
  effectiveMapping,
  mirrorMapping,
  resolveCorners,
  swapVertical,
} from "../src/portal/cornerMapping";
import { HandAssigner } from "../src/tracking/handAssignment";
import type { HandFrame, HandObservation } from "../src/tracking/landmarks";
import { RELAXED_POSE, framePose, syntheticHand } from "../src/tracking/syntheticHand";

const ASPECT = 16 / 9;
const frame = (time: number, hands: HandObservation[]): HandFrame => ({ time, hands, aspect: ASPECT, inferenceMs: 0 });
const A = (o = {}) => syntheticHand(framePose("A", o), ASPECT);
const B = (o = {}) => syntheticHand(framePose("B", o), ASPECT);

const quadFrom = (corners: ReturnType<typeof resolveCorners>) => corners.map((c) => c!.point) as Quad;

describe("HandAssigner", () => {
  it("gives the left-screen hand role A and the right-screen hand role B, in any detection order", () => {
    const a = new HandAssigner();
    const hands = a.update(frame(0, [B(), A()]), "two-hand");
    expect(hands.find((h) => h.role === "A")!.palm.x).toBeLessThan(0.5);
    expect(hands.find((h) => h.role === "B")!.palm.x).toBeGreaterThan(0.5);
  });

  it("keeps identities while hands move, even when MediaPipe reorders them", () => {
    const a = new HandAssigner();
    const first = a.update(frame(0, [A(), B()]), "two-hand");
    const idA = first.find((h) => h.role === "A")!.id;
    const next = a.update(frame(33, [B({ x: 0.66 }), A({ x: 0.37 })]), "two-hand");
    expect(next.find((h) => h.role === "A")!.id).toBe(idA);
  });

  it("keeps roles when hands pass each other, so the portal flips instead of swapping corners", () => {
    const a = new HandAssigner();
    a.update(frame(0, [A(), B()]), "two-hand");
    let hands = a.update(frame(0, [A(), B()]), "two-hand");
    // Hands drift towards each other and past: A ends on the right.
    for (let i = 1; i <= 20; i++) {
      const t = i / 20;
      hands = a.update(frame(i * 33, [A({ x: 0.36 + 0.3 * t }), B({ x: 0.64 - 0.3 * t })]), "two-hand");
    }
    const roleA = hands.find((h) => h.role === "A")!;
    expect(roleA.palm.x).toBeGreaterThan(0.6);
    // Every corner changed sides: a mirrored (negative winding) portal, like a card turned over.
    const q = quadFrom(resolveCorners(DEFAULT_TWO_HAND_MAPPING, hands));
    expect(signedArea(q)).toBeLessThan(0);
  });

  it("coasts through a short dropout and forgets the hand after the grace period", () => {
    const a = new HandAssigner({ graceMs: 400, maxMatchDistance: 0.4 });
    a.update(frame(0, [A(), B()]), "two-hand");
    let hands = a.update(frame(200, [A()]), "two-hand");
    expect(hands).toHaveLength(2);
    expect(hands.find((h) => h.role === "B")!.fresh).toBe(false);
    hands = a.update(frame(700, [A()]), "two-hand");
    expect(hands).toHaveLength(1);
  });

  it("re-acquires a returning hand into the free role", () => {
    const a = new HandAssigner({ graceMs: 300, maxMatchDistance: 0.4 });
    a.update(frame(0, [A(), B()]), "two-hand");
    a.update(frame(500, [A()]), "two-hand");
    const hands = a.update(frame(533, [A(), B()]), "two-hand");
    expect(hands.map((h) => h.role).sort()).toEqual(["A", "B"]);
  });

  it("latches chirality and ignores a single flipped frame", () => {
    const a = new HandAssigner();
    let hands = a.update(frame(0, [syntheticHand({ ...RELAXED_POSE, chirality: 1 })]), "one-hand");
    expect(hands[0].chirality).toBe(1);
    hands = a.update(frame(33, [syntheticHand({ ...RELAXED_POSE, chirality: -1 })]), "one-hand");
    expect(hands[0].chirality).toBe(1);
    for (let t = 66; t <= 400; t += 33) hands = a.update(frame(t, [syntheticHand({ ...RELAXED_POSE, chirality: -1 })]), "one-hand");
    expect(hands[0].chirality).toBe(-1);
  });
});

describe("corner mapping", () => {
  it("the frame pose yields a valid, clockwise portal from the four fingertips", () => {
    const hands = new HandAssigner().update(frame(0, [A(), B()]), "two-hand");
    const q = quadFrom(resolveCorners(DEFAULT_TWO_HAND_MAPPING, hands));
    expect(classifyQuad(q, 0.001)).toBe("valid");
    expect(signedArea(q)).toBeGreaterThan(0);
    expect(q[0].x).toBeLessThan(q[1].x); // P1 left of P2
    expect(q[0].y).toBeLessThan(q[3].y); // P1 above P4
  });

  it("rotating both hands together rotates the portal (fixed finger→corner binding)", () => {
    const turn = 0.9;
    // Rotate the whole configuration about the frame centre.
    const rot = (x: number, y: number) => ({
      x: 0.5 + ((x - 0.5) * ASPECT * Math.cos(turn) - (y - 0.52) * Math.sin(turn)) / ASPECT,
      y: 0.52 + (x - 0.5) * ASPECT * Math.sin(turn) + (y - 0.52) * Math.cos(turn),
    });
    const pa = rot(0.36, 0.52);
    const pb = rot(0.64, 0.52);
    const hands = new HandAssigner().update(
      frame(0, [A({ ...pa, rotation: turn }), B({ ...pb, rotation: turn })]),
      "two-hand",
    );
    const q = quadFrom(resolveCorners(DEFAULT_TWO_HAND_MAPPING, hands));
    const angle = Math.atan2((q[1].y - q[0].y), (q[1].x - q[0].x) * ASPECT);
    expect(classifyQuad(q, 0.001)).toBe("valid");
    expect(angle).toBeGreaterThan(0.6);
  });

  it("one-hand mode stays clockwise for both chiralities", () => {
    for (const chirality of [1, -1] as const) {
      const hands = new HandAssigner().update(
        frame(0, [syntheticHand({ ...RELAXED_POSE, chirality, spread: 1.5 })]),
        "one-hand",
      );
      const m = effectiveMapping("one-hand", DEFAULT_TWO_HAND_MAPPING, DEFAULT_ONE_HAND_MAPPING, hands);
      const q = quadFrom(resolveCorners(m, hands));
      expect(classifyQuad(q, 0.0005)).toBe("valid");
      expect(signedArea(q)).toBeGreaterThan(0);
    }
  });

  it("returns null corners for a missing hand", () => {
    const hands = new HandAssigner().update(frame(0, [A()]), "two-hand");
    const c = resolveCorners(DEFAULT_TWO_HAND_MAPPING, hands);
    expect(c.filter(Boolean)).toHaveLength(2);
  });

  it("mirror and vertical-swap helpers", () => {
    const m = DEFAULT_TWO_HAND_MAPPING;
    expect(mirrorMapping(mirrorMapping(m))).toEqual(m);
    const s = swapVertical(m, "A");
    expect(s[0]).toEqual(m[3]);
    expect(s[3]).toEqual(m[0]);
    expect(s[1]).toEqual(m[1]);
  });
});
