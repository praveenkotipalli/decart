import type { HandFrame, HandObservation } from "./landmarks";
import { framePose, syntheticHand, type SyntheticHandPose } from "./syntheticHand";

const LOOP = 26;
const CENTER = { x: 0.5, y: 0.53 };

const smooth = (a: number, b: number, t: number) => {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** 0 outside [a,d], ramps up over [a,b], holds, ramps down over [c,d]. */
const window4 = (a: number, b: number, c: number, d: number, t: number) => smooth(a, b, t) * (1 - smooth(c, d, t));

export interface SimBeat {
  label: string;
  from: number;
}

/** What the scripted demo is doing, for the on-screen caption. */
export const SIM_BEATS: SimBeat[] = [
  { label: "Raising hands — portal opens", from: 0 },
  { label: "Rotate: turn both hands together", from: 3 },
  { label: "Scale: hands apart and together", from: 7 },
  { label: "Tilt & twist: corners move independently", from: 10.5 },
  { label: "Pinch thumb + middle: lock", from: 13.5 },
  { label: "Locked: hands move, portal stays", from: 14.4 },
  { label: "Pinch again: unlock", from: 17 },
  { label: "Brief tracking loss: portal coasts", from: 18.6 },
  { label: "Fingers cross: last valid shape is held", from: 20.5 },
  { label: "Back to neutral", from: 23.5 },
];

export function simBeat(t: number): string {
  const T = t % LOOP;
  let label = SIM_BEATS[0].label;
  for (const b of SIM_BEATS) if (T >= b.from) label = b.label;
  return label;
}

/**
 * A scripted pair of synthetic hands that walks through every interaction:
 * rotate, scale, tilt, twist, lock, coast through a dropout, and cross. Lets the
 * whole pipeline be demonstrated (and screenshot-tested) without a camera.
 */
export class SimulatedHands {
  private seed = 1;

  private noise() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed / 2147483647 - 0.5) * 0.0022;
  }

  frame(timeMs: number, aspect = 16 / 9): HandFrame {
    const T = (timeMs / 1000) % LOOP;
    const enter = smooth(0, 1.4, T) * (1 - smooth(25.2, 26, T));
    const rot = 0.55 * Math.sin(((T - 3) / 4) * Math.PI * 2) * window4(3, 3.6, 6.4, 7, T);
    const spread = 1 + 0.42 * Math.sin(((T - 7) / 3.5) * Math.PI * 2) * window4(7, 7.5, 10, 10.5, T);
    const tilt = window4(10.5, 11.3, 12.6, 13.3, T);
    const drift = window4(14.4, 15, 16.4, 16.9, T);
    const cross = window4(20.5, 21.3, 22.8, 23.5, T);

    // Choreographed for landscape; on narrow (portrait) stages shrink the whole pose
    // so both hands and the portal stay in frame.
    const k = Math.min(1, aspect / 0.85);
    const half = ((0.267 * k) / aspect) * spread;
    const place = (side: "A" | "B"): SyntheticHandPose => {
      const sign = side === "A" ? -1 : 1;
      let x = CENTER.x + sign * half + 0.06 * Math.sin(T * 1.7) * drift;
      let y = CENTER.y + (1 - enter) * 0.7 + 0.03 * Math.sin(T * 2.3) * drift - sign * 0.07 * tilt;
      // Rotate the pair about the centre (in isotropic units).
      const dx = (x - CENTER.x) * aspect;
      const dy = y - CENTER.y;
      x = CENTER.x + (dx * Math.cos(rot) - dy * Math.sin(rot)) / aspect + this.noise();
      y = CENTER.y + dx * Math.sin(rot) + dy * Math.cos(rot) + this.noise();
      const pose = framePose(side, {
        x,
        y,
        rotation: rot + (side === "A" ? -1 : 1) * 0.12 * tilt + (side === "A" ? 1.25 * cross : 0),
        size: 0.15 * k * (0.9 + 0.12 * spread),
        thumbAngle: 150 + (side === "B" ? 28 * tilt : 0),
      });
      if (side === "A") pose.x += ((0.125 * k) / aspect) * cross;
      const pinching = (T > 13.5 && T < 14.25) || (T > 17 && T < 17.75);
      if (side === "B" && pinching) pose.thumbTo = "middle";
      return pose;
    };

    const hands: HandObservation[] = [];
    if (enter > 0.01) {
      hands.push(syntheticHand(place("A"), aspect));
      const dropout = T > 18.6 && T < 18.95;
      if (!dropout) hands.push(syntheticHand(place("B"), aspect));
    }
    return { time: timeMs, hands, aspect, inferenceMs: 0 };
  }
}
