import { focusSessionRemainingMs, type FocusSession } from "@shared/focus";

/**
 * What the persistent timer bar draws. It carries no goal, no intention and nothing about the
 * browser: only the clock the whole session already counts from, so the bar cannot disagree with
 * the menu bar, the floating bar or a reminder.
 *
 * Exactly one of `endsAtEpochSeconds` and `pausedRemainingSeconds` is set, matching the session:
 * a deadline while it runs, a frozen remainder while it is paused. `enabled` is the preference on
 * its own — an enabled request with no session keeps the native panels alive but off screen.
 */
export interface TimerBarRequest {
  enabled: boolean;
  session: {
    endsAtEpochSeconds: number | null;
    pausedRemainingSeconds: number | null;
    totalSeconds: number;
  } | null;
}

export type TimerBarResult = "applied" | "invalid_request" | "not_main_thread" | "no_display";

/**
 * The bar for this moment. A session that is over, or a preference that is off, leaves `session`
 * null: the native side never decides on its own that a session ended, it only stops drawing one.
 */
export function timerBarRequest(
  session: FocusSession,
  now: number,
  enabled: boolean
): TimerBarRequest {
  if (!enabled || session.status !== "active") return { enabled, session: null };
  const remainingMs = focusSessionRemainingMs(session, now);
  if (remainingMs <= 0) return { enabled, session: null };
  return {
    enabled,
    session: {
      endsAtEpochSeconds: session.endsAt === null ? null : Date.parse(session.endsAt) / 1_000,
      pausedRemainingSeconds: session.endsAt === null ? remainingMs / 1_000 : null,
      totalSeconds: Math.max(1, session.totalMs / 1_000)
    }
  };
}

/** Share of the session still to run, from 1 down to 0. A zero-length session reads as spent. */
export function timerBarRemainingFraction(session: FocusSession, now: number): number {
  if (session.status !== "active") return 0;
  const total = session.totalMs;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, focusSessionRemainingMs(session, now) / total));
}
