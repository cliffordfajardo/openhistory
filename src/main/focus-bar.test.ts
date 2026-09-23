import type { ActiveFocusSession } from "@shared/focus";
import assert from "node:assert/strict";
import test from "node:test";
import {
  FocusBarActionSchema,
  focusBarSnapshot,
  focusMenuBarTitle,
  formatFocusCountdown,
  trayPresence
} from "./focus-bar";

const T0 = 1_800_000_000_000;

function session(overrides: Partial<ActiveFocusSession> = {}): ActiveFocusSession {
  return {
    status: "active",
    id: "session-a",
    goal: { id: "goal-00000001-test", title: "Ship the guide", why: "Readers", currentFocus: "Outline" },
    intention: "Write the intro",
    domains: ["video.example"],
    startedAt: new Date(T0).toISOString(),
    endsAt: new Date(T0 + 25 * 60_000).toISOString(),
    totalMs: 25 * 60_000,
    pausedRemainingMs: null,
    snoozedUntil: null,
    ...overrides
  };
}

test("a running session sends a deadline the bar can count down from on its own", () => {
  const snapshot = focusBarSnapshot(session(), T0 + 5_000, null);
  assert.deepEqual(snapshot, {
    sessionId: "session-a",
    goalTitle: "Ship the guide",
    intention: "Write the intro",
    endsAtEpochSeconds: (T0 + 25 * 60_000) / 1_000,
    pausedRemainingSeconds: null,
    totalSeconds: 1_500,
    snoozed: false,
    position: null
  });
  assert.deepEqual(
    focusBarSnapshot(session(), T0 + 60_000, null),
    snapshot,
    "a snapshot taken a minute later is identical, so nothing is sent while the clock runs"
  );
});

test("a paused session sends its frozen countdown instead of a deadline", () => {
  const snapshot = focusBarSnapshot(
    session({ endsAt: null, pausedRemainingMs: 8 * 60_000 + 400 }),
    T0 + 60 * 60_000,
    { x: 12, y: 30 }
  );
  assert.equal(snapshot.endsAtEpochSeconds, null);
  assert.equal(snapshot.pausedRemainingSeconds, 480.4);
  assert.deepEqual(snapshot.position, { x: 12, y: 30 });
});

test("snooze is reported while it lasts and not after it expires", () => {
  const snoozed = session({ snoozedUntil: new Date(T0 + 5 * 60_000).toISOString() });
  assert.equal(focusBarSnapshot(snoozed, T0, null).snoozed, true);
  assert.equal(focusBarSnapshot(snoozed, T0 + 5 * 60_000, null).snoozed, false);
});

test("the countdown reads as minutes, and as hours only when there are hours left", () => {
  assert.equal(formatFocusCountdown(0), "0:00");
  assert.equal(formatFocusCountdown(-5_000), "0:00");
  assert.equal(formatFocusCountdown(59_400), "1:00");
  assert.equal(formatFocusCountdown(25 * 60_000), "25:00");
  assert.equal(formatFocusCountdown(3 * 3_600_000 + 4 * 60_000 + 9_000), "3:04:09");
});

test("the menu-bar title shows the countdown, marks a pause, and is empty when idle", () => {
  assert.equal(focusMenuBarTitle({ status: "idle" }, T0), "");
  assert.equal(focusMenuBarTitle(session(), T0 + 60_000), "24:00");
  assert.equal(
    focusMenuBarTitle(session({ endsAt: null, pausedRemainingMs: 90_000 }), T0 + 60 * 60_000),
    "Paused 1:30"
  );
});

test("a running session always has a menu-bar icon, and a temporary one only lasts the session", () => {
  assert.equal(trayPresence("menuBar", false), "presentation");
  assert.equal(trayPresence("menuBar", true), "presentation");
  assert.equal(trayPresence("dock", true), "session");
  assert.equal(trayPresence("dock", false), "none");
});

test("bar actions are accepted only in their exact shape", () => {
  assert.equal(FocusBarActionSchema.safeParse({ action: "pause", sessionId: "session-a" }).success, true);
  assert.equal(
    FocusBarActionSchema.safeParse({ action: "moved", sessionId: "session-a", x: -12.5, y: 40 }).success,
    true
  );
  for (const value of [
    undefined,
    null,
    "pause",
    { action: "pause" },
    { action: "start", sessionId: "session-a" },
    { action: "pause", sessionId: "" },
    { action: "pause", sessionId: "s".repeat(101) },
    { action: "pause", sessionId: "session-a", extra: 1 },
    { action: "moved", sessionId: "session-a", x: Number.POSITIVE_INFINITY, y: 0 },
    { action: "moved", sessionId: "session-a", x: 400_000, y: 0 },
    { action: "moved", sessionId: "session-a", x: "12", y: 0 }
  ]) {
    assert.equal(FocusBarActionSchema.safeParse(value).success, false, JSON.stringify(value) ?? "undefined");
  }
});


test("the native deadline preserves milliseconds across resume", () => {
  const deadline = T0 + 60_750;
  const snapshot = focusBarSnapshot(session({ endsAt: new Date(deadline).toISOString() }), T0 + 750, null);
  assert.equal(snapshot.endsAtEpochSeconds, deadline / 1_000);
  assert.equal(Math.ceil(snapshot.endsAtEpochSeconds! - (T0 + 750) / 1_000), 60);
});
