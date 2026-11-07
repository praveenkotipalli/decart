/**
 * Billing guard of the anime switch. Decart bills every generated second whether or not
 * anything on screen shows the result, so the guard pauses the session when nobody is
 * looking and caps what one press of `d` can cost. Pure: it takes the clock as an
 * argument and returns a new state plus at most one action per step, which the engine
 * carries out (DecartSession.stop("paused"), a reconnect, or switching anime off).
 *
 * The session's own seconds counter (DecartSession.metrics.seconds) restarts at 0 on
 * every start, so a resume after a pause, a model change or a retry would otherwise lose
 * or double-count seconds. The guard watches the counter and folds it in when it drops.
 */
import type { AIState } from "./DecartSession";

export interface GuardState {
  /** Last time an AI consumer was on screen, held at `now` while no billed session is running. ms. */
  lastConsumerAt: number;
  /** When the tab became hidden; null while it is visible. ms. */
  hiddenSince: number | null;
  /**
   * Billed seconds toward the current grant that are not in the session's own counter:
   * the counters of earlier sessions, folded in when they restarted, minus the counter
   * value at the moment of the grant (so a grant made while a stale or running counter
   * is showing starts from zero). Negative right after such a grant; see guardStep.
   */
  doneSec: number;
  /** The session counter as last seen. A drop means the session restarted from 0. */
  lastSessionSec: number;
  /** Billed seconds allowed by the current grant. Infinity once the stop has fired: the check is disarmed until the next grant. */
  grantSec: number;
}

export interface GuardInput {
  /** performance.now() ms. */
  now: number;
  /** The user's anime switch. */
  on: boolean;
  ai: AIState;
  /** A frame or loupe that would show the AI picture is on screen (ToyStatus.aiConsumerVisible). */
  consumerVisible: boolean;
  /** A fresh hand holds an L or OK in effect "frame" (ToyStatus.poseIntent). */
  poseIntent: boolean;
  tabHidden: boolean;
  /** DecartSession.metrics.seconds: billed seconds of the current session, back to 0 on every start. */
  sessionSeconds: number;
}

export type GuardAction = "none" | "pause" | "resume" | "stop-budget";

/** States in which the session is billing or about to: the idle and hidden clocks run only then. */
const RUNNING: ReadonlySet<AIState> = new Set<AIState>(["connecting", "waiting", "connected", "live", "reconnecting"]);

/** A missing or non-positive budget fails closed: anime stops at once rather than billing without a cap. */
function cap(budgetSec: number): number {
  return Number.isFinite(budgetSec) && budgetSec > 0 ? budgetSec : 0;
}

export function guardInit(now: number, budgetSec: number): GuardState {
  return { lastConsumerAt: now, hiddenSince: null, doneSec: 0, lastSessionSec: 0, grantSec: cap(budgetSec) };
}

/**
 * Another chunk of billed seconds, on each explicit `d`. Seconds the session counter already
 * shows were billed to the previous grant, so they are subtracted up front; if that session
 * then restarts (counter back to 0) the fold in guardStep brings the offset back to zero.
 */
export function guardGrant(state: GuardState, budgetSec: number): GuardState {
  return { ...state, doneSec: -state.lastSessionSec, grantSec: cap(budgetSec) };
}

/**
 * One step per rendered frame. `usedSec` is the total billed since the last grant, across
 * sessions. Actions, at most one, in priority order:
 *  - "stop-budget" once, when `usedSec` reaches the grant while anime is on;
 *  - "pause" when a running session has had no consumer for `idleSec` (0 disables) or the
 *    tab has been hidden for `hiddenSec` (0 disables);
 *  - "resume" from "paused" only on pose intent, and only in a visible tab.
 */
export function guardStep(
  state: GuardState,
  input: GuardInput,
  cfg: { idleSec: number; hiddenSec: number },
): { state: GuardState; action: GuardAction; usedSec: number } {
  const { now, on, ai, consumerVisible, poseIntent, tabHidden } = input;
  const running = RUNNING.has(ai);

  // Seconds. A counter below the last seen value means the session restarted from 0: the
  // old count moves into doneSec so it is neither lost nor counted twice.
  const sessionSec = Number.isFinite(input.sessionSeconds) ? Math.max(0, input.sessionSeconds) : state.lastSessionSec;
  const doneSec = sessionSec < state.lastSessionSec ? state.doneSec + state.lastSessionSec : state.doneSec;
  const usedSec = Math.max(0, doneSec + sessionSec);

  // Clocks. The idle clock measures time a billed session runs without a consumer, so it is
  // held while nothing runs: pressing `d` after a long idle must not pause at once.
  const lastConsumerAt = consumerVisible || !on || !running ? now : state.lastConsumerAt;
  const hiddenSince = tabHidden ? (state.hiddenSince ?? now) : null;

  let grantSec = state.grantSec;
  let action: GuardAction = "none";
  if (on && usedSec >= grantSec) {
    action = "stop-budget";
    grantSec = Infinity;
  } else if (on && running) {
    const idle = cfg.idleSec > 0 && now - lastConsumerAt >= cfg.idleSec * 1000;
    const hidden = cfg.hiddenSec > 0 && hiddenSince !== null && now - hiddenSince >= cfg.hiddenSec * 1000;
    if (idle || hidden) action = "pause";
  } else if (on && ai === "paused" && poseIntent && !tabHidden) {
    action = "resume";
  }

  return { state: { lastConsumerAt, hiddenSince, doneSec, lastSessionSec: sessionSec, grantSec }, action, usedSec };
}
