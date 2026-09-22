import { FOCUS_TIMING } from "@shared/focus";
import assert from "node:assert/strict";
import test from "node:test";
import type { ForegroundEvidence } from "./foreground-evidence";
import {
  effectView,
  foregroundSummary,
  initialFocusState,
  reduceFocus,
  sessionView,
  systemFilterWanted,
  type FocusCapability,
  type FocusEffect,
  type FocusInput,
  type FocusMachineState
} from "./focus-state";

const READY: FocusCapability = {
  privacyAccepted: true,
  captureEnabled: true,
  collectorAvailable: true,
  accessibilityTrusted: true,
  captureBrowserURLs: true,
  overlayAvailable: true
};
const GOAL = { id: "goal-00000000-test", title: "Ship the guide", why: "Readers are waiting", currentFocus: "Outline" };
const T0 = 1_800_000_000_000;

class Harness {
  state: FocusMachineState = initialFocusState(READY);
  effects: FocusEffect[] = [];
  sequence = 0;

  send(input: FocusInput): FocusEffect[] {
    const transition = reduceFocus(this.state, input);
    this.state = transition.state;
    this.effects.push(...transition.effects);
    return transition.effects;
  }

  start(now = T0, sessionId = "session-a", durationMinutes = 25): FocusEffect[] {
    return this.send({
      type: "start",
      now,
      sessionId,
      goal: GOAL,
      intention: "Write the intro",
      domains: ["video.example", "social.example"],
      durationMinutes
    });
  }

  generation(): number {
    return this.state.session.status === "active" ? this.state.session.generation : 0;
  }

  browser(now: number, domain = "video.example", processIdentifier = 501, observedAt = now): FocusEffect[] {
    this.sequence += 1;
    const evidence: ForegroundEvidence = {
      kind: "browser",
      generation: this.generation(),
      sequence: this.sequence,
      observedAt,
      processIdentifier,
      bundleIdentifier: "com.apple.Safari",
      domain
    };
    return this.send({ type: "evidence", now, evidence });
  }

  unknown(now: number, reason: Extract<ForegroundEvidence, { kind: "unknown" }>["reason"] = "other_application"): FocusEffect[] {
    this.sequence += 1;
    return this.send({
      type: "evidence",
      now,
      evidence: { kind: "unknown", generation: this.generation(), sequence: this.sequence, observedAt: now, reason }
    });
  }
}

function shows(effects: FocusEffect[]): Array<Extract<FocusEffect, { type: "show" }>> {
  return effects.filter((effect): effect is Extract<FocusEffect, { type: "show" }> => effect.type === "show");
}

function hides(effects: FocusEffect[]): Array<Extract<FocusEffect, { type: "hide" }>> {
  return effects.filter((effect): effect is Extract<FocusEffect, { type: "hide" }> => effect.type === "hide");
}

test("starting a session begins a fresh observation generation without any reminder", () => {
  const harness = new Harness();
  const effects = harness.start();
  assert.deepEqual(effects, [{ type: "observe", generation: 1 }]);
  const view = sessionView(harness.state);
  assert.equal(view.status, "active");
  assert.equal(view.status === "active" ? view.endsAt : "", new Date(T0 + 25 * 60_000).toISOString());
  assert.equal(foregroundSummary(harness.state, T0), "waiting");
});

test("fresh evidence for a listed site shows one reminder with the goal and intention", () => {
  const harness = new Harness();
  harness.start();
  const [show] = shows(harness.browser(T0 + 1_000, "m.video.example"));
  assert(show);
  assert.equal(show.request.preview, false);
  assert.equal(show.request.sessionId, "session-a");
  assert.equal(show.request.expectedProcessIdentifier, 501);
  assert.equal(show.request.title, "Ship the guide");
  assert.equal(show.request.message, "Back to: Write the intro");
  assert.equal(shows(harness.browser(T0 + 1_750)).length, 0, "a visible reminder is not repeated");
});

test("unlisted sites, spoofed hosts and other apps never show a reminder", () => {
  const harness = new Harness();
  harness.start();
  assert.equal(shows(harness.browser(T0 + 1_000, "docs.example")).length, 0);
  assert.equal(shows(harness.browser(T0 + 2_000, "video.example.attacker.example")).length, 0);
  assert.equal(shows(harness.browser(T0 + 3_000, "notvideo.example")).length, 0);
  assert.equal(shows(harness.unknown(T0 + 4_000)).length, 0);
  assert.equal(foregroundSummary(harness.state, T0 + 4_000), "other_app");
});

test("stale, future, wrong-generation and out-of-order evidence cannot nudge", () => {
  const harness = new Harness();
  harness.start();
  const stale = T0 + 10_000 - FOCUS_TIMING.evidenceFreshnessMs - 1;
  assert.equal(shows(harness.browser(T0 + 10_000, "video.example", 501, stale)).length, 0, "stale");
  assert.equal(foregroundSummary(harness.state, T0 + 10_000), "unknown");
  assert.equal(shows(harness.browser(T0 + 11_000, "video.example", 501, T0 + 60_000)).length, 0, "future");

  const other = new Harness();
  other.start();
  const effects = other.send({
    type: "evidence",
    now: T0 + 1_000,
    evidence: {
      kind: "browser",
      generation: 99,
      sequence: 1,
      observedAt: T0 + 1_000,
      processIdentifier: 501,
      bundleIdentifier: "com.apple.Safari",
      domain: "video.example"
    }
  });
  assert.equal(shows(effects).length, 0, "wrong generation");

  const ordered = new Harness();
  ordered.start();
  ordered.unknown(T0 + 1_000);
  ordered.sequence = 0;
  assert.equal(shows(ordered.browser(T0 + 1_100)).length, 0, "older sequence after a newer one");
});

test("a reminder hides immediately when the foreground changes or evidence goes stale", () => {
  const changed = new Harness();
  changed.start();
  const [shown] = shows(changed.browser(T0 + 1_000));
  const [hidden] = hides(changed.unknown(T0 + 2_000));
  assert.equal(hidden?.nudgeId, shown?.request.nudgeId);
  assert.equal(hidden?.immediate, true);

  const otherProcess = new Harness();
  otherProcess.start();
  otherProcess.browser(T0 + 1_000);
  assert.equal(hides(otherProcess.browser(T0 + 1_500, "video.example", 777)).length, 1);

  const stale = new Harness();
  stale.start();
  stale.browser(T0 + 1_000);
  assert.equal(hides(stale.send({ type: "tick", now: T0 + 1_000 + FOCUS_TIMING.evidenceFreshnessMs + 1 })).length, 1);

  const automatic = new Harness();
  automatic.start();
  automatic.browser(T0 + 1_000);
  for (let offset = 1_750; offset < FOCUS_TIMING.previewDurationMs + 2_000; offset += 750) {
    automatic.browser(T0 + offset);
  }
  assert(automatic.state.nudge, "the glow stays while fresh listed-site evidence continues");
  assert.equal(hides(automatic.effects).length, 0);
});

test("protected context and lost capability clear a reminder immediately", () => {
  const privateContext = new Harness();
  privateContext.start();
  privateContext.browser(T0 + 1_000);
  const [hidden] = hides(privateContext.unknown(T0 + 1_500, "protected_context"));
  assert.equal(hidden?.immediate, true);

  const paused = new Harness();
  paused.start();
  paused.browser(T0 + 1_000);
  const [pausedHide] = hides(paused.send({
    type: "capability",
    now: T0 + 1_200,
    capability: { ...READY, captureEnabled: false }
  }));
  assert.equal(pausedHide?.immediate, true);
  assert.equal(paused.state.evidence, undefined);
  assert.equal(shows(paused.browser(T0 + 1_500)).length, 0, "no reminders while paused");
});

test("missing Accessibility, disabled URL capture or a missing overlay suppress reminders", () => {
  for (const capability of [
    { ...READY, accessibilityTrusted: false },
    { ...READY, captureBrowserURLs: false },
    { ...READY, overlayAvailable: false },
    { ...READY, collectorAvailable: false },
    { ...READY, privacyAccepted: false }
  ]) {
    const harness = new Harness();
    harness.state = initialFocusState(capability);
    harness.start();
    assert.equal(shows(harness.browser(T0 + 1_000)).length, 0, JSON.stringify(capability));
  }
});

test("the two-second cooldown applies to quick departures and returns", () => {
  const harness = new Harness();
  harness.start();
  harness.browser(T0 + 1_000);
  assert.equal(FOCUS_TIMING.globalCooldownMs, 2_000);
  harness.unknown(T0 + 1_500);
  assert.equal(shows(harness.browser(T0 + 2_000)).length, 0, "re-entry inside the cooldown");
  assert.equal(shows(harness.browser(T0 + 1_000 + FOCUS_TIMING.globalCooldownMs - 1)).length, 0);
  assert.equal(shows(harness.browser(T0 + 1_000 + FOCUS_TIMING.globalCooldownMs)).length, 1, "fresh re-entry after cooldown");
});

test("dismiss starts a quiet period of at least a minute", () => {
  const harness = new Harness();
  harness.start();
  const [shown] = shows(harness.browser(T0 + 1_000));
  harness.send({
    type: "overlay_action",
    now: T0 + 2_000,
    action: "dismiss",
    nudgeId: shown!.request.nudgeId,
    sessionId: "session-a",
    preview: false
  });
  assert.equal(harness.state.nudge, undefined);
  assert(FOCUS_TIMING.dismissCooldownMs >= 60_000);
  const quietUntil = T0 + 2_000 + FOCUS_TIMING.dismissCooldownMs;
  assert.equal(harness.state.dismissedUntil, quietUntil);
  assert.equal(shows(harness.browser(quietUntil - 1)).length, 0);
  const nextAllowed = Math.max(quietUntil, T0 + 1_000 + FOCUS_TIMING.globalCooldownMs);
  assert.equal(shows(harness.browser(nextAllowed)).length, 1);
});

test("the dismiss quiet period still applies when the global cooldown has already passed", () => {
  const harness = new Harness();
  harness.start();
  const [shown] = shows(harness.browser(T0 + 1_000));
  const dismissedAt = T0 + 1_000 + FOCUS_TIMING.globalCooldownMs;
  harness.send({
    type: "overlay_action",
    now: dismissedAt,
    action: "dismiss",
    nudgeId: shown!.request.nudgeId,
    sessionId: "session-a",
    preview: false
  });
  assert.equal(shows(harness.browser(dismissedAt + 1_000)).length, 0);
  assert.equal(shows(harness.browser(dismissedAt + FOCUS_TIMING.dismissCooldownMs)).length, 1);
});

test("snooze from the reminder or the app pauses all reminders for five minutes, and resume ends it", () => {
  const native = new Harness();
  native.start();
  const [shown] = shows(native.browser(T0 + 1_000));
  native.send({
    type: "overlay_action",
    now: T0 + 2_000,
    action: "snooze",
    nudgeId: shown!.request.nudgeId,
    sessionId: "session-a",
    preview: false
  });
  const snoozedUntil = T0 + 2_000 + FOCUS_TIMING.snoozeMs;
  const view = sessionView(native.state);
  assert.equal(view.status === "active" ? view.snoozedUntil : null, new Date(snoozedUntil).toISOString());
  assert.equal(shows(native.browser(snoozedUntil - 1)).length, 0);
  assert.equal(shows(native.browser(snoozedUntil)).length, 1);

  const app = new Harness();
  app.start();
  app.browser(T0 + 1_000);
  const effects = app.send({ type: "snooze", now: T0 + 1_500 });
  assert.equal(hides(effects).length, 1);
  assert.equal(shows(app.send({ type: "resume", now: T0 + 1_000 + FOCUS_TIMING.globalCooldownMs })).length, 1);
  assert.equal(shows(app.browser(T0 + 1_000 + FOCUS_TIMING.globalCooldownMs + 10)).length, 0);
});

test("late native actions from an older reminder or session cannot affect the current one", () => {
  const harness = new Harness();
  harness.start(T0, "session-a");
  const [oldReminder] = shows(harness.browser(T0 + 1_000));
  harness.send({ type: "stop", now: T0 + 2_000 });
  harness.start(T0 + 3_000, "session-b");
  harness.sequence = 0;
  const [current] = shows(harness.browser(T0 + 4_000));
  assert(current);

  harness.send({
    type: "overlay_action",
    now: T0 + 4_500,
    action: "snooze",
    nudgeId: oldReminder!.request.nudgeId,
    sessionId: "session-a",
    preview: false
  });
  harness.send({
    type: "overlay_action",
    now: T0 + 4_600,
    action: "dismiss",
    nudgeId: "nudge-forged",
    sessionId: "session-b",
    preview: false
  });
  assert.equal(harness.state.nudge?.id, current.request.nudgeId);
  const view = sessionView(harness.state);
  assert.equal(view.status === "active" ? view.snoozedUntil : "x", null);
  assert.equal(harness.state.dismissedUntil, undefined);
});

test("a new session does not inherit evidence, cooldowns or reminder identifiers", () => {
  const harness = new Harness();
  harness.start(T0, "session-a");
  const [first] = shows(harness.browser(T0 + 1_000));
  harness.send({ type: "stop", now: T0 + 2_000 });
  harness.start(T0 + 3_000, "session-b");
  assert.equal(harness.state.evidence, undefined);
  assert.equal(harness.state.lastNudgeAt, undefined);
  harness.sequence = 0;
  const [second] = shows(harness.browser(T0 + 3_500));
  assert(second, "cooldown from the previous session must not carry over");
  assert.notEqual(second.request.nudgeId, first?.request.nudgeId);
});

test("stopping or expiring a session hides the reminder immediately and stops observation", () => {
  const stopped = new Harness();
  stopped.start();
  stopped.browser(T0 + 1_000);
  const stopEffects = stopped.send({ type: "stop", now: T0 + 2_000 });
  assert.deepEqual(stopEffects.map((effect) => effect.type), ["hide", "observe"]);
  assert.equal(hides(stopEffects)[0]?.immediate, true);
  assert.deepEqual(stopEffects.at(-1), { type: "observe", generation: 0 });
  assert.equal(stopped.state.session.status, "idle");
  assert.equal(shows(stopped.browser(T0 + 3_000)).length, 0);

  const expired = new Harness();
  expired.start(T0, "session-a", 5);
  const effects = expired.send({ type: "tick", now: T0 + 5 * 60_000 });
  assert.equal(expired.state.session.status, "idle");
  assert.deepEqual(effects.at(-1), { type: "observe", generation: 0 });
});

test("reminders wait while the Mac reports the person is idle", () => {
  const harness = new Harness();
  harness.start();
  harness.send({ type: "tick", now: T0 + 500, idleSeconds: FOCUS_TIMING.idleSuppressionSeconds });
  assert.equal(shows(harness.browser(T0 + 1_000)).length, 0);
  assert.equal(shows(harness.send({ type: "tick", now: T0 + 1_500, idleSeconds: 0 })).length, 1);
  assert.equal(shows(harness.browser(T0 + 2_000)).length, 0, "fresh evidence must not duplicate the reminder");
});

test("a preview uses the same show path, needs no session and never touches session state", () => {
  const harness = new Harness();
  const effects = harness.send({
    type: "preview",
    now: T0,
    previewId: "preview-1",
    copy: { title: "Ship the guide", message: "Back to: Outline" }
  });
  const [show] = shows(effects);
  assert.equal(show?.request.preview, true);
  assert.equal(show?.request.expectedProcessIdentifier, null);
  harness.send({ type: "overlay_action", now: T0 + 100, action: "snooze", nudgeId: "preview-1", preview: true });
  assert.equal(harness.state.preview, undefined);
  assert.equal(harness.state.session.status, "idle");

  harness.send({ type: "preview", now: T0 + 200, previewId: "preview-2", copy: { title: "x", message: "" } });
  assert.equal(hides(harness.send({ type: "tick", now: T0 + 200 + FOCUS_TIMING.previewDurationMs })).length, 1);
});

test("a rejected native show clears the pending reminder and retries after a short pause", () => {
  const harness = new Harness();
  harness.start();
  const [show] = shows(harness.browser(T0 + 1_000));
  harness.send({ type: "overlay_rejected", now: T0 + 1_001, nudgeId: show!.request.nudgeId });
  assert.equal(harness.state.nudge, undefined);
  assert.equal(shows(harness.browser(T0 + 2_000)).length, 0, "no tight retry loop");
  assert.equal(shows(harness.browser(T0 + 6_001)).length, 1);
});


test("foreground status explains why a reminder is withheld without exposing browsing content", () => {
  const harness = new Harness();
  harness.start();
  for (const [reason, expected] of [
    ["browser_address_unavailable", "address_unavailable"],
    ["protected_context", "protected_context"],
    ["excluded_application", "excluded_app"],
    ["session_locked", "locked"],
    ["screen_asleep", "asleep"]
  ] as const) {
    harness.unknown(T0 + 1_000, reason);
    assert.equal(foregroundSummary(harness.state, T0 + 1_000), expected);
  }
  harness.send({ type: "tick", now: T0 + 1_500, idleSeconds: FOCUS_TIMING.idleSuppressionSeconds });
  assert.equal(foregroundSummary(harness.state, T0 + 1_500), "idle");
});


test("a native foreground dismissal waits for a new observation before another reminder", () => {
  const harness = new Harness();
  harness.start();
  const [shown] = shows(harness.browser(T0 + 1_000));
  harness.browser(T0 + 4_000);
  const effects = harness.send({
    type: "overlay_action", now: T0 + 4_100, action: "hidden",
    nudgeId: shown!.request.nudgeId, sessionId: "session-a", preview: false
  });
  assert.equal(shows(effects).length, 0);
  assert.equal(harness.state.nudge, undefined);
  assert.equal(shows(harness.browser(T0 + 4_200)).length, 1);
});


test("a duplicate native hidden callback cannot invalidate a newer observation", () => {
  const harness = new Harness();
  harness.start();
  const [shown] = shows(harness.browser(T0 + 1_000));
  const hidden = { type: "overlay_action", action: "hidden", nudgeId: shown!.request.nudgeId,
    sessionId: "session-a", preview: false } as const;
  harness.send({ ...hidden, now: T0 + 1_100 });
  harness.browser(T0 + 1_200);
  harness.send({ ...hidden, now: T0 + 1_300 });
  assert.equal(shows(harness.send({ type: "tick", now: T0 + 3_000 })).length, 1);
});

function grayscaleHarness(access: "granted" | "not_granted" | "unsupported" = "granted"): Harness {
  const harness = new Harness();
  harness.state = initialFocusState(READY, "grayscale_screen", access);
  return harness;
}

test("amber reminders ask for the amber style and report it showing at once", () => {
  const harness = new Harness();
  harness.start();
  const [show] = shows(harness.browser(T0 + 1_000));
  assert.equal(show?.request.experience, "amber");
  assert.equal(effectView(harness.state)?.status, "showing");
  assert.equal(effectView(harness.state)?.requested, "amber");
});

test("grayscale stays preparing until the native side reports the reminder's first frame", () => {
  const harness = grayscaleHarness();
  harness.start();
  const [show] = shows(harness.browser(T0 + 1_000));
  assert.equal(show?.request.experience, "grayscale_screen");
  assert.equal(effectView(harness.state)?.status, "preparing");
  const nudgeId = show!.request.nudgeId;

  harness.send({ type: "effect_status", now: T0 + 1_100, nudgeId: "nudge-other", status: "active" });
  assert.equal(effectView(harness.state)?.status, "preparing", "another reminder's frame proves nothing");
  harness.send({ type: "effect_status", now: T0 + 1_200, nudgeId, status: "active" });
  assert.equal(effectView(harness.state)?.status, "showing");
  harness.send({ type: "effect_status", now: T0 + 1_300, nudgeId, status: "fallback", reason: "permission_needed" });
  assert.deepEqual(
    [effectView(harness.state)?.status, effectView(harness.state)?.fallbackReason],
    ["fallback", "permission_needed"],
    "revocation while showing falls back"
  );
  harness.send({ type: "effect_status", now: T0 + 1_400, nudgeId, status: "active" });
  assert.equal(effectView(harness.state)?.status, "fallback", "a fallback is never undone");
});

test("late native reports for a hidden reminder can't claim grayscale is showing", () => {
  const harness = grayscaleHarness();
  harness.start();
  const nudgeId = shows(harness.browser(T0 + 1_000))[0]!.request.nudgeId;
  assert.equal(hides(harness.unknown(T0 + 1_500)).length, 1);
  assert.equal(effectView(harness.state)?.visible, false);
  harness.send({ type: "effect_status", now: T0 + 1_600, nudgeId, status: "active" });
  harness.send({ type: "effect_status", now: T0 + 1_700, nudgeId, status: "fallback", reason: "no_frame" });
  assert.deepEqual(
    [effectView(harness.state)?.status, effectView(harness.state)?.visible],
    ["preparing", false]
  );
});

test("without Screen Recording, grayscale reminders fall back to amber and say why", () => {
  for (const [access, reason] of [["not_granted", "permission_needed"], ["unsupported", "unsupported"]] as const) {
    const harness = grayscaleHarness(access);
    harness.start();
    const [show] = shows(harness.browser(T0 + 1_000));
    assert.equal(show?.request.experience, "amber");
    assert.deepEqual(
      [effectView(harness.state)?.status, effectView(harness.state)?.fallbackReason],
      ["fallback", reason]
    );
  }
});

test("changing the style replaces a visible reminder at once and keeps the session", () => {
  const harness = new Harness();
  harness.state = { ...harness.state, screenCapture: "granted" };
  harness.start();
  const first = shows(harness.browser(T0 + 1_000))[0]!;
  const session = harness.state.session;
  const effects = harness.send({ type: "experience_changed", now: T0 + 1_200, experience: "grayscale_screen" });
  assert.deepEqual(hides(effects), [{ type: "hide", nudgeId: first.request.nudgeId, immediate: true }]);
  const [replacement] = shows(effects);
  assert.equal(replacement?.request.experience, "grayscale_screen", "the 2 s cooldown doesn't delay the switch");
  assert.notEqual(replacement?.request.nudgeId, first.request.nudgeId);
  assert.deepEqual(harness.state.session, session);
});

test("changing the style while snoozed hides nothing new and keeps the snooze", () => {
  const harness = new Harness();
  harness.start();
  harness.browser(T0 + 1_000);
  harness.send({ type: "snooze", now: T0 + 1_100 });
  const snoozed = harness.state.session;
  const effects = harness.send({ type: "experience_changed", now: T0 + 1_200, experience: "grayscale_screen" });
  assert.equal(shows(effects).length, 0);
  assert.equal(shows(harness.browser(T0 + 1_500)).length, 0);
  assert.deepEqual(harness.state.session, snoozed);
});

test("a grayscale preview expires after 8 s and ignores its late first frame", () => {
  const harness = grayscaleHarness();
  const [show] = shows(harness.send({
    type: "preview",
    now: T0,
    previewId: "preview-1",
    copy: { title: "x", message: "" }
  }));
  assert.equal(show?.request.experience, "grayscale_screen");
  assert.equal(effectView(harness.state)?.status, "preparing");
  assert.deepEqual(
    hides(harness.send({ type: "tick", now: T0 + FOCUS_TIMING.previewDurationMs })),
    [{ type: "hide", nudgeId: "preview-1", immediate: false }]
  );
  harness.send({ type: "effect_status", now: T0 + FOCUS_TIMING.previewDurationMs + 10, nudgeId: "preview-1", status: "active" });
  assert.deepEqual(
    [effectView(harness.state)?.status, effectView(harness.state)?.visible],
    ["preparing", false]
  );
});

test("grayscale window reminders carry the matched rule and wait for the native first frame", () => {
  const harness = new Harness();
  harness.state = initialFocusState(READY, "grayscale_window", "granted");
  harness.start();
  const [show] = shows(harness.browser(T0 + 1_000, "www.m.video.example"));
  assert.equal(show?.request.experience, "grayscale_window");
  assert.equal(show?.request.domain, "video.example");
  assert.deepEqual(
    [effectView(harness.state)?.requested, effectView(harness.state)?.status],
    ["grayscale_window", "preparing"]
  );
  const nudgeId = show!.request.nudgeId;
  harness.send({ type: "effect_status", now: T0 + 1_100, nudgeId, status: "active" });
  assert.equal(effectView(harness.state)?.status, "showing");
  harness.send({ type: "effect_status", now: T0 + 1_200, nudgeId, status: "fallback", reason: "window_unavailable" });
  assert.deepEqual(
    [effectView(harness.state)?.status, effectView(harness.state)?.fallbackReason],
    ["fallback", "window_unavailable"]
  );
  assert.equal(hides(harness.browser(T0 + 1_500, "docs.example")).length, 1, "a safe site hides the reminder");
});

test("only window reminders carry a site, and previews never do", () => {
  const screen = grayscaleHarness();
  screen.start();
  assert.equal(shows(screen.browser(T0 + 1_000))[0]?.request.domain, undefined);

  const denied = new Harness();
  denied.state = initialFocusState(READY, "grayscale_window", "not_granted");
  denied.start();
  const [amber] = shows(denied.browser(T0 + 1_000));
  assert.deepEqual([amber?.request.experience, amber?.request.domain], ["amber", undefined]);
  assert.equal(effectView(denied.state)?.fallbackReason, "permission_needed");

  const preview = new Harness();
  preview.state = initialFocusState(READY, "grayscale_window", "granted");
  const [shown] = shows(preview.send({ type: "preview", now: T0, previewId: "preview-1", copy: { title: "x", message: "" } }));
  assert.deepEqual(
    [shown?.request.experience, shown?.request.domain, shown?.request.expectedProcessIdentifier],
    ["grayscale_window", undefined, null]
  );
});

test("switching between window and screen grayscale replaces the reminder without touching the session", () => {
  const harness = new Harness();
  harness.state = initialFocusState(READY, "grayscale_window", "granted");
  harness.start();
  const first = shows(harness.browser(T0 + 1_000))[0]!;
  const session = harness.state.session;
  const toScreen = harness.send({ type: "experience_changed", now: T0 + 1_100, experience: "grayscale_screen" });
  assert.deepEqual(hides(toScreen), [{ type: "hide", nudgeId: first.request.nudgeId, immediate: true }]);
  const screen = shows(toScreen)[0]!;
  assert.deepEqual([screen.request.experience, screen.request.domain], ["grayscale_screen", undefined]);

  const toWindow = harness.send({ type: "experience_changed", now: T0 + 1_200, experience: "grayscale_window" });
  assert.deepEqual(hides(toWindow), [{ type: "hide", nudgeId: screen.request.nudgeId, immediate: true }]);
  const window = shows(toWindow)[0]!;
  assert.deepEqual([window.request.experience, window.request.domain], ["grayscale_window", "video.example"]);
  assert.deepEqual(harness.state.session, session);
  assert.equal(effectView(harness.state)?.status, "preparing");
  assert.equal(harness.send({ type: "experience_changed", now: T0 + 1_300, experience: "grayscale_window" }).length, 0);
});

test("changing the style ends a visible preview", () => {
  const harness = grayscaleHarness();
  harness.send({ type: "preview", now: T0, previewId: "preview-1", copy: { title: "x", message: "" } });
  const effects = harness.send({ type: "experience_changed", now: T0 + 100, experience: "amber" });
  assert.deepEqual(hides(effects), [{ type: "hide", nudgeId: "preview-1", immediate: true }]);
  assert.equal(harness.state.preview, undefined);
  assert.equal(effectView(harness.state)?.visible, false);
});

test("window grayscale follows a different listed site without losing the session", () => {
  const harness = new Harness();
  harness.state = initialFocusState(READY, "grayscale_window", "granted");
  harness.start();
  const first = shows(harness.browser(T0 + 1_000, "video.example"))[0]!;
  const session = harness.state.session;
  const changed = harness.browser(T0 + 1_250, "social.example");
  assert.deepEqual(hides(changed), [{ type: "hide", nudgeId: first.request.nudgeId, immediate: true }]);
  const replacement = shows(changed)[0]!;
  assert.equal(replacement.request.experience, "grayscale_window");
  assert.equal(replacement.request.domain, "social.example");
  assert.notEqual(replacement.request.nudgeId, first.request.nudgeId);
  assert.deepEqual(harness.state.session, session);
  assert.equal(shows(harness.browser(T0 + 1_500, "m.social.example")).length, 0);
  assert.equal(hides(harness.browser(T0 + 1_750, "safe.example")).length, 1);
});

test("every reminder carries the amber edge choice, whatever the grayscale", () => {
  for (const experience of ["amber", "grayscale_window", "grayscale_screen", "grayscale_system"] as const) {
    for (const amberEdge of [true, false]) {
      const harness = new Harness();
      harness.state = initialFocusState(READY, experience, "granted", amberEdge, true);
      harness.start();
      const [show] = shows(harness.browser(T0 + 1_000));
      assert.deepEqual([show?.request.experience, show?.request.amberEdge], [experience, amberEdge]);
    }
  }
});

test("toggling the amber edge replaces a visible reminder at once without touching the session", () => {
  const harness = new Harness();
  harness.start();
  const first = shows(harness.browser(T0 + 1_000))[0]!;
  const session = harness.state.session;
  const effects = harness.send({ type: "amber_edge_changed", now: T0 + 1_200, amberEdge: false });
  assert.deepEqual(hides(effects), [{ type: "hide", nudgeId: first.request.nudgeId, immediate: true }]);
  assert.equal(shows(effects)[0]?.request.amberEdge, false, "the cooldown doesn't delay the change");
  assert.deepEqual(harness.state.session, session);
  assert.equal(harness.send({ type: "amber_edge_changed", now: T0 + 1_300, amberEdge: false }).length, 0);

  harness.send({ type: "snooze", now: T0 + 1_400 });
  assert.equal(shows(harness.send({ type: "amber_edge_changed", now: T0 + 1_500, amberEdge: true })).length, 0);
});

test("system grayscale reminders never depend on Screen Recording", () => {
  for (const access of ["not_granted", "unsupported"] as const) {
    const harness = new Harness();
    harness.state = initialFocusState(READY, "grayscale_system", access, false, true);
    harness.start();
    const [show] = shows(harness.browser(T0 + 1_000));
    assert.equal(show?.request.experience, "grayscale_system");
    assert.equal(effectView(harness.state)?.status, "preparing");
    assert.equal(systemFilterWanted(harness.state), true);
    harness.send({ type: "effect_status", now: T0 + 1_100, nudgeId: show!.request.nudgeId, status: "active" });
    assert.equal(effectView(harness.state)?.status, "showing");
    harness.unknown(T0 + 1_500);
    assert.equal(systemFilterWanted(harness.state), false, "a hidden reminder wants system grayscale off");
  }
});

test("system grayscale that isn't available, or failed, isn't wanted and says why", () => {
  const harness = new Harness();
  harness.state = initialFocusState(READY, "grayscale_system", "granted", true, false);
  harness.start();
  harness.browser(T0 + 1_000);
  assert.deepEqual(
    [effectView(harness.state)?.status, effectView(harness.state)?.fallbackReason],
    ["fallback", "system_filter_unavailable"]
  );
  assert.equal(systemFilterWanted(harness.state), false);

  const failed = new Harness();
  failed.state = initialFocusState(READY, "grayscale_system", "not_granted", true, true);
  failed.start();
  const nudgeId = shows(failed.browser(T0 + 1_000))[0]!.request.nudgeId;
  failed.send({ type: "effect_status", now: T0 + 1_100, nudgeId, status: "fallback", reason: "system_filter_failed" });
  assert.equal(systemFilterWanted(failed.state), false);
});

test("switching between captured and system grayscale keeps the session and skips the cooldown", () => {
  const harness = new Harness();
  harness.state = initialFocusState(READY, "grayscale_screen", "granted", true, true);
  harness.start();
  harness.browser(T0 + 1_000);
  const session = harness.state.session;
  const toSystem = harness.send({ type: "experience_changed", now: T0 + 1_100, experience: "grayscale_system" });
  assert.equal(shows(toSystem)[0]?.request.experience, "grayscale_system");
  assert.equal(systemFilterWanted(harness.state), true);
  const toScreen = harness.send({ type: "experience_changed", now: T0 + 1_200, experience: "grayscale_screen" });
  assert.equal(shows(toScreen)[0]?.request.experience, "grayscale_screen");
  assert.equal(systemFilterWanted(harness.state), false);
  assert.deepEqual(harness.state.session, session);
});
