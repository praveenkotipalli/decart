/**
 * "Flip one hand": the gesture that steps the filter.
 *
 * Two signals make one episode:
 *  - the FACING of each hand (which side faces the camera), latched from the per-result
 *    votes in HandPose.facing. A hand whose latched facing differs from what it was when the
 *    frame opened has been turned over;
 *  - the TWIST of the quad: the top and bottom edges of the frame cross when one hand is
 *    tipped over or turned half way round in the picture.
 * Turning a hand about the forearm changes the facing without a twist; tipping it over does
 * both; an in-plane half turn twists without changing the facing. The episode is "active"
 * while either signal says so, and ONE event fires on its rising edge: a flick over and back
 * is exactly one step, and turning back only re-arms.
 *
 * Everything else here is guards against the ways a 5–17 Hz tracker lies: one-result sign
 * glitches, a frame that opens already twisted, a track that dies mid-turn and is reborn, and
 * the assigner handing the two hands' data to each other's roles (both facings change at once).
 *
 * Pure: per tracking result, plain data in, at most one event out.
 */
import { POSE_T } from "../gestures/poses";
import type { HandRole } from "../tracking/handAssignment";
import { LM } from "../tracking/landmarks";
import type { HandSample } from "./types";

export interface FlipEvent {
  time: number;
  /** The hand that was turned over, or null when only the twist of the quad said so. */
  role: HandRole | null;
  cause: "facing" | "twist";
}

export const FLIP_T = {
  /** A new facing replaces the latched one after this many results spanning at least this long. */
  latchMs: 150,
  latchResults: 2,
  /** A candidate facing that has not latched after this long is forgotten, ms. */
  pendingMaxMs: 900,
  /** The twist turns on (and off) after this many crossed (uncrossed) results spanning at least this long. */
  twistMs: 200,
  twistResults: 2,
  /** No second event sooner than this after one, ms. */
  cooldownMs: 700,
  /** No event in the first part of a freshly opened frame: the hands are still settling, ms. */
  openBlankMs: 300,
  /** Both hands' facings changing within this of each other is the assigner swapping them, not a flip, ms. */
  swapVetoMs: 300,
  /** Votes of a track younger than this are not counted (a new track's first results wander), ms. */
  minTrackAgeMs: 400,
  /** A role's latched facing survives this long after its track dies, so a reborn track continues the story, ms. */
  roleMemoryMs: 1500,
  /** A flip is honoured while the frame is open or locked, or closed less than this long ago, ms. */
  recentOpenMs: 1500,
  /** The crossing point must lie this far along both edges (fractions) for a twist to count… */
  twistMin: 0.12,
  twistMax: 0.88,
  /** …and both side chords (index tip to thumb tip of one hand) must be at least this long, frame heights. */
  minChord: 0.04,
  /**
   * While the palm is edge-on the vote comes from the index–thumb winding alone; it counts only
   * if both fingers still project to at least this fraction of the hand size, because the sign
   * of a finger foreshortened to nothing is noise. 0 disables the check.
   */
  edgeVoteMin: 0.15,
} as const;

type Sign = 1 | -1 | 0;

/** Everything remembered about one role. */
interface RoleState {
  latched: Sign;
  /** The facing the frame opened with (or the first one latched after that). 0 = not yet known. */
  baseline: Sign;
  /** A sign that disagrees with the latch and is collecting the results it needs. */
  pending: { sign: Sign; count: number; since: number } | null;
  /** When the latched sign last changed from one side to the other; -Infinity if never. */
  changedAt: number;
  /** The last update that contained a hand of this role; -Infinity if none yet. */
  lastSeen: number;
  present: boolean;
  /** This result's counted vote (0 when it did not count). */
  vote: Sign;
  /** `flipped` as of the previous update. */
  wasFlipped: boolean;
}

const freshRole = (): RoleState => ({
  latched: 0,
  baseline: 0,
  pending: null,
  changedAt: -Infinity,
  lastSeen: -Infinity,
  present: false,
  vote: 0,
  wasFlipped: false,
});

const ROLES: readonly HandRole[] = ["A", "B"];

export class FlipDetector {
  private readonly roles: Record<HandRole, RoleState> = { A: freshRole(), B: freshRole() };

  private twistOn = false;
  /** When the current run of results disagreeing with `twistOn` began, and how many there were. */
  private twistSince: number | null = null;
  private twistCount = 0;

  private wasOpen = false;
  private wasActive = false;
  private blankUntil = -Infinity;
  private lastEventAt = -Infinity;
  /** A facing event waiting for the other hand to confirm it did not change too. */
  private deferred: { role: HandRole; since: number } | null = null;

  /**
   * One tracking result. `hands` is every hand the assigner tracks (coasting ones included);
   * `frame` is the gate's state and the frame controller's twist for the same result; `aspect`
   * (camera width / height) lets finger lengths be measured in frame heights for the edge-on
   * vote check, and may be left out when the camera is 16:9.
   */
  update(
    time: number,
    hands: HandSample[],
    frame: { open: boolean; locked: boolean; openedAt: number; closedAt: number; twistValid: boolean },
    aspect = 16 / 9,
  ): FlipEvent | null {
    const T = FLIP_T;

    // ── Facing latches ──────────────────────────────────────────────────────────────────────
    for (const role of ROLES) {
      const r = this.roles[role];
      const h = hands.find((s) => s.role === role);
      if (!h) {
        r.present = false;
        r.vote = 0;
        // A dead track's facing is kept a while so a hand that is lost mid-turn and found again
        // still reads as turned; after that the role starts over.
        if (time - r.lastSeen > T.roleMemoryMs) this.roles[role] = { ...freshRole(), wasFlipped: false };
        continue;
      }
      r.present = true;
      r.lastSeen = time;
      r.vote = voteOf(h, aspect);
      this.latch(r, r.vote, time);
    }

    // ── Opening ─────────────────────────────────────────────────────────────────────────────
    const opening = frame.open && !this.wasOpen;
    this.wasOpen = frame.open;
    if (opening && !(time - frame.closedAt < T.recentOpenMs)) {
      // A cold open: whatever the hands look like now is the reference, and nothing fires
      // until they have settled. (A warm re-open keeps the story going: the flip of a hand
      // that made the frame waver and come back is still a flip.)
      for (const role of ROLES) this.roles[role].baseline = this.roles[role].latched;
      this.blankUntil = time + T.openBlankMs;
      this.deferred = null;
    }

    // ── Twist ───────────────────────────────────────────────────────────────────────────────
    if (frame.twistValid !== this.twistOn) {
      if (this.twistSince === null) {
        this.twistSince = time;
        this.twistCount = 1;
      } else this.twistCount++;
      if (this.twistCount >= T.twistResults && time - this.twistSince >= T.twistMs) {
        this.twistOn = frame.twistValid;
        this.twistSince = null;
      }
    } else {
      this.twistSince = null;
      this.twistCount = 0;
    }

    // ── Episode ─────────────────────────────────────────────────────────────────────────────
    const A = this.roles.A;
    const B = this.roles.B;
    const flippedA = flipped(A);
    const flippedB = flipped(B);
    let active = flippedA || flippedB || this.twistOn;
    const rising = active && !this.wasActive;
    const honoured = frame.open || frame.locked || time - frame.closedAt < T.recentOpenMs;
    const guarded = opening || !honoured || time < this.blankUntil || time - this.lastEventAt < T.cooldownMs;

    let event: FlipEvent | null = null;
    if (rising && !guarded) {
      const newA = flippedA && !A.wasFlipped;
      const newB = flippedB && !B.wasFlipped;
      if (newA && newB) {
        this.veto();
        active = false;
      } else if (newA || newB) {
        const role: HandRole = newA ? "A" : "B";
        const other = this.roles[newA ? "B" : "A"];
        if (Math.abs(this.roles[role].changedAt - other.changedAt) <= T.swapVetoMs) {
          this.veto();
          active = false;
        } else if (confirms(other)) {
          event = this.fire(time, role, "facing");
        } else {
          // The other hand has not voted since: wait (briefly) to tell a flip from a swap.
          this.deferred = { role, since: time };
        }
      } else {
        event = this.fire(time, null, "twist");
      }
    }
    // A rising edge that a guard swallowed still consumes the episode: the hand has to come
    // back and turn again. (During the blanking that means the hands' settling is not a flip.)
    this.wasActive = active;
    A.wasFlipped = flipped(A);
    B.wasFlipped = flipped(B);

    // ── Deferred facing event ───────────────────────────────────────────────────────────────
    if (this.deferred !== null) {
      const r = this.roles[this.deferred.role];
      const other = this.roles[this.deferred.role === "A" ? "B" : "A"];
      if (Math.abs(r.changedAt - other.changedAt) <= T.swapVetoMs) {
        this.veto();
        this.wasActive = flipped(A) || flipped(B) || this.twistOn;
        A.wasFlipped = flipped(A);
        B.wasFlipped = flipped(B);
      } else if (!other.present || confirms(other) || time - this.deferred.since >= T.swapVetoMs || !active) {
        event = this.fire(time, this.deferred.role, "facing");
      }
    }
    return event;
  }

  /** The facing currently latched for a role: 1 / -1, or 0 while unknown. */
  latched(role: HandRole): 1 | -1 | 0 {
    return this.roles[role].latched;
  }

  reset(): void {
    this.roles.A = freshRole();
    this.roles.B = freshRole();
    this.twistOn = false;
    this.twistSince = null;
    this.twistCount = 0;
    this.wasOpen = false;
    this.wasActive = false;
    this.blankUntil = -Infinity;
    this.lastEventAt = -Infinity;
    this.deferred = null;
  }

  /**
   * Feed one vote into a role's latch. Zero votes neither count nor reset; a vote for the
   * latched sign cancels any pending change; a contrary sign needs `latchResults` results
   * spanning `latchMs`, and gives up after `pendingMaxMs`.
   */
  private latch(r: RoleState, vote: Sign, time: number): void {
    const T = FLIP_T;
    if (vote === 0) {
      if (r.pending !== null && time - r.pending.since > T.pendingMaxMs) r.pending = null;
      return;
    }
    if (vote === r.latched) {
      r.pending = null;
      return;
    }
    if (r.pending === null || r.pending.sign !== vote || time - r.pending.since > T.pendingMaxMs) {
      r.pending = { sign: vote, count: 1, since: time };
      return;
    }
    r.pending.count++;
    if (r.pending.count < T.latchResults || time - r.pending.since < T.latchMs) return;
    const was = r.latched;
    r.latched = vote;
    r.pending = null;
    if (was !== 0) r.changedAt = time;
    // The first facing ever latched after the frame opened is the reference, not a flip.
    if (r.baseline === 0) r.baseline = vote;
  }

  /** Both hands changed sides together: the assigner swapped them. Nothing happened; start again from here. */
  private veto(): void {
    for (const role of ROLES) this.roles[role].baseline = this.roles[role].latched;
    this.deferred = null;
  }

  private fire(time: number, role: HandRole | null, cause: FlipEvent["cause"]): FlipEvent {
    this.lastEventAt = time;
    this.deferred = null;
    return { time, role, cause };
  }
}

const flipped = (r: RoleState) => r.latched !== 0 && r.baseline !== 0 && r.latched !== r.baseline;

/**
 * The vote this result casts: the pose's facing, or 0 when it should not count. A coasting or
 * untrusted result has no opinion; a track younger than `minTrackAgeMs` is still settling; and
 * an edge-on hand only gets a say while its index finger and thumb are long enough on screen
 * for their winding to mean anything.
 */
function voteOf(h: HandSample, aspect: number): Sign {
  const T = FLIP_T;
  const pose = h.pose;
  if (!h.fresh || pose.uncertain || h.ageMs < T.minTrackAgeMs || pose.facing === 0) return 0;
  if (T.edgeVoteMin > 0 && Math.abs(pose.cPalm) < POSE_T.facingMin) {
    const p = h.points;
    const len = (a: number, b: number) => Math.hypot((p[a].x - p[b].x) * aspect, p[a].y - p[b].y);
    const floor = T.edgeVoteMin * pose.s2;
    if (len(LM.INDEX_MCP, LM.INDEX_TIP) < floor || len(LM.THUMB_MCP, LM.THUMB_TIP) < floor) return 0;
  }
  return pose.facing;
}

/** This result, the other hand voted for the side it is latched on: it is not changing sides. */
const confirms = (other: RoleState) => other.vote !== 0 && other.vote === other.latched && other.pending === null;
