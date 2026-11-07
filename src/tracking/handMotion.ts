import type { Vec2 } from "../geometry/vec";
import type { HandKinematics } from "../toy/types";
import { PointGlide, type GlideOptions } from "./glide";
import type { HandRole, TrackedHand } from "./handAssignment";
import { LM } from "./landmarks";

/**
 * Render-rate view of the tracked hands.
 *
 * Tracking results arrive 5–17 times a second; everything drawn on the hands (skeleton,
 * reticles, sparks, the fog wipe) is drawn 60 times a second. HandMotion keeps one
 * PointGlide per landmark per hand, so those consumers get positions and velocities that
 * move every frame instead of jumping with each result. It also answers two questions
 * the assigner does not: how fast is a hand moving, and how long has its track existed.
 */

const LANDMARKS = 21;

/** Landmarks behind `HandKinematics.tipVel`, in its order: thumb, index, middle, ring, pinky. */
export const TIP_LANDMARKS: readonly number[] = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];

export const HAND_MOTION_T = {
  /** Window of the palm-speed average, ms. */
  speedWindowMs: 250,
  /** Render frames kept for that average: covers the whole window up to 256 fps, a shorter one above. */
  speedHistory: 64,
  /** Dropped tracks kept for reuse, so a hand flickering at the edge of the picture does not rebuild 21 followers each time. */
  poolSize: 4,
} as const;

/** Everything remembered about one track id. */
class Track {
  id = 0;
  role: HandRole = "A";
  fresh = false;
  firstSeen = 0;
  /** Stamp of the last update() that contained this hand; anything older is dropped. */
  stamp = 0;
  readonly glides: PointGlide[] = [];

  // Palm-speed history, a ring of (time, distance travelled so far in px), one pair per render frame.
  private readonly hist = new Float64Array(HAND_MOTION_T.speedHistory * 2);
  private head = 0;
  private count = 0;
  private travelled = 0;
  private lastX = 0;
  private lastY = 0;
  private speed = 0;

  constructor(options: Partial<GlideOptions>) {
    for (let i = 0; i < LANDMARKS; i++) this.glides.push(new PointGlide(options));
  }

  /**
   * Start (or restart, when taken from the pool) as a new hand: every landmark snaps to
   * where it was first seen. A pooled follower is reset first so it carries nothing of the
   * hand it used to follow, in particular not a state time later than `time` (a reset
   * clock in tests, or tracking restarted), which would hold its output still.
   */
  begin(id: number, time: number, points: readonly Vec2[]) {
    this.id = id;
    this.firstSeen = time;
    for (let i = 0; i < LANDMARKS; i++) {
      this.glides[i].reset();
      this.glides[i].snap(points[i], time);
    }
    this.head = 0;
    this.count = 0;
    this.travelled = 0;
    this.speed = 0;
  }

  /**
   * Average speed of the glided palm over the last `speedWindowMs`, px/s: distance
   * travelled in the window over the window. `x`, `y` are the palm in stage space,
   * `w`, `h` the pixel size of the stage. Takes one entry per render frame; asking again
   * for the same frame returns the same answer.
   */
  palmSpeed(time: number, x: number, y: number, w: number, h: number): number {
    const size = HAND_MOTION_T.speedHistory;
    const hist = this.hist;
    if (this.count === 0) {
      this.lastX = x;
      this.lastY = y;
      this.push(time);
      return 0;
    }
    const newest = ((this.head + this.count - 1) % size) * 2;
    if (!(time > hist[newest])) return this.speed;

    this.travelled += Math.hypot((x - this.lastX) * w, (y - this.lastY) * h);
    this.lastX = x;
    this.lastY = y;
    // Keep exactly one entry at or before the start of the window, to interpolate the start from.
    const from = time - HAND_MOTION_T.speedWindowMs;
    while (this.count >= 2 && hist[((this.head + 1) % size) * 2] <= from) this.shift();
    if (this.count === size) this.shift();
    this.push(time);

    const t0 = hist[this.head * 2];
    const s0 = hist[this.head * 2 + 1];
    if (t0 >= from) {
      // The track is younger than the window: average over what there is.
      this.speed = ((this.travelled - s0) / (time - t0)) * 1000;
    } else {
      const next = ((this.head + 1) % size) * 2;
      const sFrom = s0 + ((hist[next + 1] - s0) * (from - t0)) / (hist[next] - t0);
      this.speed = ((this.travelled - sFrom) / HAND_MOTION_T.speedWindowMs) * 1000;
    }
    return this.speed;
  }

  private push(time: number) {
    const i = ((this.head + this.count) % HAND_MOTION_T.speedHistory) * 2;
    this.hist[i] = time;
    this.hist[i + 1] = this.travelled;
    this.count++;
  }

  private shift() {
    this.head = (this.head + 1) % HAND_MOTION_T.speedHistory;
    this.count--;
  }
}

const finite = (points: readonly Vec2[]) => {
  for (let i = 0; i < LANDMARKS; i++) if (!Number.isFinite(points[i].x) || !Number.isFinite(points[i].y)) return false;
  return true;
};

export class HandMotion {
  private readonly tracks = new Map<number, Track>();
  /** Live tracks in the order of the latest update(); snapshot() reports them in this order. */
  private readonly order: Track[] = [];
  private readonly pool: Track[] = [];
  private stamp = 0;
  private aspect = 16 / 9;
  private spaceW = 1280;
  private spaceH = 720;

  constructor(private readonly glide: Partial<GlideOptions> = {}) {}

  /**
   * Feed one tracking result (every hand the assigner currently tracks, coasting ones
   * included). A new id snaps to where it is first seen; an id that is no longer in
   * `hands` is forgotten at once. `aspect` is camera width / height; `space` is the
   * pixel size speeds are reported in (the camera frame).
   */
  update(time: number, hands: TrackedHand[], aspect: number, space: { w: number; h: number }): void {
    if (aspect > 0) this.aspect = aspect;
    if (space.w > 0 && space.h > 0) {
      this.spaceW = space.w;
      this.spaceH = space.h;
    }
    const stamp = ++this.stamp;
    this.order.length = 0;
    for (const hand of hands) {
      const points = hand.obs.points;
      if (points.length < LANDMARKS) continue;
      let track = this.tracks.get(hand.id);
      if (track) {
        if (track.stamp === stamp) continue; // the same id twice in one result: keep the first
        // A coasting hand repeats its last observation: the followers settle there, without lead.
        for (let i = 0; i < LANDMARKS; i++) track.glides[i].sample(points[i], time, hand.fresh);
      } else {
        if (!finite(points)) continue;
        track = this.pool.pop() ?? new Track(this.glide);
        track.begin(hand.id, time, points);
        this.tracks.set(hand.id, track);
      }
      track.role = hand.role;
      track.fresh = hand.fresh;
      track.stamp = stamp;
      this.order.push(track);
    }
    if (this.tracks.size !== this.order.length) {
      for (const track of this.tracks.values()) {
        if (track.stamp === stamp) continue;
        this.tracks.delete(track.id);
        if (this.pool.length < HAND_MOTION_T.poolSize) this.pool.push(track);
      }
    }
  }

  /** How long track `id` has existed at `time` (same clock as update()), ms. 0 for an id that is not tracked. */
  ageMs(id: number, time: number): number {
    const track = this.tracks.get(id);
    return track ? Math.max(0, time - track.firstSeen) : 0;
  }

  /**
   * The hands at render time `time`, in the order of the latest update(). Call once per
   * render frame with non-decreasing time. Everything returned is newly made and belongs
   * to the caller (keeping last frame's points to draw a path from is safe); nothing else
   * is allocated.
   */
  snapshot(time: number): HandKinematics[] {
    const out: HandKinematics[] = [];
    const aspect = this.aspect;
    for (let n = 0; n < this.order.length; n++) {
      const track = this.order[n];
      const points: Vec2[] = new Array(LANDMARKS);
      // Non-null: every follower of a live track was snapped in begin().
      for (let i = 0; i < LANDMARKS; i++) points[i] = track.glides[i].at(time)!;

      const tipVel: Vec2[] = new Array(TIP_LANDMARKS.length);
      for (let k = 0; k < TIP_LANDMARKS.length; k++) {
        const v = track.glides[TIP_LANDMARKS[k]].velocity; // a new object per read: scale it in place
        v.x *= 1000;
        v.y *= 1000;
        tipVel[k] = v;
      }

      const wrist = points[LM.WRIST];
      const index = points[LM.INDEX_MCP];
      const pinky = points[LM.PINKY_MCP];
      // Same centre as landmarks.palmCenter: wrist and the four finger bases.
      const palm: Vec2 = {
        x: (wrist.x + index.x + points[LM.MIDDLE_MCP].x + points[LM.RING_MCP].x + pinky.x) / 5,
        y: (wrist.y + index.y + points[LM.MIDDLE_MCP].y + points[LM.RING_MCP].y + pinky.y) / 5,
      };
      // Same scale as HandPose.s2: the longest side of the wrist / index-knuckle / pinky-knuckle triangle.
      const s2 = Math.max(
        Math.hypot((wrist.x - index.x) * aspect, wrist.y - index.y),
        Math.hypot((index.x - pinky.x) * aspect, index.y - pinky.y),
        Math.hypot((pinky.x - wrist.x) * aspect, pinky.y - wrist.y),
      );

      out.push({
        id: track.id,
        role: track.role,
        fresh: track.fresh,
        points,
        tipVel,
        palm,
        speedPx: track.palmSpeed(time, palm.x, palm.y, this.spaceW, this.spaceH),
        s2,
      });
    }
    return out;
  }

  /** Forget every hand (tracking was restarted). */
  reset(): void {
    for (const track of this.tracks.values()) {
      if (this.pool.length < HAND_MOTION_T.poolSize) this.pool.push(track);
    }
    this.tracks.clear();
    this.order.length = 0;
  }
}
