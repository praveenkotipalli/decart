/**
 * Pose classification on REAL MediaPipe landmarks.
 *
 * tests/fixtures/real-hands.json holds what the app's own hand model returned for a set
 * of photographs (stock photos of L-shaped hands, OK signs, open hands, fists …) — numbers
 * only. It is produced by scripts/qa/make_frames.py + scripts/qa/landmarks.mjs.
 * The synthetic hand used elsewhere is tidy; these are not, and they are what decided
 * the thresholds in gestures/poses.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyHand } from "../src/gestures/classifier";
import { classifyPose, describePose } from "../src/gestures/poses";
import { crossing } from "../src/toy/frameMath";
import type { HandPose, PoseName } from "../src/toy/types";
import type { Quad } from "../src/geometry/vec";
import type { HandObservation } from "../src/tracking/landmarks";
import { toHandFrame, type RawHands } from "../src/tracking/trackerProtocol";

interface FixtureFrame {
  name: string;
  width: number;
  height: number;
  hands: RawHands;
  faces: { x: number; y: number; w: number; h: number; score: number }[];
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/real-hands.json", import.meta.url), "utf8")) as { frames: FixtureFrame[] };
const frames = new Map(fixture.frames.map((f) => [f.name, f]));

interface Seen {
  obs: HandObservation;
  pose: HandPose;
}

/** The hands of one frame as the app sees them (mirrored), left to right on screen, classified as a steady pose. */
function seen(name: string): Seen[] {
  const f = frames.get(name);
  if (!f) throw new Error(`no fixture frame ${name}`);
  const aspect = f.width / f.height;
  return toHandFrame(f.hands, 0, aspect, true, 0)
    .hands.slice()
    .sort((a, b) => a.points[0].x - b.points[0].x)
    .map((obs) => {
      // Three results of the same picture, 100 ms apart: what a held pose settles to.
      let shape = classifyHand(obs.world);
      let pose = classifyPose(obs, shape, aspect, 0);
      for (const t of [100, 200]) {
        shape = classifyHand(obs.world, shape);
        pose = classifyPose(obs, shape, aspect, t, pose);
      }
      return { obs, pose };
    });
}

const names = (name: string): (PoseName | null)[] => seen(name).map((s) => s.pose.name);
const why = (name: string) => seen(name).map((s) => `${s.pose.name}: ${describePose(s.pose)}`).join("\n");

/** The hand frame of a two-hand picture: [A index, B index, B thumb, A thumb], A on the left of the screen. */
function quad(name: string): Quad {
  const [a, b] = seen(name);
  const f = frames.get(name)!;
  const aspect = f.width / f.height;
  const p = (o: HandObservation, i: number) => ({ x: o.points[i].x * aspect, y: o.points[i].y });
  return [p(a.obs, 8), p(b.obs, 8), p(b.obs, 4), p(a.obs, 4)];
}

describe("real hands: the L", () => {
  it.each([
    ["s_oneL", ["L"]],
    ["s_twoL", ["L", "L"]],
    ["b1_L_right_palm", ["L"]],
    ["b2_L_right_palm_loose", ["L"]],
    ["b3_L_left_rotated", ["L"]],
    ["b4_L_with_face", ["L"]],
    ["a1_twoL_face", ["L"]], // only one of its two soft, clipped hands is detected at all
  ])("%s is an L", (name, expected) => {
    expect(names(name), why(name)).toEqual(expected);
  });

  it.each(["s_twoL_B_facing_flipped", "s_twoL_B_tipped"])("%s: a hand turned over is still an L", (name) => {
    expect(names(name), why(name)).toEqual(["L", "L"]);
  });

  it.each(["a2_director_landscape", "a3_director_portrait", "a4_director_outdoor"])(
    "%s: a director's frame is two Ls, although one hand shows its back",
    (name) => {
      expect(names(name), why(name)).toEqual(["L", "L"]);
    },
  );
});

describe("real hands: what must not be an L", () => {
  it("two raised index fingers with the thumbs folded in are pointing, not framing", () => {
    expect(names("n1_two_index_up"), why("n1_two_index_up")).toEqual(["point", "point"]);
  });

  it("a pointing hand is a point", () => {
    expect(names("mp_pointing_up"), why("mp_pointing_up")).toEqual(["point"]);
  });

  it.each(["d1_open_palm", "d2_open_back"])("%s: an open hand is a palm", (name) => {
    expect(names(name), why(name)).toEqual(["palm"]);
  });

  it.each(["mp_left_hands", "mp_right_hands"])("%s: two open hands are two palms", (name) => {
    expect(names(name), why(name)).toEqual(["palm", "palm"]);
  });

  it("a fist is a fist", () => {
    expect(names("mp_fist"), why("mp_fist")).toEqual(["fist"]);
  });

  it.each(["mp_thumb_up", "mp_victory", "mp_woman_hands"])("%s is neither an L nor an OK sign", (name) => {
    for (const n of names(name)) {
      expect(n, why(name)).not.toBe("L");
      expect(n, why(name)).not.toBe("OK");
    }
  });
});

describe("real hands: the OK sign", () => {
  it.each(["c1_ok_right_palm", "c2_ok_with_face", "c3_ok_over_eye"])("%s is an OK sign", (name) => {
    expect(names(name), why(name)).toEqual(["OK"]);
  });

  it("puts the loupe inside the ring", () => {
    for (const name of ["c1_ok_right_palm", "c2_ok_with_face", "c3_ok_over_eye"]) {
      const [{ obs, pose }] = seen(name);
      const ring = pose.ring!;
      const xs = [4, 8, 2, 5].map((i) => obs.points[i].x);
      const ys = [4, 8, 2, 5].map((i) => obs.points[i].y);
      expect(ring.center.x, name).toBeGreaterThan(Math.min(...xs));
      expect(ring.center.x, name).toBeLessThan(Math.max(...xs));
      expect(ring.center.y, name).toBeGreaterThan(Math.min(...ys));
      expect(ring.center.y, name).toBeLessThan(Math.max(...ys));
    }
  });

  it("survives the photos whose landmarks MediaPipe got wrong", () => {
    // c4 and c5 are mis-fitted by the hand model (huge, clipped hands): no pose is promised, only no crash.
    for (const name of ["c4_ok_left_back", "c5_ok_left_palm"]) expect(() => seen(name)).not.toThrow();
  });
});

describe("real hands: which side faces the camera", () => {
  it("the two hands of a frame vote opposite ways (they are mirror images)", () => {
    const [a, b] = seen("s_twoL");
    expect(a.pose.facing).not.toBe(0);
    expect(b.pose.facing).toBe(-a.pose.facing);
  });

  it("turning one hand over flips its vote and leaves the other alone", () => {
    const base = seen("s_twoL");
    for (const name of ["s_twoL_B_facing_flipped", "s_twoL_B_tipped"]) {
      const now = seen(name);
      expect(now[0].pose.facing, name).toBe(-base[0].pose.facing);
      expect(now[1].pose.facing, name).toBe(base[1].pose.facing);
    }
  });
});

describe("real hands: the frame they make", () => {
  it("two Ls give a convex frame with the index fingers on top", () => {
    const q = quad("s_twoL");
    expect(crossing(q).crossed).toBe(false);
    expect(q[0].y).toBeLessThan(q[3].y);
    expect(q[1].y).toBeLessThan(q[2].y);
    expect(q[0].x).toBeLessThan(q[1].x);
  });

  it("a hand tipped over twists the frame into a bow-tie", () => {
    const c = crossing(quad("s_twoL_B_tipped"));
    expect(c.crossed).toBe(true);
    expect(c.t).toBeGreaterThan(0.12);
    expect(c.t).toBeLessThan(0.88);
  });

  it("a hand turned over about the forearm does not twist it", () => {
    expect(crossing(quad("s_twoL_B_facing_flipped")).crossed).toBe(false);
  });
});

describe("real hands: hysteresis across results", () => {
  /** One hand's landmarks from a frame (the only hand, or the one at screen index `which`). */
  const hand = (name: string, which = 0): HandObservation => {
    const f = frames.get(name)!;
    return toHandFrame(f.hands, 0, f.width / f.height, true, 0)
      .hands.slice()
      .sort((a, b) => a.points[0].x - b.points[0].x)[which];
  };
  const run = (steps: { obs: HandObservation; aspect: number; t: number }[]) => {
    let shape: ReturnType<typeof classifyHand> | undefined;
    let pose: HandPose | undefined;
    for (const s of steps) {
      shape = classifyHand(s.obs.world, shape);
      pose = classifyPose(s.obs, shape, s.aspect, s.t, pose);
    }
    return pose!;
  };
  const A = 16 / 9;

  it("an L that opens into a relaxed open hand lets go (the curled flags must not stick)", () => {
    const l = hand("b1_L_right_palm");
    for (const open of ["d2_open_back", "mp_right_hands", "mp_left_hands"]) {
      const o = hand(open);
      // Three L results, then (after a pause, so the size guard does not hold the pose) three open ones.
      const pose = run([
        { obs: l, aspect: A, t: 0 },
        { obs: l, aspect: A, t: 100 },
        { obs: l, aspect: A, t: 200 },
        { obs: o, aspect: A, t: 1000 },
        { obs: o, aspect: A, t: 1100 },
        { obs: o, aspect: A, t: 1200 },
      ]);
      expect(pose.name, `${open}: ${describePose(pose)}`).toBe("palm");
    }
  });

  it("an L that closes into a fist lets go", () => {
    const pose = run([
      { obs: hand("b1_L_right_palm"), aspect: A, t: 0 },
      { obs: hand("b1_L_right_palm"), aspect: A, t: 100 },
      { obs: hand("mp_fist"), aspect: A, t: 1000 },
      { obs: hand("mp_fist"), aspect: A, t: 1100 },
    ]);
    expect(pose.name, describePose(pose)).toBe("fist");
  });

  it("an OK sign that opens into a palm lets go", () => {
    const pose = run([
      { obs: hand("c3_ok_over_eye"), aspect: A, t: 0 },
      { obs: hand("c3_ok_over_eye"), aspect: A, t: 100 },
      { obs: hand("d1_open_palm"), aspect: A, t: 1000 },
      { obs: hand("d1_open_palm"), aspect: A, t: 1100 },
    ]);
    expect(pose.name, describePose(pose)).toBe("palm");
  });
});
