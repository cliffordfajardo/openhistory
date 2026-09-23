import { FOCUS_PROGRESS_COLOR_DEFAULT, type FocusSession } from "@shared/focus";
import assert from "node:assert/strict";
import test from "node:test";
import { timerBarRemainingFraction, timerBarRequest } from "./focus-timer-bar";

const NOW = 1_800_000_000_000;
const GREEN = FOCUS_PROGRESS_COLOR_DEFAULT;

function running(overrides: Partial<Extract<FocusSession, { status: "active" }>> = {}): FocusSession {
  return {
    status: "active",
    id: "session-1",
    goal: { id: "goal-00000001-test", title: "Ship the guide", why: "Readers", currentFocus: "Outline" },
    intention: "Write the intro",
    domains: ["video.example"],
    startedAt: new Date(NOW).toISOString(),
    endsAt: new Date(NOW + 1_500_000).toISOString(),
    totalMs: 1_500_000,
    pausedRemainingMs: null,
    snoozedUntil: null,
    ...overrides
  };
}

test("a running session becomes a deadline and nothing else", () => {
  const request = timerBarRequest(running(), NOW, true, GREEN);
  assert.deepEqual(request, {
    enabled: true,
    session: {
      endsAtEpochSeconds: (NOW + 1_500_000) / 1_000,
      pausedRemainingSeconds: null,
      totalSeconds: 1_500
    },
    progressColor: GREEN
  });
  assert.deepEqual(
    Object.keys(request.session!).sort(),
    ["endsAtEpochSeconds", "pausedRemainingSeconds", "totalSeconds"],
    "the goal, the intention and the sites stay out of the timer bar"
  );
});

test("a paused session becomes a frozen remainder instead of a deadline", () => {
  const request = timerBarRequest(
    running({ endsAt: null, pausedRemainingMs: 456_700 }),
    NOW + 60_000,
    true,
    GREEN
  );
  assert.deepEqual(request.session, {
    endsAtEpochSeconds: null,
    pausedRemainingSeconds: 456.7,
    totalSeconds: 1_500
  });
  assert.equal(request.session!.endsAtEpochSeconds === null, true, "exactly one clock is ever sent");
});

test("fractional seconds survive, so a resume does not round the countdown", () => {
  const session = running({ endsAt: new Date(NOW + 1_499_400).toISOString() });
  assert.equal(timerBarRequest(session, NOW, true, GREEN).session?.endsAtEpochSeconds, (NOW + 1_499_400) / 1_000);
});

test("a spent, idle or switched-off bar carries no session at all", () => {
  assert.deepEqual(timerBarRequest({ status: "idle" }, NOW, true, GREEN),
    { enabled: true, session: null, progressColor: GREEN });
  assert.deepEqual(timerBarRequest(running(), NOW, false, GREEN),
    { enabled: false, session: null, progressColor: GREEN });
  const expired = running({ endsAt: new Date(NOW - 1).toISOString() });
  assert.deepEqual(timerBarRequest(expired, NOW, true, GREEN),
    { enabled: true, session: null, progressColor: GREEN },
    "the native side is never asked to draw a session that is already over");
  const spentPause = running({ endsAt: null, pausedRemainingMs: 0 });
  assert.equal(timerBarRequest(spentPause, NOW, true, GREEN).session, null);
});

test("the color rides beside the clock, so it reaches the bar with or without a session", () => {
  const runningSession = running();
  assert.equal(timerBarRequest(runningSession, NOW, true, "#b86b5c").progressColor, "#b86b5c");
  assert.equal(timerBarRequest({ status: "idle" }, NOW, true, "#b86b5c").progressColor, "#b86b5c");
  assert.deepEqual(
    timerBarRequest(runningSession, NOW, true, "#b86b5c").session,
    timerBarRequest(runningSession, NOW, true, GREEN).session,
    "and a new color moves no part of the clock"
  );
});

test("the remaining fraction is clamped and survives a zero total", () => {
  assert.equal(timerBarRemainingFraction(running(), NOW), 1);
  assert.equal(timerBarRemainingFraction(running(), NOW + 1_200_000), 0.2);
  assert.equal(timerBarRemainingFraction(running(), NOW + 1_500_000), 0);
  assert.equal(timerBarRemainingFraction(running(), NOW + 9_000_000), 0, "past the deadline stays at zero");
  assert.equal(timerBarRemainingFraction(running({ totalMs: 0 }), NOW), 0);
  assert.equal(timerBarRemainingFraction({ status: "idle" }, NOW), 0);
  assert.equal(
    timerBarRemainingFraction(running({ endsAt: null, pausedRemainingMs: 750_000 }), NOW + 9_000_000),
    0.5,
    "a paused fraction is frozen however long the pause lasts"
  );
});
