/**
 * Pose classification on the synthetic hand (tests/realHands.test.ts covers real landmarks).
 * Every fixture here is built with syntheticPoses.ts; the numbers quoted in comments were
 * measured on the real syntheticHand, not computed by hand.
 */
import { describe, expect, it } from "vitest";
import { classifyHand, type HandShape } from "../src/gestures/classifier";
import { POSE_T, classifyPose, describePose } from "../src/gestures/poses";
import { LM, palmCenter, type HandObservation } from "../src/tracking/landmarks";
import { syntheticHand, type SyntheticHandPose } from "../src/tracking/syntheticHand";
import { fistPose, lPose, okPose, openPose, pointPose, turnHand } from "../src/tracking/syntheticPoses";
import type { HandPose } from "../src/toy/types";

const ASPECT = 16 / 9;
const rad = (deg: number) => (deg * Math.PI) / 180;
const obsOf = (p: SyntheticHandPose) => syntheticHand(p, ASPECT);

/** One fresh result: no previous pose, no previous shape. */
function fresh(p: SyntheticHandPose | HandObservation, t = 0): HandPose {
  const obs = "points" in p ? p : obsOf(p);
  return classifyPose(obs, classifyHand(obs.world), ASPECT, t);
}

/** The world landmarks shrunk uniformly, as a collapsed metric fit: the image-space path must take over. */
const collapsed = (obs: HandObservation, k = 0.3): HandObservation => ({
  ...obs,
  world: obs.world.map((p) => ({ x: p.x * k, y: p.y * k, z: p.z * k })),
});

/** A chain of results, each classified with the previous shape and pose, as the controller does it. */
function chain(steps: { obs: HandObservation; t: number }[]): HandPose[] {
  let shape: HandShape | undefined;
  let pose: HandPose | undefined;
  const out: HandPose[] = [];
  for (const s of steps) {
    shape = classifyHand(s.obs.world, shape);
    pose = classifyPose(s.obs, shape, ASPECT, s.t, pose);
    out.push(pose);
  }
  return out;
}
const hold = (obs: HandObservation, n: number, dt = 100, t0 = 0) => Array.from({ length: n }, (_, i) => ({ obs, t: t0 + i * dt }));
const last = <T>(a: T[]): T => a[a.length - 1];
const why = (p: HandPose) => `${p.name}: ${describePose(p)}`;

const SIDES = ["A", "B"] as const;
const SIZES = [0.05, 0.08, 0.12, 0.16, 0.22, 0.3];
const ROTATIONS = [0, 45, 90, 180];

describe("section 3.1 fixture values, measured on the real syntheticHand", () => {
  it("frame pose: curl angles 81 / 54 / 40, tips inside, phi 111, cPalm ±0.77, cL ∓0.93", () => {
    for (const side of SIDES) {
      const p = fresh(lPose(side));
      expect(p.curlDeg[0]).toBeCloseTo(81.3, 0);
      expect(p.curlDeg[1]).toBeCloseTo(53.5, 0);
      expect(p.curlDeg[2]).toBeCloseTo(40.1, 0);
      expect(p.curled).toEqual([true, true, true]);
      expect(p.phiDeg).toBeCloseTo(111, 0);
      expect(Math.abs(p.cPalm)).toBeCloseTo(0.773, 2);
      expect(Math.abs(p.cL)).toBeCloseTo(0.934, 2);
      expect(Math.sign(p.cL)).toBe(-Math.sign(p.cPalm));
      expect(p.worldOk).toBe(true);
      expect(p.s2).toBeCloseTo(0.16, 2);
    }
    // A is the screen-left hand (mirrored right hand): its palm winds the other way.
    expect(Math.sign(fresh(lPose("A")).cPalm)).toBe(-Math.sign(fresh(lPose("B")).cPalm));
  });

  it("open palm: curl angles 170–179, tips not inside, phi 46", () => {
    const p = fresh(openPose("B"));
    for (const d of p.curlDeg) expect(d).toBeGreaterThan(170);
    expect(p.curled).toEqual([false, false, false]);
    expect(p.phiDeg).toBeCloseTo(46, 0);
  });

  it("curl 0.25 → 135°, curl 0.40 → 108° (the design said 133 and 107)", () => {
    expect(fresh(lPose("B", { curls: [0, 0, 0.25, 0.7, 0.75] })).curlDeg[0]).toBeCloseTo(135.2, 0);
    expect(fresh(lPose("B", { curls: [0, 0, 0.4, 0.7, 0.75] })).curlDeg[0]).toBeCloseTo(108.3, 0);
  });

  it("OK fixture: ring openness 0.17", () => {
    expect(fresh(okPose("B")).ring!.openness).toBeCloseTo(0.172, 2);
  });
});

describe("the L", () => {
  it("lPose is an L for both chiralities, sizes 0.05–0.30 and rotations 0 / 45 / 90 / 180", () => {
    for (const side of SIDES)
      for (const size of SIZES)
        for (const deg of ROTATIONS) {
          const p = fresh(lPose(side, { x: 0.5, y: 0.5, size, rotation: rad(deg) }));
          expect(p.name, `${side} size ${size} rot ${deg}: ${why(p)}`).toBe("L");
          expect(p.l).toBe(true);
          expect(p.uncertain).toBe(false);
          expect(p.worldOk).toBe(true);
        }
  });

  it("world landmarks scaled by 0.3 still give an L through the image-space path", () => {
    for (const side of SIDES)
      for (const size of SIZES)
        for (const deg of ROTATIONS) {
          const p = fresh(collapsed(obsOf(lPose(side, { x: 0.5, y: 0.5, size, rotation: rad(deg) }))));
          expect(p.worldOk, `${side} size ${size} rot ${deg}`).toBe(false);
          expect(p.name, `${side} size ${size} rot ${deg}: ${why(p)}`).toBe("L");
        }
  });

  it("phiDeg is the image angle, whatever the world landmarks say", () => {
    const obs = obsOf(lPose("B"));
    // Same picture, but the thumb tip 5 cm nearer the camera in the metric hand: the world angle changes, the image one must not.
    const world = obs.world.map((p) => ({ ...p }));
    world[LM.THUMB_TIP] = { ...world[LM.THUMB_TIP], z: world[LM.THUMB_TIP].z - 0.05 };
    const skewed: HandObservation = { ...obs, world };
    const a = fresh(obs);
    const b = fresh(skewed);
    expect(b.phiDeg).toBeCloseTo(a.phiDeg, 6);
    expect(describePose(b)).not.toBe(describePose(a)); // the readout still shows the world angle
  });

  it("an open palm with the thumb wide is a palm, not an L", () => {
    for (const p of [openPose("B", { thumbAngle: 150 }), openPose("A", { thumbAngle: 150 }), openPose("B"), openPose("B", { spread: 1.6 })]) {
      const pose = fresh(p);
      expect(pose.name, why(pose)).toBe("palm");
      expect(pose.l).toBe(false);
      // The thumb and the angle alone would make an L; only the straight fingers say no.
      expect(pose.indexOut && pose.thumbOut).toBe(true);
      expect(pose.curled).toEqual([false, false, false]);
    }
  });

  it("a fist is a fist, with or without trusted world landmarks", () => {
    for (const side of SIDES) {
      const obs = obsOf(fistPose(side));
      expect(fresh(obs).name, why(fresh(obs))).toBe("fist");
      expect(fresh(collapsed(obs)).name, why(fresh(collapsed(obs)))).toBe("fist");
    }
  });

  it("a tucked-thumb point is a point, not an L", () => {
    for (const side of SIDES) {
      const obs = obsOf(pointPose(side));
      for (const p of [fresh(obs), fresh(collapsed(obs))]) {
        expect(p.name, why(p)).toBe("point");
        expect(p.thumbOut).toBe(false);
        expect(p.indexOut).toBe(true);
      }
    }
  });

  it("index up with the thumb held against the fist is not an L (thumb curl 0.7–1 over the frame curls)", () => {
    for (const c of [0.7, 0.85, 1]) {
      const p = fresh(lPose("B", { curls: [c, 0, 0.55, 0.7, 0.75] }));
      expect(p.l, `thumb curl ${c}: ${why(p)}`).toBe(false);
      expect(p.name, `thumb curl ${c}: ${why(p)}`).toBe("point");
    }
  });

  it("index up with the thumb alongside it (angle under 30°) is not an L", () => {
    for (const thumbAngle of [240, 250, 260]) {
      const p = fresh(lPose("B", { thumbAngle }));
      expect(p.l, `thumb at ${thumbAngle}: ${why(p)}`).toBe(false);
      expect(p.phiDeg).toBeLessThan(POSE_T.phiStay);
    }
  });

  it("the OK sign is OK, not L, with or without trusted world landmarks", () => {
    for (const side of SIDES) {
      const obs = obsOf(okPose(side));
      for (const p of [fresh(obs), fresh(collapsed(obs))]) {
        expect(p.name, why(p)).toBe("OK");
        expect(p.l).toBe(false);
        expect(p.ring!.openness).toBeGreaterThanOrEqual(POSE_T.ringEnter);
        expect(p.pinchRatio).toBeLessThan(POSE_T.pinch2dEnter);
      }
    }
  });

  it("a half-bent middle finger (curl 0.4) is still an L", () => {
    const p = fresh(lPose("B", { curls: [0, 0, 0.4, 0.7, 0.75] }));
    expect(p.name, why(p)).toBe("L");
    // 108° is above curlEnter (105): the ring and pinky carry the L.
    expect(p.curled).toEqual([false, true, true]);
  });

  it("three fingers at curl 0.33 (or 0.37) do not start an L but keep one", () => {
    const l = obsOf(lPose("B"));
    for (const c of [0.33, 0.37]) {
      const loose = obsOf(lPose("B", { curls: [0, 0, c, c, c] }));
      const started = fresh(loose);
      expect(started.l, `fresh at ${c}: ${why(started)}`).toBe(false);
      const kept = last(chain([...hold(l, 2), { obs: loose, t: 200 }]));
      expect(kept.name, `kept at ${c}: ${why(kept)}`).toBe("L");
      expect(kept.curled.some(Boolean)).toBe(true);
    }
  });

  it("three fingers straightened to curl 0.2 end the L", () => {
    const p = last(chain([...hold(obsOf(lPose("B")), 2), { obs: obsOf(lPose("B", { curls: [0, 0, 0.2, 0.2, 0.2] })), t: 200 }]));
    expect(p.l, why(p)).toBe(false);
    expect(p.curled).toEqual([false, false, false]);
  });

  it("a '3' (middle finger straight, ring and pinky curled, thumb out) does not start an L", () => {
    const p = fresh(lPose("B", { curls: [0, 0, 0, 0.7, 0.75] }));
    expect(p.l, why(p)).toBe(false);
    expect(p.curled).toEqual([false, true, true]); // curledCount alone would have let it in
  });

  it("the angle has hysteresis: 39° does not start an L, keeps one; 26° ends it", () => {
    const l = obsOf(lPose("B"));
    const at39 = obsOf(lPose("B", { thumbAngle: 222 })); // phi = 261 - thumbAngle on this hand
    const at26 = obsOf(lPose("B", { thumbAngle: 235 }));
    const f = fresh(at39);
    expect(f.phiDeg).toBeCloseTo(39, 0);
    expect(f.l, why(f)).toBe(false);
    const kept = last(chain([...hold(l, 2), { obs: at39, t: 200 }]));
    expect(kept.name, why(kept)).toBe("L");
    const lost = last(chain([...hold(l, 2), { obs: at26, t: 200 }]));
    expect(lost.l, why(lost)).toBe(false);
  });

  it("a relaxed thumb (phi 46) still makes an L; the thumb flag survives the collapsed world", () => {
    const obs = obsOf(lPose("B", { thumbAngle: 215 }));
    expect(fresh(obs).name, why(fresh(obs))).toBe("L");
    // thumb2d is 0.67 here, under the image-space enter threshold: without world landmarks it starts as a point…
    const cold = fresh(collapsed(obs));
    expect(cold.thumbOut).toBe(false);
    // …but a hand that already held an L keeps its thumb flag (stay 0.55) when the world drops out.
    const warm = last(chain([...hold(obs, 2), { obs: collapsed(obs), t: 200 }]));
    expect(warm.name, why(warm)).toBe("L");
  });
});

describe("transitions (what a release looks like)", () => {
  const twoLs = hold(obsOf(lPose("B")), 2);

  it("an L that opens into a palm lets go", () => {
    for (const open of [openPose("B"), openPose("B", { thumbAngle: 150 })]) {
      const o = obsOf(open);
      expect(last(chain([...twoLs, { obs: o, t: 200 }])).name).toBe("palm");
      expect(last(chain([...twoLs, { obs: collapsed(o), t: 200 }])).name).toBe("palm");
    }
  });

  it("an L that closes into a fist lets go", () => {
    expect(last(chain([...twoLs, { obs: obsOf(fistPose("B")), t: 200 }])).name).toBe("fist");
  });

  it("an L whose thumb tucks in becomes a point", () => {
    expect(last(chain([...twoLs, { obs: obsOf(pointPose("B")), t: 200 }])).name).toBe("point");
  });

  it("an L whose thumb meets the index tip becomes an OK sign", () => {
    expect(last(chain([...twoLs, { obs: obsOf(okPose("B")), t: 200 }])).name).toBe("OK");
  });

  it("an OK sign that opens into a palm, or closes into a fist, lets go", () => {
    const twoOks = hold(obsOf(okPose("B")), 2);
    expect(last(chain([...twoOks, { obs: obsOf(openPose("B")), t: 200 }])).name).toBe("palm");
    expect(last(chain([...twoOks, { obs: obsOf(fistPose("B")), t: 200 }])).name).toBe("fist");
  });

  it("an OK sign lasts while the pinch and the ring do, whatever the other fingers do", () => {
    for (const c of [0.6, 1]) {
      const curledOthers = obsOf(okPose("B", { curls: [0, 0.45, c, c, c] }));
      const started = fresh(curledOthers);
      expect(started.name, `fresh, others at ${c}: ${why(started)}`).not.toBe("OK"); // needs two straight fingers to start
      const kept = last(chain([...hold(obsOf(okPose("B")), 2), { obs: curledOthers, t: 200 }]));
      expect(kept.name, `kept, others at ${c}: ${why(kept)}`).toBe("OK");
    }
  });

  it("at 5 Hz a held L is an L on every result and never uncertain", () => {
    const poses = chain(hold(obsOf(lPose("A")), 10, 200));
    for (const p of poses) {
      expect(p.name).toBe("L");
      expect(p.uncertain).toBe(false);
    }
  });
});

describe("uncertain results", () => {
  const outside = (obs: HandObservation) => obs.points.filter((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1).length;

  it("more than 4 landmarks outside the picture are not trusted; 4 or fewer are", () => {
    let trusted = 0;
    let clipped = 0;
    for (const x of [0.9, 0.95, 0.97, 0.98, 1.0, 1.05, 1.1]) {
      const obs = obsOf(lPose("B", { x }));
      const p = fresh(obs);
      expect(p.uncertain, `x ${x}, ${outside(obs)} outside`).toBe(outside(obs) > POSE_T.maxOutOfFrame);
      if (p.uncertain) clipped++;
      else trusted++;
    }
    expect(trusted).toBeGreaterThan(0);
    expect(clipped).toBeGreaterThan(0);
  });

  it("a hand leaving the frame holds its previous flags and marks the result uncertain", () => {
    const l = obsOf(lPose("B"));
    const gone = obsOf(lPose("B", { x: 1.1 }));
    expect(outside(gone)).toBeGreaterThan(POSE_T.maxOutOfFrame);
    const [, prev, held] = chain([...hold(l, 2), { obs: gone, t: 200 }]);
    expect(held.uncertain).toBe(true);
    expect(held.name).toBe("L");
    expect(held.l).toBe(true);
    expect(held.indexOut).toBe(prev.indexOut);
    expect(held.thumbOut).toBe(prev.thumbOut);
    expect(held.curled).toEqual(prev.curled);
    expect(held.s2).toBe(prev.s2);
    expect(held.facing).toBe(0); // an untrusted result does not vote
    expect(held.at).toBe(200);
    expect(describePose(held)).toMatch(/\?$/);
  });

  it("a clipped hand seen for the first time has no pose", () => {
    const p = fresh(obsOf(lPose("B", { x: 1.1 })));
    expect(p.uncertain).toBe(true);
    expect(p.name).toBeNull();
    expect([p.l, p.ok, p.point, p.fist, p.palm]).toEqual([false, false, false, false, false]);
  });

  it("a 40% size jump inside 300 ms holds the previous flags, and is accepted when the next result agrees", () => {
    const small = obsOf(lPose("B", { size: 0.16 }));
    const big = obsOf(lPose("B", { size: 0.26 })); // +62%
    const poses = chain([...hold(small, 2), { obs: big, t: 200 }, { obs: big, t: 300 }]);
    expect(poses[2].uncertain).toBe(true);
    expect(poses[2].s2).toBeCloseTo(poses[1].s2, 9);
    expect(poses[2].name).toBe("L");
    expect(poses[3].uncertain).toBe(false);
    expect(poses[3].s2).toBeCloseTo(0.26, 2);
    expect(poses[3].name).toBe("L");
  });

  it("a one-off size glitch is dropped and the old size resumes without a second hold", () => {
    const small = obsOf(lPose("B", { size: 0.16 }));
    const glitch = obsOf(lPose("B", { size: 0.08 })); // -50%
    const poses = chain([...hold(small, 2), { obs: glitch, t: 200 }, { obs: small, t: 300 }]);
    expect(poses[2].uncertain).toBe(true);
    expect(poses[3].uncertain).toBe(false);
    expect(poses[3].s2).toBeCloseTo(0.16, 2);
  });

  it("a size change after a 400 ms gap (a dropped result) is accepted at once", () => {
    const small = obsOf(lPose("B", { size: 0.16 }));
    const big = obsOf(lPose("B", { size: 0.26 }));
    const p = last(chain([...hold(small, 2), { obs: big, t: 500 }]));
    expect(p.uncertain).toBe(false);
    expect(p.s2).toBeCloseTo(0.26, 2);
  });

  it("a 30% size change is trusted", () => {
    const p = last(chain([...hold(obsOf(lPose("B", { size: 0.16 })), 2), { obs: obsOf(lPose("B", { size: 0.2 })), t: 200 }]));
    expect(p.uncertain).toBe(false);
  });
});

describe("turnHand", () => {
  const base = obsOf(lPose("B"));
  const worldWinding = (o: HandObservation) => {
    const w = o.world;
    const a = { x: w[LM.INDEX_MCP].x - w[LM.WRIST].x, y: w[LM.INDEX_MCP].y - w[LM.WRIST].y };
    const b = { x: w[LM.PINKY_MCP].x - w[LM.WRIST].x, y: w[LM.PINKY_MCP].y - w[LM.WRIST].y };
    return Math.sign(a.x * b.y - a.y * b.x);
  };

  it("a half turn about the forearm shows the back of the hand: the sign of cPalm flips", () => {
    const turned = turnHand(base, { turn: Math.PI }, ASPECT);
    const a = fresh(base);
    const b = fresh(turned);
    expect(Math.sign(b.cPalm)).toBe(-Math.sign(a.cPalm));
    expect(Math.abs(b.cPalm)).toBeCloseTo(Math.abs(a.cPalm), 6);
    expect(b.facing).toBe(-a.facing);
    expect(worldWinding(turned)).toBe(-worldWinding(base));
    // Still an L, seen from behind: the toy must keep the frame while a hand is turned over.
    expect(b.name, why(b)).toBe("L");
  });

  it("tipping the hand over (pitch) flips it too, and leaves the index pointing the other way", () => {
    const tipped = turnHand(base, { pitch: Math.PI }, ASPECT);
    const b = fresh(tipped);
    expect(Math.sign(b.cPalm)).toBe(-Math.sign(fresh(base).cPalm));
    expect(Math.sign(tipped.points[LM.INDEX_TIP].y - tipped.points[LM.INDEX_MCP].y)).toBe(
      -Math.sign(base.points[LM.INDEX_TIP].y - base.points[LM.INDEX_MCP].y),
    );
  });

  it("is rigid and keeps the palm centre: a copy for zero rotation, same distances otherwise", () => {
    const same = turnHand(base, {}, ASPECT);
    expect(same.points).toEqual(base.points);
    expect(same.points).not.toBe(base.points);
    expect(same.world).toEqual(base.world);
    const turned = turnHand(base, { turn: 1, pitch: 0.5 }, ASPECT);
    const c0 = palmCenter(base.points);
    const c1 = palmCenter(turned.points);
    expect(c1.x).toBeCloseTo(c0.x, 9);
    expect(c1.y).toBeCloseTo(c0.y, 9);
    const d = (o: HandObservation, i: number, j: number) => Math.hypot(o.world[i].x - o.world[j].x, o.world[i].y - o.world[j].y, o.world[i].z - o.world[j].z);
    expect(d(turned, LM.WRIST, LM.INDEX_TIP)).toBeCloseTo(d(base, LM.WRIST, LM.INDEX_TIP), 9);
    expect(d(turned, LM.THUMB_TIP, LM.PINKY_TIP)).toBeCloseTo(d(base, LM.THUMB_TIP, LM.PINKY_TIP), 9);
    const iso = (o: HandObservation, i: number, j: number) =>
      Math.hypot((o.points[i].x - o.points[j].x) * ASPECT, o.points[i].y - o.points[j].y, o.points[i].z - o.points[j].z);
    expect(iso(turned, LM.WRIST, LM.MIDDLE_TIP)).toBeCloseTo(iso(base, LM.WRIST, LM.MIDDLE_TIP), 9);
  });

  it("the facing vote never contradicts the side that faces the camera through a turn", () => {
    const start = fresh(base).facing;
    expect(start).not.toBe(0);
    for (const axis of ["turn", "pitch"] as const)
      for (let deg = 0; deg <= 180; deg += 10) {
        const p = fresh(turnHand(base, { [axis]: rad(deg) }, ASPECT));
        const expected = deg < 90 ? start : deg > 90 ? -start : 0;
        expect([expected, 0], `${axis} ${deg}: ${why(p)}`).toContain(p.facing);
      }
  });

  it("an L turned edge-on is not called a release pose", () => {
    for (const axis of ["turn", "pitch"] as const)
      for (const deg of [60, 80, 90, 100, 120]) {
        const p = fresh(turnHand(base, { [axis]: rad(deg) }, ASPECT));
        expect(["palm", "fist", "OK"], `${axis} ${deg}: ${why(p)}`).not.toContain(p.name);
      }
  });
});

describe("the OK ring", () => {
  it("its centre lies between thumb and index finger, in stage space", () => {
    for (const side of SIDES) {
      const obs = obsOf(okPose(side));
      const ring = fresh(obs).ring!;
      const ids = [LM.THUMB_TIP, LM.INDEX_TIP, LM.THUMB_MCP, LM.INDEX_MCP];
      const xs = ids.map((i) => obs.points[i].x);
      const ys = ids.map((i) => obs.points[i].y);
      expect(ring.center.x).toBeGreaterThan(Math.min(...xs));
      expect(ring.center.x).toBeLessThan(Math.max(...xs));
      expect(ring.center.y).toBeGreaterThan(Math.min(...ys));
      expect(ring.center.y).toBeLessThan(Math.max(...ys));
    }
  });

  it("rEq is in frame heights and openness is scale-free", () => {
    const a = fresh(okPose("B", { size: 0.1 })).ring!;
    const b = fresh(okPose("B", { size: 0.2 })).ring!;
    expect(b.rEq / a.rEq).toBeCloseTo(2, 3);
    expect(b.openness).toBeCloseTo(a.openness, 6);
  });

  it("the ring is measured on every result, open or not", () => {
    expect(fresh(lPose("B")).ring).not.toBeNull();
    expect(fresh(fistPose("B")).ring!.openness).toBeLessThan(fresh(okPose("B")).ring!.openness);
  });
});

describe("the result", () => {
  const KEYS = [
    "name", "l", "ok", "point", "fist", "palm", "indexOut", "thumbOut", "curled", "curlDeg", "phiDeg", "pinchRatio",
    "worldOk", "uncertain", "s2", "cPalm", "cL", "facing", "ring", "at",
  ];

  it("fills every field of HandPose, trusted or not", () => {
    for (const p of [fresh(lPose("A")), fresh(obsOf(lPose("B", { x: 1.1 })))]) {
      for (const k of KEYS) expect(p, k).toHaveProperty(k);
      expect(p.curled).toHaveLength(3);
      expect(p.curlDeg).toHaveLength(3);
      expect([1, -1, 0]).toContain(p.facing);
      expect(Number.isFinite(p.phiDeg)).toBe(true);
      expect(Number.isFinite(p.pinchRatio)).toBe(true);
    }
  });

  it("names exactly one pose, and the booleans mirror the name", () => {
    for (const p of [fresh(lPose("A")), fresh(okPose("B")), fresh(pointPose("B")), fresh(fistPose("A")), fresh(openPose("B"))]) {
      const flags = [p.l, p.ok, p.point, p.fist, p.palm];
      expect(flags.filter(Boolean)).toHaveLength(1);
      const names = ["L", "OK", "point", "fist", "palm"];
      expect(names[flags.indexOf(true)]).toBe(p.name);
    }
  });

  it("the two hands of a frame vote opposite ways", () => {
    const a = fresh(lPose("A"));
    const b = fresh(lPose("B"));
    expect(a.facing).not.toBe(0);
    expect(b.facing).toBe(-a.facing);
  });

  it("describePose is one line with the angle, the three curls, the windings, the pinch, the ring and the flags", () => {
    const s = describePose(fresh(lPose("B")));
    expect(s).not.toMatch(/\n/);
    expect(s).toMatch(/^phi 111\/111 · curl 81\/5[34]\/40 · cP \+0\.77 cL -0\.93 · pinch \d+\.\d\d · ring 0\.44 · s2 0\.16 · IT MRP 3d f\+$/);
    expect(describePose(fresh(collapsed(obsOf(lPose("B")))))).toContain(" 2d ");
  });
});
