import {
  FOCUS_EDGE_COLOR_DEFAULT,
  FOCUS_EDGE_MODES,
  FOCUS_TIMING,
  effectiveFocusEdgeColor,
  type FocusEdgeMode,
  type FocusPreferences
} from "@shared/focus";
import assert from "node:assert/strict";
import test from "node:test";
import {
  FOCUS_HALO_UNKNOWN_POLICY,
  focusEdgeSnapshot,
  focusHaloDecision,
  type FocusHaloDecision
} from "./focus-edge";
import { FOREGROUND_UNKNOWN_REASONS, type ForegroundEvidence, type ForegroundUnknownReason } from "./foreground-evidence";
import {
  initialFocusState,
  reduceFocus,
  type FocusCapability,
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
const GOAL = { id: "goal-00000000-test", title: "Ship the guide", why: "", currentFocus: "Outline" };
const T0 = 1_800_000_000_000;
const HALO: FocusEdgeMode = "focus_halo";

class Session {
  state: FocusMachineState = initialFocusState(READY);
  sequence = 0;

  send(input: FocusInput): this {
    this.state = reduceFocus(this.state, input).state;
    return this;
  }

  start(now = T0): this {
    return this.send({
      type: "start",
      now,
      sessionId: "session-a",
      goal: GOAL,
      intention: "",
      domains: ["video.example"],
      durationMinutes: 25
    });
  }

  generation(): number {
    return this.state.session.status === "active" ? this.state.session.generation : 0;
  }

  browser(now: number, domain: string, observedAt = now): this {
    this.sequence += 1;
    const evidence: ForegroundEvidence = {
      kind: "browser",
      generation: this.generation(),
      sequence: this.sequence,
      observedAt,
      processIdentifier: 501,
      bundleIdentifier: "com.apple.Safari",
      domain
    };
    return this.send({ type: "evidence", now, evidence });
  }

  unknown(now: number, reason: ForegroundUnknownReason): this {
    this.sequence += 1;
    return this.send({
      type: "evidence",
      now,
      evidence: { kind: "unknown", generation: this.generation(), sequence: this.sequence, observedAt: now, reason }
    });
  }

  decision(now: number, mode: FocusEdgeMode = HALO): FocusHaloDecision {
    return focusHaloDecision(this.state, now, mode);
  }
}

function hiddenBecause(session: Session, now: number): string | undefined {
  const decision = session.decision(now);
  return decision.kind === "hidden" ? decision.reason : undefined;
}

test("fresh evidence of an unlisted site or an ordinary app shows the halo with its observation", () => {
  const session = new Session().start().browser(T0 + 1_000, "docs.example");
  assert.deepEqual(session.decision(T0 + 1_000), { kind: "visible", observation: { generation: 1, sequence: 1 } });
  session.unknown(T0 + 2_000, "other_application");
  assert.deepEqual(session.decision(T0 + 2_000), { kind: "visible", observation: { generation: 1, sequence: 2 } });
  session.unknown(T0 + 3_000, "own_process");
  assert.equal(session.decision(T0 + 3_000).kind, "visible");
});

test("a listed site, or any subdomain of one, hides the halo", () => {
  for (const domain of ["video.example", "m.video.example", "www.video.example"]) {
    const session = new Session().start().browser(T0 + 1_000, domain);
    assert.equal(hiddenBecause(session, T0 + 1_000), "distracting", domain);
  }
  assert.equal(new Session().start().browser(T0 + 1_000, "notvideo.example").decision(T0 + 1_000).kind, "visible");
});

test("every unknown reason has a halo policy, and only ordinary apps show it", () => {
  assert.deepEqual(Object.keys(FOCUS_HALO_UNKNOWN_POLICY).sort(), [...FOREGROUND_UNKNOWN_REASONS].sort());
  for (const reason of FOREGROUND_UNKNOWN_REASONS) {
    const expected = reason === "other_application" || reason === "own_process" ? "show" : "hide";
    assert.equal(FOCUS_HALO_UNKNOWN_POLICY[reason], expected, reason);
    const session = new Session().start().unknown(T0 + 1_000, reason);
    assert.equal(session.decision(T0 + 1_000).kind, expected === "show" ? "visible" : "hidden", reason);
    if (expected === "hide") assert.equal(hiddenBecause(session, T0 + 1_000), "uncertain", reason);
  }
});

test("missing, stale, future and earlier-generation evidence hide the halo", () => {
  const waiting = new Session().start();
  assert.equal(hiddenBecause(waiting, T0 + 500), "uncertain", "a new session waits for its first observation");

  const stale = new Session().start().browser(T0 + 1_000, "docs.example");
  assert.equal(stale.decision(T0 + 1_000 + FOCUS_TIMING.evidenceFreshnessMs).kind, "visible");
  assert.equal(hiddenBecause(stale, T0 + 1_001 + FOCUS_TIMING.evidenceFreshnessMs), "uncertain");

  const future = new Session().start().browser(T0 + 1_000, "docs.example", T0 + 1_001 + FOCUS_TIMING.evidenceFreshnessMs);
  assert.equal(hiddenBecause(future, T0 + 1_000), "uncertain");

  const previous = new Session().start().browser(T0 + 1_000, "docs.example");
  const accepted = previous.state.evidence;
  assert(accepted);
  previous.send({ type: "stop", now: T0 + 2_000 }).start(T0 + 2_000);
  previous.state = { ...previous.state, evidence: accepted };
  assert.equal(hiddenBecause(previous, T0 + 2_000), "uncertain", "evidence from an earlier generation never counts");
});

test("pause, stop, completion and restore hide the halo, and resuming waits for fresh evidence", () => {
  const session = new Session().start().browser(T0 + 1_000, "docs.example");
  session.send({ type: "pause_session", now: T0 + 2_000 });
  assert.equal(hiddenBecause(session, T0 + 2_000), "paused");
  session.send({ type: "resume_session", now: T0 + 3_000 });
  assert.equal(hiddenBecause(session, T0 + 3_000), "uncertain", "nothing from before the pause counts");
  session.browser(T0 + 3_100, "docs.example");
  assert.deepEqual(session.decision(T0 + 3_100), { kind: "visible", observation: { generation: 2, sequence: 2 } });

  session.send({ type: "stop", now: T0 + 4_000 });
  assert.equal(hiddenBecause(session, T0 + 4_000), "session");

  const completed = new Session().start().browser(T0 + 1_000, "docs.example");
  completed.send({ type: "tick", now: T0 + 25 * 60_000 });
  assert.equal(hiddenBecause(completed, T0 + 25 * 60_000), "session");

  const restored = new Session().send({
    type: "restore",
    now: T0,
    sessionId: "session-a",
    goal: GOAL,
    intention: "",
    domains: ["video.example"],
    startedAt: T0 - 60_000,
    totalMs: 25 * 60_000,
    remainingMs: 24 * 60_000,
    paused: false,
    snoozedUntil: null
  });
  assert.equal(hiddenBecause(restored, T0), "uncertain", "a restored session waits for fresh evidence");
  restored.browser(T0 + 500, "docs.example");
  assert.equal(restored.decision(T0 + 500).kind, "visible");
});

test("capability loss and a reminder preview hide the halo", () => {
  const session = new Session().start().browser(T0 + 1_000, "docs.example");
  const capabilities: Array<keyof FocusCapability> = ["privacyAccepted", "captureEnabled", "collectorAvailable",
    "accessibilityTrusted", "captureBrowserURLs", "overlayAvailable"];
  for (const lost of capabilities) {
    const without = { ...session.state, capability: { ...READY, [lost]: false } };
    const decision = focusHaloDecision(without, T0 + 1_000, HALO);
    assert.deepEqual(decision, { kind: "hidden", reason: "capability" }, lost);
  }

  session.send({ type: "preview", now: T0 + 1_100, previewId: "preview-a", copy: { title: "t", message: "m" } });
  assert.equal(hiddenBecause(session, T0 + 1_100), "preview");
  session.send({ type: "overlay_action", now: T0 + 1_200, action: "dismiss", nudgeId: "preview-a", preview: true });
  assert.equal(session.decision(T0 + 1_200).kind, "visible", "the halo returns while the evidence is still fresh");
});

test("snooze, dismiss, the global cooldown and idle time never change the halo", () => {
  const listed = new Session().start().browser(T0 + 1_000, "video.example");
  const nudge = listed.state.nudge;
  assert(nudge);
  listed.send({
    type: "overlay_action",
    now: T0 + 1_100,
    action: "dismiss",
    nudgeId: nudge.id,
    sessionId: "session-a",
    preview: false
  });
  listed.browser(T0 + 1_200, "video.example");
  assert.equal(listed.state.nudge, undefined, "dismissing holds the next reminder back");
  assert.equal(hiddenBecause(listed, T0 + 1_200), "distracting", "the halo stays hidden on a listed site");

  listed.send({ type: "snooze", now: T0 + 1_300 }).browser(T0 + 1_400, "video.example");
  assert.equal(hiddenBecause(listed, T0 + 1_400), "distracting", "even while snoozed");

  const cooldown = new Session().start().browser(T0 + 1_000, "video.example").browser(T0 + 1_100, "docs.example");
  cooldown.browser(T0 + 1_200, "video.example");
  assert.equal(cooldown.state.nudge, undefined, "the global cooldown holds the next reminder back");
  assert.equal(hiddenBecause(cooldown, T0 + 1_200), "distracting");

  const idle = new Session().start().send({ type: "tick", now: T0 + 500, idleSeconds: 10_000 });
  idle.browser(T0 + 1_000, "docs.example");
  assert.equal(idle.decision(T0 + 1_000).kind, "visible", "idle time alone doesn't hide a fresh safe halo");
  idle.browser(T0 + 1_100, "video.example");
  assert.equal(idle.state.nudge, undefined, "idle time holds reminders back");
  assert.equal(hiddenBecause(idle, T0 + 1_100), "distracting");

  const snoozedSafe = new Session().start().send({ type: "snooze", now: T0 + 500 }).browser(T0 + 1_000, "docs.example");
  assert.equal(snoozedSafe.decision(T0 + 1_000).kind, "visible", "snooze doesn't hide the halo on task");
});

test("a change to the site list applies to the halo at once", () => {
  const session = new Session().start().browser(T0 + 1_000, "docs.example");
  assert.equal(session.decision(T0 + 1_000).kind, "visible");
  session.send({ type: "domains_changed", now: T0 + 1_100, domains: ["docs.example"] });
  assert.equal(hiddenBecause(session, T0 + 1_100), "distracting");
  session.send({ type: "domains_changed", now: T0 + 1_200, domains: [] });
  assert.equal(session.decision(T0 + 1_200).kind, "visible");
});

test("only focus halo mode shows the halo", () => {
  const session = new Session().start().browser(T0 + 1_000, "docs.example");
  for (const mode of FOCUS_EDGE_MODES) {
    assert.equal(session.decision(T0 + 1_000, mode).kind, mode === "focus_halo" ? "visible" : "hidden", mode);
  }
});

test("the snapshot resolves sync from the progress color and never changes the edge's own color", () => {
  const session = new Session().start().browser(T0 + 1_000, "docs.example");
  const preferences: Pick<FocusPreferences, "edge" | "progressColor"> = {
    edge: { mode: HALO, color: "#8a75b8", syncWithProgress: true },
    progressColor: "#b86b5c"
  };
  assert.deepEqual(focusEdgeSnapshot(session.state, T0 + 1_000, preferences), {
    mode: HALO,
    color: "#b86b5c",
    halo: { kind: "visible", generation: 1, sequence: 1 }
  });
  assert.equal(preferences.edge.color, "#8a75b8");
  assert.equal(effectiveFocusEdgeColor({ ...preferences, progressColor: "#5c84b8" }), "#5c84b8",
    "a later progress color is followed");
  assert.equal(effectiveFocusEdgeColor({ ...preferences, edge: { ...preferences.edge, syncWithProgress: false } }),
    "#8a75b8", "turning sync off brings the edge's own color back");

  assert.deepEqual(focusEdgeSnapshot(session.state, T0 + 1_000, {
    edge: { mode: "distraction", color: FOCUS_EDGE_COLOR_DEFAULT, syncWithProgress: false },
    progressColor: "#b86b5c"
  }), { mode: "distraction", color: FOCUS_EDGE_COLOR_DEFAULT, halo: { kind: "hidden" } });
});
