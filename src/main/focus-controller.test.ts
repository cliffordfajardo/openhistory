import {
  FOCUS_TIMING,
  focusSessionRemainingMs,
  type FocusViewState,
  type PersistedFocusSession
} from "@shared/focus";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { FocusBarShowResult, FocusBarSnapshot } from "./focus-bar";
import {
  FocusController,
  type FocusBarBinding,
  type FocusOverlayBinding,
  type FocusOverlayRequest,
  type FocusOverlayShowResult,
  type FocusScreenCaptureBinding,
  type TimerBarBinding
} from "./focus-controller";
import type { TimerBarRequest, TimerBarResult } from "./focus-timer-bar";
import type { FocusCapability } from "./focus-state";
import { FocusStore } from "./focus-store";
import {
  SystemColorFilterController,
  type SystemColorFilterBinding,
  type SystemColorFilterSettings
} from "./system-color-filter";

class FakeOverlay implements FocusOverlayBinding {
  shown: FocusOverlayRequest[] = [];
  hidden: Array<{ nudgeId: string; immediate: boolean }> = [];
  handler: ((line: string) => void) | null = null;
  result: FocusOverlayShowResult = "shown";
  onShow?: () => void;

  show(request: FocusOverlayRequest): FocusOverlayShowResult {
    this.shown.push(request);
    this.onShow?.();
    return this.result;
  }

  hide(nudgeId: string, immediate: boolean): void {
    this.hidden.push({ nudgeId, immediate });
  }

  setActionHandler(handler: ((line: string) => void) | null): void {
    this.handler = handler;
  }
}

class FakeBar implements FocusBarBinding {
  snapshots: FocusBarSnapshot[] = [];
  hides = 0;
  focuses = 0;
  handler: ((line: string) => void) | null = null;
  result: FocusBarShowResult = "shown";

  update(snapshot: FocusBarSnapshot): FocusBarShowResult {
    this.snapshots.push(snapshot);
    return this.result;
  }

  hide(): void {
    this.hides += 1;
  }

  focus(): void {
    this.focuses += 1;
  }

  setActionHandler(handler: ((line: string) => void) | null): void {
    this.handler = handler;
  }
}

class FakeTimerBar implements TimerBarBinding {
  requests: TimerBarRequest[] = [];
  shutdowns = 0;
  result: TimerBarResult = "applied";

  update(request: TimerBarRequest): TimerBarResult {
    this.requests.push(request);
    return this.result;
  }

  shutdown(): void {
    this.shutdowns += 1;
  }
}

class FakeScreenCapture implements FocusScreenCaptureBinding {
  granted = false;
  requests = 0;
  grantOnRequest = false;

  access(): boolean {
    return this.granted;
  }

  request(): boolean {
    this.requests += 1;
    if (this.grantOnRequest) this.granted = true;
    return this.granted;
  }
}

class ManualTimers {
  callbacks = new Map<number, () => void>();
  private next = 0;

  setInterval = (callback: () => void): unknown => {
    this.next += 1;
    this.callbacks.set(this.next, callback);
    return this.next;
  };

  clearInterval = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };

  tick(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

class FailingSessionStore extends FocusStore {
  failSessionWrites = false;
  failEvenUnchanged = false;

  override saveSession(session: PersistedFocusSession | null): ReturnType<FocusStore["saveSession"]> {
    const changed = JSON.stringify(this.load().session) !== JSON.stringify(session);
    if (this.failSessionWrites && (changed || this.failEvenUnchanged)) {
      throw new Error("session disk unavailable");
    }
    return super.saveSession(session);
  }
}

interface Fixture {
  controller: FocusController;
  overlay: FakeOverlay;
  bar: FakeBar;
  timerBar: FakeTimerBar;
  timers: ManualTimers;
  observations: number[];
  clock: { now: number };
  capability: Omit<FocusCapability, "overlayAvailable">;
  states: FocusViewState[];
  store: FocusStore;
  directory: string;
  screenCapture: FakeScreenCapture;
}

const START_OF_TEST_TIME = 1_800_000_000_000;

async function fixture(
  context: TestContext,
  directory?: string,
  screenCapture = new FakeScreenCapture(),
  systemFilter?: SystemColorFilterController,
  startNow = START_OF_TEST_TIME,
  suppliedStore?: FocusStore
): Promise<Fixture> {
  const dataDirectory = directory ?? await testDirectory(context);
  const overlay = new FakeOverlay();
  const bar = new FakeBar();
  const timerBar = new FakeTimerBar();
  const timers = new ManualTimers();
  const observations: number[] = [];
  const clock = { now: startNow };
  const capability = {
    privacyAccepted: true,
    captureEnabled: true,
    collectorAvailable: true,
    accessibilityTrusted: true,
    captureBrowserURLs: true
  };
  let goalCounter = 0;
  const store = suppliedStore ?? new FocusStore(
    dataDirectory,
    () => `goal-0000000${(goalCounter += 1)}-test`
  );
  const controller = new FocusController({
    store,
    overlay,
    bar,
    timerBar,
    screenCapture,
    ...(systemFilter ? { systemFilter } : {}),
    setForegroundObservation: (generation) => observations.push(generation),
    capability: () => capability,
    now: () => clock.now,
    idleSeconds: () => 0,
    createSessionId: () => "session-fixed",
    createPreviewId: () => "preview-fixed",
    timers
  });
  const states: FocusViewState[] = [];
  controller.on("state", (state: FocusViewState) => states.push(state));
  context.after(() => controller.shutdown());
  return {
    controller, overlay, bar, timerBar, timers, observations, clock, capability, states, store,
    directory: dataDirectory, screenCapture
  };
}

function readyToStart(f: Fixture): string {
  const goalId = f.controller.saveGoal({ title: "Ship the guide", why: "Readers", currentFocus: "Outline" }).goals[0]!.id;
  f.controller.savePreferences({ domains: ["video.example"], durationMinutes: 25 });
  return goalId;
}

function evidence(f: Fixture, domain = "video.example", sequence = 1): void {
  f.controller.handleEvidence({
    kind: "browser",
    generation: f.observations.at(-1) ?? 0,
    sequence,
    observedAt: f.clock.now,
    processIdentifier: 501,
    bundleIdentifier: "com.apple.Safari",
    domain
  });
}

test("validates every renderer request at the boundary", async (context) => {
  const f = await fixture(context);
  for (const value of [undefined, null, 42, "goal", {}, { title: "" }, { title: "x", why: "", currentFocus: "", extra: 1 },
    { id: "../../etc", title: "x", why: "", currentFocus: "" }, { title: "x".repeat(10_000), why: "", currentFocus: "" }]) {
    assert.throws(() => f.controller.saveGoal(value), Error, JSON.stringify(value));
  }
  for (const value of [undefined, 1, "not-a-goal", "goal-../../x"]) {
    assert.throws(() => f.controller.deleteGoal(value));
    assert.throws(() => f.controller.selectGoal(value));
  }
  for (const value of [
    null,
    { domains: ["javascript:alert(1)"], durationMinutes: 25 },
    { domains: ["video.example"], durationMinutes: 1 },
    { domains: ["video.example"], durationMinutes: 25.5 },
    { domains: "video.example", durationMinutes: 25 },
    { domains: Array.from({ length: 101 }, (_, index) => `site${index}.example`), durationMinutes: 25 },
    { domains: ["video.example"], durationMinutes: 25, extra: true }
  ]) {
    assert.throws(() => f.controller.savePreferences(value), Error, String(JSON.stringify(value)).slice(0, 80));
  }
  assert.throws(() => f.controller.start({ goalId: "goal-00000009-test", intention: "", durationMinutes: 25 }), /existing goal/);
  assert.throws(() => f.controller.start({ goalId: 5, intention: "", durationMinutes: 25 }));
  assert.equal(f.controller.view().session.status, "idle");
  assert.deepEqual(f.observations, []);
});

test("requires at least one distracting site before starting", async (context) => {
  const f = await fixture(context);
  const goalId = f.controller.saveGoal({ title: "Goal", why: "", currentFocus: "" }).goals[0]!.id;
  assert.throws(() => f.controller.start({ goalId, intention: "", durationMinutes: 25 }), /distracting site/);
});

test("starts observation, shows one native reminder, and stops cleanly", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  const started = f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 50 });
  assert.equal(started.session.status, "active");
  assert.equal(started.preferences.durationMinutes, 50, "the chosen duration is remembered");
  assert.deepEqual(f.observations, [1]);
  assert.equal(f.timers.callbacks.size, 1, "a timer runs only during a session");

  f.clock.now += 1_000;
  evidence(f);
  assert.equal(f.overlay.shown.length, 1);
  assert.equal(f.overlay.shown[0]?.message, "Back to: Write the intro");
  assert.equal(f.controller.view().reminderVisible, true);

  f.controller.stop();
  assert.deepEqual(f.observations, [1, 0]);
  assert.deepEqual(f.overlay.hidden.at(-1), { nudgeId: f.overlay.shown[0]!.nudgeId, immediate: true });
  assert.equal(f.timers.callbacks.size, 0, "no timer while idle");
});

test("expires sessions on the timer and brings a running one back after a restart", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 5 });
  f.clock.now += 5 * 60_000;
  f.timers.tick();
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.observations.at(-1), 0);
  assert.equal(f.store.load().session, null, "a session that completed leaves nothing saved");

  f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 25 });
  const restarted = await fixture(context, f.directory, undefined, undefined, f.clock.now + 60_000);
  const session = restarted.controller.view().session;
  assert.equal(session.status, "active");
  assert.deepEqual(
    session.status === "active" ? [session.id, session.intention, session.goal.title] : [],
    ["session-fixed", "Write the intro", "Ship the guide"]
  );
  assert.equal(
    session.status === "active" ? focusSessionRemainingMs(session, restarted.clock.now) : 0,
    24 * 60_000,
    "the minute the app was closed counts against a running session"
  );
  assert.equal(restarted.controller.view().goals.length, 1, "goals persist across restarts");
  assert.deepEqual(restarted.observations, [1], "a restored session watches again from nothing seen");
  assert.equal(restarted.timers.callbacks.size, 1, "the countdown runs again");
});

test("routes native snooze and dismiss actions and ignores malformed or stale ones", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  const nudgeId = f.overlay.shown[0]!.nudgeId;
  const handler = f.overlay.handler!;

  for (const line of ["not json", "{}", JSON.stringify({ action: "explode", nudgeId, preview: false }),
    JSON.stringify({ action: "snooze", nudgeId, sessionId: "session-other", preview: false }),
    JSON.stringify({ action: "snooze", nudgeId: "nudge-forged", sessionId: "session-fixed", preview: false })]) {
    handler(line);
  }
  const view = f.controller.view();
  assert.equal(view.session.status === "active" ? view.session.snoozedUntil : "x", null);

  handler(JSON.stringify({ action: "snooze", nudgeId, sessionId: "session-fixed", preview: false }));
  const snoozed = f.controller.view();
  assert.notEqual(snoozed.session.status === "active" ? snoozed.session.snoozedUntil : null, null);
  assert.equal(snoozed.reminderVisible, false);
});

test("a refused native show does not leave a phantom reminder", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.overlay.result = "foreground_changed";
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  assert.equal(f.overlay.shown.length, 1);
  assert.equal(f.controller.view().reminderVisible, false);
});

test("pausing capture hides the reminder immediately and reports why Focus is quiet", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  f.capability.captureEnabled = false;
  f.controller.refreshCapability();
  assert.equal(f.overlay.hidden.at(-1)?.immediate, true);
  assert.equal(f.controller.view().detection, "capture_paused");
  f.capability.captureEnabled = true;
  f.capability.captureBrowserURLs = false;
  f.controller.refreshCapability();
  assert.equal(f.controller.view().detection, "url_capture_off");
});

test("a collector restart forgets evidence so restarted sequence numbers are accepted", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f, "docs.example", 50);
  f.controller.resetEvidence();
  assert.equal(f.controller.view().foreground, "waiting");
  evidence(f, "video.example", 1);
  assert.equal(f.overlay.shown.length, 1);
});

test("previews through the same native path without collection or a session", async (context) => {
  const f = await fixture(context);
  f.capability.captureEnabled = false;
  f.capability.accessibilityTrusted = false;
  f.controller.saveGoal({ title: "Ship the guide", why: "", currentFocus: "Outline" });
  f.controller.refreshCapability();
  f.controller.preview();
  assert.deepEqual(f.overlay.shown[0], {
    nudgeId: "preview-fixed",
    sessionId: null,
    title: "Ship the guide",
    message: "Back to: Outline",
    expectedProcessIdentifier: null,
    preview: true,
    experience: "amber",
    amberEdge: true
  });
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.timers.callbacks.size, 1, "a timer runs to fade the preview out");
});

test("reports a missing native overlay instead of pretending to preview", async (context) => {
  const directory = await testDirectory(context);
  const controller = new FocusController({
    store: new FocusStore(directory),
    overlay: undefined,
    setForegroundObservation: () => undefined,
    capability: () => ({
      privacyAccepted: true,
      captureEnabled: true,
      collectorAvailable: true,
      accessibilityTrusted: true,
      captureBrowserURLs: true
    })
  });
  assert.throws(() => controller.preview(), /isn't available/);
  assert.equal(controller.view().detection, "overlay_unavailable");
});

test("shutdown ends the session, clears reminders and detaches the native handler", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.controller.shutdown();
  assert.equal(f.observations.at(-1), 0);
  assert.equal(f.overlay.handler, null);
  assert.equal(f.timers.callbacks.size, 0);
  assert.throws(() => f.controller.start({ goalId, intention: "", durationMinutes: 25 }), /shutting down/);
});

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "openhistory-focus-controller-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}


test("reports a native preview rejection instead of claiming the reminder appeared", async (context) => {
  const f = await fixture(context);
  f.overlay.result = "no_display";
  assert.throws(() => f.controller.preview(), /could not be shown/);
  assert.equal(f.timers.callbacks.size, 0);
});


test("site edits apply to the active session without resetting its timer, goal or snooze", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  const started = f.controller.start({ goalId, intention: "Keep working", durationMinutes: 25 }).session;
  assert.equal(started.status, "active");
  evidence(f, "x.com");
  assert.equal(f.overlay.shown.length, 0);
  f.controller.savePreferences({ domains: ["video.example", "x.com"], durationMinutes: 50 });
  const updated = f.controller.view().session;
  assert.equal(updated.status, "active");
  if (started.status !== "active" || updated.status !== "active") assert.fail("session must remain active");
  assert.equal(updated.id, started.id);
  assert.equal(updated.endsAt, started.endsAt);
  assert.deepEqual(updated.goal, started.goal);
  assert.deepEqual(updated.domains, ["video.example", "x.com"]);
  assert.equal(f.overlay.shown.length, 1, "the freshly observed newly listed site nudges now");
  f.controller.savePreferences({ domains: ["video.example"], durationMinutes: 50 });
  assert.equal(f.overlay.hidden.at(-1)?.immediate, true);
  assert.equal(f.controller.view().reminderVisible, false);
  const snoozed = f.controller.snooze().session;
  f.controller.savePreferences({ domains: ["x.com"], durationMinutes: 25 });
  assert.equal(f.overlay.shown.length, 1, "adding a site must not bypass snooze");
  const stillSnoozed = f.controller.view().session;
  assert.equal(stillSnoozed.status === "active" ? stillSnoozed.snoozedUntil : null,
    snoozed.status === "active" ? snoozed.snoozedUntil : null);
  f.controller.savePreferences({ domains: [], durationMinutes: 25 });
  assert.equal(f.controller.view().session.status, "active");
  assert.equal(f.controller.view().reminderVisible, false);
  assert.deepEqual(f.observations, [1], "changing sites must not restart the collector observation");
});

function effectLine(nudgeId: string, status: "active" | "fallback", reason?: string): string {
  return JSON.stringify({ event: "effect", status, nudgeId, preview: false, ...(reason ? { reason } : {}) });
}

test("persists the reminder style; site edits without a style keep it", async (context) => {
  const f = await fixture(context);
  assert.equal(f.controller.view().preferences.experience, "amber");
  for (const value of [undefined, "", "sepia", 1, { experience: "grayscale_screen" }]) {
    assert.throws(() => f.controller.setExperience(value));
  }
  assert.equal(f.controller.setExperience("grayscale_screen").preferences.experience, "grayscale_screen");
  f.controller.savePreferences({ domains: ["video.example"], durationMinutes: 25 });
  assert.equal(f.controller.view().preferences.experience, "grayscale_screen");
  assert.throws(() => f.controller.savePreferences({ domains: [], durationMinutes: 25, experience: "sepia" }));

  const restarted = await fixture(context, f.directory);
  assert.equal(restarted.controller.view().preferences.experience, "grayscale_screen");
});

test("switching style mid-session keeps goal, timer, sites and snooze and swaps a visible reminder", async (context) => {
  const f = await fixture(context);
  f.screenCapture.granted = true;
  const goalId = readyToStart(f);
  const started = f.controller.start({ goalId, intention: "Keep working", durationMinutes: 25 }).session;
  f.clock.now += 1_000;
  evidence(f);
  const amber = f.overlay.shown.at(-1)!;
  assert.equal(amber.experience, "amber");

  f.controller.setExperience("grayscale_screen");
  assert.deepEqual(f.overlay.hidden.at(-1), { nudgeId: amber.nudgeId, immediate: true });
  const grayscale = f.overlay.shown.at(-1)!;
  assert.equal(grayscale.experience, "grayscale_screen");
  assert.notEqual(grayscale.nudgeId, amber.nudgeId);
  const view = f.controller.view();
  assert.deepEqual(view.session, started);
  assert.equal(view.effect?.status, "preparing");
  assert.equal(view.reminderVisible, true);

  f.controller.snooze();
  const snoozed = f.controller.view().session;
  f.controller.setExperience("amber");
  f.controller.savePreferences({ domains: ["video.example", "x.com"], durationMinutes: 25 });
  evidence(f, "video.example", 2);
  assert.equal(f.overlay.shown.length, 2, "switching style must not bypass snooze");
  const after = f.controller.view().session;
  if (after.status !== "active" || snoozed.status !== "active") assert.fail("session must remain active");
  assert.equal(after.snoozedUntil, snoozed.snoozedUntil);
  assert.equal(after.endsAt, snoozed.endsAt);
  assert.deepEqual(after.domains, ["video.example", "x.com"]);
  assert.deepEqual(f.observations, [1], "switching style must not restart observation");
});

test("reports grayscale only after the native first-frame report for that reminder", async (context) => {
  const f = await fixture(context);
  f.screenCapture.granted = true;
  f.controller.setExperience("grayscale_screen");
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  const nudgeId = f.overlay.shown[0]!.nudgeId;
  assert.equal(f.controller.view().effect?.status, "preparing");

  for (const line of [effectLine("nudge-forged", "active"), JSON.stringify({ event: "effect", status: "shown", nudgeId, preview: false }),
    JSON.stringify({ event: "effect", status: "active", nudgeId, preview: false, extra: 1 })]) {
    f.overlay.handler!(line);
  }
  assert.equal(f.controller.view().effect?.status, "preparing");
  f.overlay.handler!(effectLine(nudgeId, "active"));
  assert.equal(f.controller.view().effect?.status, "showing");

  f.controller.stop();
  f.overlay.handler!(effectLine(nudgeId, "fallback", "capture_failed"));
  const effect = f.controller.view().effect;
  assert.deepEqual([effect?.status, effect?.visible], ["showing", false], "a late failure after hide is ignored");
});

test("a native capture failure is reported as an amber fallback with its reason", async (context) => {
  const f = await fixture(context);
  f.screenCapture.granted = true;
  f.controller.setExperience("grayscale_screen");
  f.controller.saveGoal({ title: "Goal", why: "", currentFocus: "" });
  f.controller.preview();
  f.overlay.handler!(JSON.stringify({ event: "effect", status: "fallback", nudgeId: "preview-fixed", preview: true, reason: "no_frame" }));
  const effect = f.controller.view().effect;
  assert.deepEqual([effect?.status, effect?.fallbackReason, effect?.visible], ["fallback", "no_frame", true]);
  f.overlay.handler!(JSON.stringify({ event: "effect", status: "active", nudgeId: "preview-fixed", preview: true }));
  assert.equal(f.controller.view().effect?.status, "fallback");
});

test("without Screen Recording, grayscale falls back to amber and never prompts on its own", async (context) => {
  const f = await fixture(context);
  f.controller.setExperience("grayscale_screen");
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  f.timers.tick();
  assert.equal(f.overlay.shown[0]?.experience, "amber");
  const view = f.controller.view();
  assert.equal(view.detection, "ready", "browser readiness is separate from Screen Recording");
  assert.deepEqual(view.screenCapture, { access: "not_granted", requested: false });
  assert.deepEqual([view.effect?.status, view.effect?.fallbackReason], ["fallback", "permission_needed"]);
  assert.equal(f.screenCapture.requests, 0);
});

test("requests Screen Recording once per launch and rechecks without prompting", async (context) => {
  const f = await fixture(context);
  assert.deepEqual(f.controller.requestScreenCapture().screenCapture, { access: "not_granted", requested: true });
  f.controller.requestScreenCapture();
  f.controller.refreshScreenCapture();
  assert.equal(f.screenCapture.requests, 1, "the system prompt is requested at most once");

  f.screenCapture.granted = true;
  assert.equal(f.controller.refreshScreenCapture().screenCapture.access, "granted");
  f.controller.setExperience("grayscale_screen");
  f.controller.saveGoal({ title: "Goal", why: "", currentFocus: "" });
  f.controller.preview();
  assert.equal(f.overlay.shown.at(-1)?.experience, "grayscale_screen");
});

test("a native preflight refusal shows amber, records the reason and rechecks access", async (context) => {
  const f = await fixture(context);
  f.screenCapture.granted = true;
  f.controller.setExperience("grayscale_screen");
  f.controller.saveGoal({ title: "Goal", why: "", currentFocus: "" });
  // Access was revoked after the last check; the native preflight is the final authority.
  f.overlay.result = "shown_fallback_permission";
  f.overlay.onShow = () => { f.screenCapture.granted = false; };
  f.controller.preview();
  assert.equal(f.overlay.shown.at(-1)?.experience, "grayscale_screen");
  const view = f.controller.view();
  assert.equal(view.effect?.status, "fallback");
  assert.equal(view.effect?.fallbackReason, "permission_needed");
  assert.equal(view.screenCapture.access, "not_granted");
  assert.equal(f.timers.callbacks.size, 1, "the fallback preview still expires");
});

test("a bridge without screen capture reports grayscale as unsupported", async (context) => {
  const directory = await testDirectory(context);
  const overlay = new FakeOverlay();
  const store = new FocusStore(directory);
  store.setExperience("grayscale_screen");
  const controller = new FocusController({
    store,
    overlay,
    setForegroundObservation: () => undefined,
    capability: () => ({
      privacyAccepted: true,
      captureEnabled: true,
      collectorAvailable: true,
      accessibilityTrusted: true,
      captureBrowserURLs: true
    }),
    createPreviewId: () => "preview-fixed"
  });
  context.after(() => controller.shutdown());
  assert.equal(controller.view().screenCapture.access, "unsupported");
  assert.throws(() => controller.requestScreenCapture(), /isn't available/);
  controller.preview();
  assert.equal(overlay.shown[0]?.experience, "amber");
  assert.equal(controller.view().effect?.fallbackReason, "unsupported");
});

test("preview expiry hides grayscale and ignores its late first frame", async (context) => {
  const f = await fixture(context);
  f.screenCapture.granted = true;
  f.controller.setExperience("grayscale_screen");
  f.controller.saveGoal({ title: "Goal", why: "", currentFocus: "" });
  f.controller.preview();
  f.clock.now += 8_000;
  f.timers.tick();
  assert.deepEqual(f.overlay.hidden.at(-1), { nudgeId: "preview-fixed", immediate: false });
  assert.equal(f.timers.callbacks.size, 0, "no timer after the preview ends");
  f.overlay.handler!(JSON.stringify({ event: "effect", status: "active", nudgeId: "preview-fixed", preview: true }));
  const effect = f.controller.view().effect;
  assert.deepEqual([effect?.status, effect?.visible], ["preparing", false]);
});

test("persists the grayscale window style and sends the matched site only with window reminders", async (context) => {
  const f = await fixture(context);
  f.screenCapture.granted = true;
  assert.equal(f.controller.setExperience("grayscale_window").preferences.experience, "grayscale_window");
  const restarted = await fixture(context, f.directory);
  assert.equal(restarted.controller.view().preferences.experience, "grayscale_window");

  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f, "m.video.example");
  const request = f.overlay.shown.at(-1)!;
  assert.equal(request.experience, "grayscale_window");
  assert.equal(request.domain, "video.example", "the rule, not the observed host, is sent");
  assert.equal(f.controller.view().effect?.status, "preparing");
  f.overlay.handler!(effectLine(request.nudgeId, "active"));
  assert.equal(f.controller.view().effect?.status, "showing");

  f.controller.setExperience("grayscale_screen");
  const screen = f.overlay.shown.at(-1)!;
  assert.equal(screen.experience, "grayscale_screen");
  assert.equal(screen.domain, undefined);
  assert.deepEqual(f.observations, [1], "switching style must not restart observation");
});

test("window targeting failures show amber and keep their specific reason", async (context) => {
  for (const [result, reason] of [
    ["shown_fallback_window", "window_unavailable"],
    ["shown_fallback_window_spans_displays", "window_spans_displays"]
  ] as const) {
    const f = await fixture(context);
    f.screenCapture.granted = true;
    f.controller.setExperience("grayscale_window");
    f.overlay.result = result;
    const goalId = readyToStart(f);
    f.controller.start({ goalId, intention: "", durationMinutes: 25 });
    f.clock.now += 1_000;
    evidence(f);
    const view = f.controller.view();
    assert.equal(view.reminderVisible, true, "the card still shows");
    assert.deepEqual([view.effect?.status, view.effect?.fallbackReason], ["fallback", reason]);
  }

  const f = await fixture(context);
  f.screenCapture.granted = true;
  f.controller.setExperience("grayscale_window");
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  const nudgeId = f.overlay.shown.at(-1)!.nudgeId;
  f.overlay.handler!(effectLine(nudgeId, "fallback", "window_moved_somewhere"));
  assert.equal(f.controller.view().effect?.status, "preparing", "unknown reasons are rejected");
  f.overlay.handler!(effectLine(nudgeId, "active"));
  f.overlay.handler!(effectLine(nudgeId, "fallback", "window_spans_displays"));
  assert.deepEqual(
    [f.controller.view().effect?.status, f.controller.view().effect?.fallbackReason],
    ["fallback", "window_spans_displays"],
    "a window dragged across displays later falls back"
  );
});

test("a grayscale window preview targets this app without a site and never prompts", async (context) => {
  const f = await fixture(context);
  f.controller.setExperience("grayscale_window");
  f.controller.saveGoal({ title: "Goal", why: "", currentFocus: "" });
  f.controller.preview();
  assert.equal(f.overlay.shown.at(-1)?.experience, "amber", "no Screen Recording means amber");
  assert.equal(f.controller.view().effect?.fallbackReason, "permission_needed");
  assert.equal(f.screenCapture.requests, 0);

  f.clock.now += 8_000;
  f.timers.tick();
  f.screenCapture.granted = true;
  f.controller.refreshScreenCapture();
  f.overlay.shown = [];
  f.controller.preview();
  const request = f.overlay.shown.at(-1)!;
  assert.deepEqual(
    [request.experience, request.preview, request.domain, request.expectedProcessIdentifier],
    ["grayscale_window", true, undefined, null]
  );
});

const GRAY = { enabled: true, type: 1 };

/** Stands in for the persisted macOS Color Filters setting. */
class FakeColorFilters implements SystemColorFilterBinding {
  writes: SystemColorFilterSettings[] = [];
  writable = true;

  constructor(public settings: SystemColorFilterSettings = { enabled: false, type: 2 }) {}

  read(): SystemColorFilterSettings | null {
    return { ...this.settings };
  }

  write(settings: SystemColorFilterSettings): boolean {
    this.writes.push({ ...settings });
    if (this.writable) this.settings = { ...settings };
    return this.writable;
  }
}

async function systemFixture(
  context: TestContext,
  filters = new FakeColorFilters()
): Promise<Fixture & { filters: FakeColorFilters }> {
  const directory = await testDirectory(context);
  const filter = new SystemColorFilterController({
    binding: filters,
    journalPath: resolve(directory, "color-filter-restore.json")
  });
  const f = await fixture(context, directory, new FakeScreenCapture(), filter);
  return { ...f, filters };
}

async function systemSession(context: TestContext): Promise<Fixture & { filters: FakeColorFilters }> {
  const f = await systemFixture(context);
  f.controller.setExperience("grayscale_system");
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  return f;
}

test("a system grayscale reminder writes once, needs no Screen Recording and restores on hide", async (context) => {
  const f = await systemSession(context);
  assert.deepEqual(f.filters.writes, [], "choosing the style changes nothing yet");
  evidence(f);
  const shown = f.overlay.shown.at(-1)!;
  assert.deepEqual([shown.experience, shown.amberEdge], ["grayscale_system", true]);
  assert.deepEqual(f.filters.writes, [GRAY]);
  assert.deepEqual([f.controller.view().effect?.status, f.controller.view().systemFilter.phase], ["showing", "applied"]);

  for (let index = 0; index < 5; index += 1) {
    f.clock.now += 500;
    evidence(f, "video.example", 2 + index);
    f.timers.tick();
  }
  assert.equal(f.filters.writes.length, 1, "ticks and repeated evidence never rewrite");
  assert.equal(f.screenCapture.requests, 0);

  evidence(f, "safe.example", 20);
  assert.deepEqual(f.filters.settings, { enabled: false, type: 2 }, "the earlier settings return, not just off");
  assert.equal(f.controller.view().systemFilter.phase, "idle");
});

test("snooze, stop and shutdown each restore the earlier settings", async (context) => {
  for (const end of ["snooze", "stop", "shutdown"] as const) {
    const f = await systemSession(context);
    f.filters.settings = { enabled: true, type: 8 };
    evidence(f);
    assert.deepEqual(f.filters.settings, GRAY);
    if (end === "snooze") f.controller.snooze();
    else if (end === "stop") f.controller.stop();
    else f.controller.shutdown();
    assert.deepEqual(f.filters.settings, { enabled: true, type: 8 }, end);
  }
});

test("a failed turn-on shows the reminder without grayscale and isn't retried on ticks", async (context) => {
  const f = await systemSession(context);
  f.filters.writable = false;
  evidence(f);
  const view = f.controller.view();
  assert.deepEqual([view.effect?.status, view.effect?.fallbackReason, view.reminderVisible], ["fallback", "system_filter_failed", true]);
  assert.equal(view.systemFilter.failure, "apply_failed");
  const attempts = f.filters.writes.length;
  for (let index = 0; index < 5; index += 1) {
    f.clock.now += 500;
    evidence(f, "video.example", 2 + index);
    f.timers.tick();
  }
  assert.equal(f.filters.writes.length, attempts);

  f.filters.writable = true;
  evidence(f, "safe.example", 10);
  f.clock.now += FOCUS_TIMING.globalCooldownMs;
  evidence(f, "video.example", 11);
  assert.deepEqual([f.controller.view().effect?.status, f.controller.view().systemFilter.failure], ["showing", null]);
});

test("system grayscale can't be chosen without the native setting, and a saved choice falls back", async (context) => {
  const unreadable = new FakeColorFilters();
  unreadable.read = () => null;
  const f = await systemFixture(context, unreadable);
  assert.throws(() => f.controller.setExperience("grayscale_system"), /isn’t available on this Mac/);
  assert.equal(f.controller.view().systemFilter.phase, "unsupported");

  const directory = await testDirectory(context);
  new FocusStore(directory).setExperience("grayscale_system");
  const saved = await fixture(context, directory, new FakeScreenCapture(), new SystemColorFilterController({
    binding: undefined,
    journalPath: resolve(directory, "color-filter-restore.json")
  }));
  saved.controller.preview();
  assert.deepEqual(
    [saved.controller.view().effect?.status, saved.controller.view().effect?.fallbackReason],
    ["fallback", "system_filter_unavailable"]
  );
});

test("style and amber edge changes during a system grayscale reminder keep the session", async (context) => {
  const f = await systemSession(context);
  evidence(f);
  const session = f.controller.view().session;

  f.controller.setAmberEdge(false);
  const edgeless = f.overlay.shown.at(-1)!;
  assert.deepEqual([edgeless.experience, edgeless.amberEdge], ["grayscale_system", false]);
  assert.equal(f.filters.writes.length, 1, "the edge toggle doesn't cycle Color Filters");
  assert.equal(f.controller.view().effect?.status, "showing");
  assert.throws(() => f.controller.setAmberEdge("no"));
  assert.equal(new FocusStore(f.directory).load().preferences.amberEdge, false);

  f.screenCapture.granted = true;
  f.controller.setExperience("grayscale_screen");
  assert.equal(f.overlay.shown.at(-1)!.experience, "grayscale_screen");
  assert.deepEqual(f.filters.settings, { enabled: false, type: 2 });
  f.controller.setExperience("grayscale_system");
  assert.deepEqual(f.filters.settings, GRAY);
  assert.equal(f.controller.view().effect?.status, "showing");
  assert.deepEqual(f.controller.view().session, session);
  assert.deepEqual(f.observations, [1]);
});

test("restore colors during a preview keeps it from turning grayscale back on", async (context) => {
  const f = await systemFixture(context);
  f.controller.setExperience("grayscale_system");
  f.controller.preview();
  assert.deepEqual(f.filters.settings, GRAY);

  const restored = f.controller.restoreSystemColors();
  assert.deepEqual([restored.effect?.status, restored.effect?.fallbackReason], ["fallback", "system_filter_restored"]);
  assert.deepEqual([restored.systemFilter.phase, restored.systemFilter.restorePending], ["idle", false]);
  assert.deepEqual(f.filters.settings, { enabled: false, type: 2 });
  f.timers.tick();
  assert.equal(f.filters.writes.length, 2, "the preview doesn't turn it back on");

  f.clock.now += 10_000;
  f.timers.tick();
  assert.equal(f.controller.view().effect?.visible, false);
  assert.equal(f.filters.writes.length, 2, "ending the preview has nothing left to restore");
});

test("the floating bar follows the session and is not repainted from the main process each second", async (context) => {
  const f = await fixture(context);
  assert.equal(f.bar.snapshots.length, 0, "no bar without a session");
  assert.equal(f.controller.view().barAvailable, true);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 25 });
  const first = f.bar.snapshots.at(-1)!;
  assert.deepEqual(
    [first.sessionId, first.goalTitle, first.pausedRemainingSeconds, first.totalSeconds, first.position],
    ["session-fixed", "Ship the guide", null, 1_500, null]
  );
  assert.equal(first.endsAtEpochSeconds, Math.round((f.clock.now + 25 * 60_000) / 1_000));

  const sent = f.bar.snapshots.length;
  for (let index = 0; index < 5; index += 1) {
    f.clock.now += 1_000;
    f.timers.tick();
  }
  assert.equal(f.bar.snapshots.length, sent, "the countdown itself never re-sends a snapshot");

  f.controller.stop();
  assert.equal(f.bar.hides, 1, "completing the session removes the bar");
  f.controller.stop();
  assert.equal(f.bar.hides, 1, "an already hidden bar is not hidden again");
});

test("the bar preference decides whether the floating bar is shown at all", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.setBarPresentation("menuBar");
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  assert.deepEqual(f.bar.snapshots, [], "menu-bar only keeps the floating bar away");
  assert.equal(f.controller.view().preferences.barPresentation, "menuBar");

  f.controller.setBarPresentation("floating");
  assert.equal(f.bar.snapshots.length, 1, "switching back shows the same session");
  const session = f.controller.view().session;
  assert.equal(session.status === "active" ? session.id : "", "session-fixed");
  for (const value of [undefined, null, "hud", 1, { barPresentation: "floating" }]) {
    assert.throws(() => f.controller.setBarPresentation(value));
  }
  const restarted = await fixture(context, f.directory);
  assert.equal(restarted.controller.view().preferences.barPresentation, "floating");
});

test("pausing from the bar freezes the session, restores colors and stops reminders", async (context) => {
  const f = await systemSession(context);
  evidence(f);
  assert.deepEqual(f.filters.settings, GRAY);
  const shown = f.bar.snapshots.at(-1)!;
  assert.equal(shown.pausedRemainingSeconds, null);

  f.bar.handler!(JSON.stringify({ action: "pause", sessionId: "session-fixed" }));
  assert.deepEqual(f.filters.settings, { enabled: false, type: 2 }, "a pause gives the colors back");
  assert.equal(f.overlay.hidden.at(-1)?.immediate, true);
  assert.equal(f.observations.at(-1), 0, "nothing is watched while paused");
  const paused = f.bar.snapshots.at(-1)!;
  assert.equal(paused.endsAtEpochSeconds, null);
  assert.equal(paused.pausedRemainingSeconds, 1_499);
  assert.equal(f.controller.view().foreground, "paused");

  const shownBefore = f.overlay.shown.length;
  f.clock.now += 30 * 60_000;
  f.timers.tick();
  evidence(f, "video.example", 40);
  assert.equal(f.controller.view().session.status, "active", "a paused session outlives its first deadline");
  assert.equal(f.overlay.shown.length, shownBefore, "no reminder while paused");

  f.bar.handler!(JSON.stringify({ action: "resume", sessionId: "session-fixed" }));
  assert.equal(f.observations.at(-1), 2, "resuming asks for a new observation generation");
  evidence(f, "video.example", 1);
  assert.equal(f.overlay.shown.length, shownBefore + 1, "fresh evidence nudges again after resuming");
});

test("bar actions complete, edit and move the session, and stale or malformed ones are dropped", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  let editRequests = 0;
  f.controller.on("editRequested", () => { editRequests += 1; });

  for (const line of [
    "not json",
    "{}",
    JSON.stringify({ action: "explode", sessionId: "session-fixed" }),
    JSON.stringify({ action: "pause" }),
    JSON.stringify({ action: "pause", sessionId: "session-other" }),
    JSON.stringify({ action: "complete", sessionId: "session-fixed", extra: true }),
    JSON.stringify({ action: "moved", sessionId: "session-fixed", x: Number.MAX_VALUE, y: 0 }),
    JSON.stringify({ action: "moved", sessionId: "session-fixed", x: 10 })
  ]) {
    f.bar.handler!(line);
  }
  assert.equal(f.controller.view().session.status, "active", "no malformed line touches the session");
  assert.equal(f.controller.view().barPosition, null);
  assert.equal(editRequests, 0);

  f.bar.handler!(JSON.stringify({ action: "moved", sessionId: "session-fixed", x: 120.6, y: 88 }));
  assert.deepEqual(f.controller.view().barPosition, { x: 121, y: 88 });
  f.bar.handler!(JSON.stringify({ action: "edit", sessionId: "session-fixed" }));
  assert.equal(editRequests, 1, "the bar asks the app to open the editor instead of editing itself");
  f.bar.handler!(JSON.stringify({ action: "move_to_menu_bar", sessionId: "session-fixed" }));
  assert.equal(f.controller.view().preferences.barPresentation, "menuBar");
  assert.equal(f.bar.hides, 1);

  f.bar.handler!(JSON.stringify({ action: "complete", sessionId: "session-fixed" }));
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.observations.at(-1), 0);

  const restarted = await fixture(context, f.directory);
  assert.deepEqual(restarted.controller.view().barPosition, { x: 121, y: 88 },
    "the saved place is remembered for the next session");
  restarted.controller.setBarPresentation("floating");
  restarted.controller.start({
    goalId: restarted.controller.view().goals[0]!.id,
    intention: "",
    durationMinutes: 25
  });
  assert.deepEqual(restarted.bar.snapshots.at(-1)?.position, { x: 121, y: 88 });
});

test("resizing the bar saves its width with its corner, and impossible or stale widths are dropped", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  assert.equal(f.bar.snapshots.at(-1)?.width, 460, "a bar that has never been resized is the compact one");

  for (const line of [
    JSON.stringify({ action: "resized", sessionId: "session-fixed", x: 0, y: 40 }),
    JSON.stringify({ action: "resized", sessionId: "session-fixed", x: 0, y: 40, width: 10 }),
    JSON.stringify({ action: "resized", sessionId: "session-fixed", x: 0, y: 40, width: 100_000 }),
    JSON.stringify({ action: "resized", sessionId: "session-fixed", x: Number.MAX_VALUE, y: 40, width: 1_200 }),
    JSON.stringify({ action: "resized", sessionId: "session-other", x: 0, y: 40, width: 1_200 })
  ]) {
    f.bar.handler!(line);
  }
  assert.equal(f.bar.snapshots.at(-1)?.width, 460, "a missing, impossible or stale resize changes nothing");
  assert.equal(f.controller.view().barPosition, null, "and none of them moves the bar either");

  f.bar.handler!(JSON.stringify({ action: "resized", sessionId: "session-fixed", x: 12.4, y: 40, width: 1_200.6 }));
  assert.deepEqual(f.controller.view().barPosition, { x: 12, y: 40 }, "one resize saves the corner and the width");
  assert.equal(f.bar.snapshots.at(-1)?.width, 1_201);

  f.bar.handler!(JSON.stringify({ action: "moved", sessionId: "session-fixed", x: 30, y: 40 }));
  assert.equal(f.bar.snapshots.at(-1)?.width, 1_201, "moving the bar afterwards keeps the width");

  const restarted = await fixture(context, f.directory);
  restarted.controller.start({
    goalId: restarted.controller.view().goals[0]!.id,
    intention: "",
    durationMinutes: 25
  });
  assert.equal(restarted.bar.snapshots.at(-1)?.width, 1_201,
    "the width is remembered for the next session, like the position");
});

test("a bar click that arrives after its session ended cannot affect the next one", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.controller.stop();
  f.bar.handler!(JSON.stringify({ action: "pause", sessionId: "session-fixed" }));
  assert.equal(f.controller.view().session.status, "idle", "a late click never starts anything");

  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.bar.handler!(JSON.stringify({ action: "pause", sessionId: "session-earlier" }));
  const session = f.controller.view().session;
  assert.equal(session.status === "active" ? session.endsAt !== null : false, true, "the new session keeps running");
});

test("editing the running session keeps it and never rewrites the goal", async (context) => {
  const f = await fixture(context);
  const first = readyToStart(f);
  const second = f.controller.saveGoal({ title: "Second goal", why: "", currentFocus: "Draft" }).goals
    .find((goal) => goal.id !== first)!.id;
  const started = f.controller.start({ goalId: first, intention: "Write the intro", durationMinutes: 25 }).session;
  f.clock.now += 5 * 60_000;

  const edited = f.controller.editSession({
    goalId: second,
    intention: "Draft section two",
    remainingMinutes: 10
  }).session;
  if (started.status !== "active" || edited.status !== "active") assert.fail("the session must remain active");
  assert.equal(edited.id, started.id);
  assert.equal(edited.goal.id, second);
  assert.equal(edited.intention, "Draft section two");
  assert.equal(edited.endsAt, new Date(f.clock.now + 10 * 60_000).toISOString());
  assert.equal(edited.totalMs, 15 * 60_000);
  assert.equal(f.controller.view().selectedGoalId, second, "editing selects the goal it now points at");
  assert.deepEqual(f.store.goal(second), { id: second, title: "Second goal", why: "", currentFocus: "Draft" },
    "the stored goal itself is untouched");
  assert.deepEqual(f.observations, [1], "an edit never restarts observation");
  assert.equal(f.bar.snapshots.at(-1)?.goalTitle, "Second goal");

  for (const value of [undefined, null, {}, { intention: "x", extra: 1 }, { remainingMinutes: 0 },
    { remainingMinutes: 241 }, { remainingMinutes: 5.5 }, { goalId: "goal-missing-00000000" }]) {
    assert.throws(() => f.controller.editSession(value), Error, JSON.stringify(value));
  }
  assert.equal(f.controller.editSession({ remainingMinutes: 1 }).session.status, "active",
    "a running session can be shortened to a single minute");
});

test("a deleted goal leaves the session editable through its remaining fields", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  const spare = f.controller.saveGoal({ title: "Spare", why: "", currentFocus: "" }).goals
    .find((goal) => goal.id !== goalId)!.id;
  f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 25 });
  f.controller.deleteGoal(goalId);
  const session = f.controller.view().session;
  assert.equal(session.status === "active" ? session.goal.id : "", goalId, "the session keeps its own snapshot");

  const edited = f.controller.editSession({ intention: "Keep going" }).session;
  assert.equal(edited.status === "active" ? edited.goal.id : "", goalId);
  assert.equal(edited.status === "active" ? edited.intention : "", "Keep going");
  assert.equal(f.controller.editSession({ goalId: spare }).session.status, "active");
  assert.throws(() => f.controller.editSession({ goalId }), /existing goal/);
});

test("editing needs a running session, and the bar can only be focused during one", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  assert.throws(() => f.controller.editSession({ intention: "Nothing to edit" }), /No focus session/);
  assert.throws(() => f.controller.focusBar(), /No focus session/);
  f.controller.setBarPresentation("menuBar");
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.controller.focusBar();
  assert.equal(f.bar.focuses, 1);
  assert.equal(f.controller.view().preferences.barPresentation, "floating",
    "asking for the bar by keyboard brings it back");
  assert.equal(f.bar.snapshots.length, 1);
});

test("a build without the native bar keeps the session in the menu bar", async (context) => {
  const directory = await testDirectory(context);
  const controller = new FocusController({
    store: new FocusStore(directory, () => "goal-00000001-test"),
    overlay: new FakeOverlay(),
    setForegroundObservation: () => undefined,
    capability: () => ({
      privacyAccepted: true,
      captureEnabled: true,
      collectorAvailable: true,
      accessibilityTrusted: true,
      captureBrowserURLs: true
    }),
    timers: new ManualTimers()
  });
  context.after(() => controller.shutdown());
  const goalId = controller.saveGoal({ title: "Goal", why: "", currentFocus: "" }).goals[0]!.id;
  controller.savePreferences({ domains: ["video.example"], durationMinutes: 25 });
  assert.equal(controller.view().barAvailable, false);
  assert.equal(controller.view().timerBarAvailable, false);
  assert.throws(() => controller.focusBar(), /isn't available/);
  assert.throws(() => controller.setShowTimerBar(true), /isn’t available/);
  assert.equal(controller.setShowTimerBar(false).preferences.showTimerBar, false,
    "turning an unavailable bar off is still allowed");
  assert.equal(controller.start({ goalId, intention: "", durationMinutes: 25 }).session.status, "active");
});

test("the timer bar follows the preference, the session's own clock and every tick", async (context) => {
  const f = await fixture(context);
  assert.equal(f.controller.view().timerBarAvailable, true);
  assert.equal(f.controller.view().preferences.showTimerBar, false, "it is off until it is chosen");

  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  assert.deepEqual(f.timerBar.requests, [{ enabled: false, session: null }],
    "a switched-off bar is told once and never again");

  const startedAt = f.clock.now;
  f.controller.setShowTimerBar(true);
  const running = {
    endsAtEpochSeconds: (startedAt + 1_500_000) / 1_000,
    pausedRemainingSeconds: null,
    totalSeconds: 1_500
  };
  assert.deepEqual(f.timerBar.requests.at(-1), { enabled: true, session: running });

  const before = f.timerBar.requests.length;
  for (let second = 0; second < 2; second += 1) {
    f.clock.now += 1_000;
    f.timers.tick();
  }
  assert.equal(f.timerBar.requests.length, before + 2,
    "a running session is re-sent each second so the native side resamples its displays");
  assert.deepEqual(f.timerBar.requests.at(-1)?.session, running, "always from the same anchored deadline");

  f.controller.pauseSession();
  assert.deepEqual(f.timerBar.requests.at(-1)?.session, {
    endsAtEpochSeconds: null,
    pausedRemainingSeconds: 1_498,
    totalSeconds: 1_500
  }, "a pause freezes the bar on the remainder rather than a deadline");

  f.controller.stop();
  assert.deepEqual(f.timerBar.requests.at(-1), { enabled: true, session: null },
    "an idle bar stays enabled, so its panels are kept for the next session");
  const idle = f.timerBar.requests.length;
  f.controller.setShowTimerBar(false);
  assert.deepEqual(f.timerBar.requests.at(-1), { enabled: false, session: null });
  f.controller.saveGoal({ title: "Another", why: "", currentFocus: "" });
  assert.equal(f.timerBar.requests.length, idle + 1, "nothing is re-sent while the preference is off");
});

test("the timer bar is independent of where the session itself is shown", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.setShowTimerBar(true);
  f.controller.setBarPresentation("menuBar");
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  assert.deepEqual(f.bar.snapshots, [], "the floating bar stays away");
  assert.equal(f.timerBar.requests.at(-1)?.session?.totalSeconds, 1_500, "the timer bar does not");

  f.controller.setBarPresentation("floating");
  assert.equal(f.bar.snapshots.length, 1);
  assert.equal(f.timerBar.requests.at(-1)?.enabled, true, "and both can be on together");
});

test("quitting keeps the saved session; shutting down for deletion clears it", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.setShowTimerBar(true);
  f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 25 });
  assert.equal(f.store.load().session?.id, "session-fixed");

  f.controller.shutdown({ retainSession: true });
  assert.equal(f.store.load().session?.id, "session-fixed", "a quit keeps it for the next launch");
  assert.equal(f.controller.view().session.status, "idle", "but it still ends in this launch");
  assert.equal(f.observations.at(-1), 0, "and nothing is watched any more");
  assert.equal(f.timerBar.shutdowns, 1, "every native panel goes away");
  assert.equal(f.bar.hides, 1);

  const afterQuit = await fixture(context, f.directory, undefined, undefined, f.clock.now + 5 * 60_000);
  assert.equal(afterQuit.controller.view().session.status, "active");
  afterQuit.controller.shutdown();
  assert.equal(afterQuit.store.load().session, null, "deleting local data can never bring one back");

  const afterDeletion = await fixture(context, f.directory, undefined, undefined, f.clock.now + 6 * 60_000);
  assert.equal(afterDeletion.controller.view().session.status, "idle");
});

test("a paused session comes back paused, and one that ran out while closed is forgotten", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 5 * 60_000;
  f.controller.pauseSession();
  assert.deepEqual(
    [f.store.load().session?.endsAt, f.store.load().session?.pausedRemainingMs],
    [null, 20 * 60_000]
  );

  const later = await fixture(context, f.directory, undefined, undefined, f.clock.now + 60 * 60_000);
  const paused = later.controller.view().session;
  assert.equal(paused.status === "active" ? paused.endsAt : "x", null, "a pause outlives the app");
  assert.equal(
    paused.status === "active" ? focusSessionRemainingMs(paused, later.clock.now) : 0,
    20 * 60_000,
    "an hour of being closed takes nothing from a paused session"
  );
  assert.deepEqual(later.observations, [0], "and a paused session still watches nothing at all");

  later.controller.resumeSession();
  const past = later.clock.now + 20 * 60_000 + 1;
  const expired = await fixture(context, f.directory, undefined, undefined, past);
  assert.equal(expired.controller.view().session.status, "idle");
  assert.equal(expired.store.load().session, null, "a session that ran out while closed is dropped quietly");
  assert.deepEqual(expired.overlay.shown, [], "with no reminder to catch up on");
  assert.deepEqual(expired.timerBar.requests, [], "and nothing drawn anywhere");
});

test("a restored session never trusts evidence from before the restart", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  assert.deepEqual(f.observations, [1]);

  const restarted = await fixture(context, f.directory, undefined, undefined, f.clock.now + 1_000);
  assert.deepEqual(restarted.observations, [1], "a fresh generation is asked for");
  restarted.controller.handleEvidence({
    kind: "browser",
    generation: 0,
    sequence: 9,
    observedAt: restarted.clock.now,
    processIdentifier: 501,
    bundleIdentifier: "com.apple.Safari",
    domain: "video.example"
  });
  assert.deepEqual(restarted.overlay.shown, [], "evidence from the launch before belongs to no session");
  assert.equal(restarted.controller.view().foreground, "waiting");

  evidence(restarted);
  assert.equal(restarted.overlay.shown.length, 1, "fresh evidence after the restart does show a reminder");
});

test("editing a running session moves the timer bar and the saved session together", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.setShowTimerBar(true);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 5 * 60_000;
  f.timers.tick();

  f.controller.editSession({ remainingMinutes: 10 });
  const session = f.controller.view().session;
  assert.equal(session.status === "active" ? focusSessionRemainingMs(session, f.clock.now) : 0, 10 * 60_000);
  const saved = f.store.load().session!;
  assert.equal(saved.totalMs, 15 * 60_000, "the five minutes already spent stay part of the session");
  assert.equal(saved.endsAt, new Date(f.clock.now + 10 * 60_000).toISOString());
  assert.deepEqual(f.timerBar.requests.at(-1)?.session, {
    endsAtEpochSeconds: (f.clock.now + 10 * 60_000) / 1_000,
    pausedRemainingSeconds: null,
    totalSeconds: 900
  }, "so the bar shows a third of the session left, from that same clock");
});

test("the countdown never rewrites the saved session each second", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.setShowTimerBar(true);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  const written = readFileSync(resolve(f.directory, "focus.json"), "utf8");
  for (let second = 0; second < 5; second += 1) {
    f.clock.now += 1_000;
    f.timers.tick();
  }
  assert.equal(readFileSync(resolve(f.directory, "focus.json"), "utf8"), written,
    "only a start, pause, resume, edit or end moves the clock that is saved");
});

test("shutdown hides the bar and detaches its handler", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.controller.shutdown();
  assert.equal(f.bar.hides, 1);
  assert.equal(f.bar.handler, null);
});


test("a transient native bar failure retries on the next session tick", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.bar.result = "no_display";
  f.controller.start({ goalId, intention: "Keep going", durationMinutes: 25 });
  const attempts = f.bar.snapshots.length;
  f.bar.result = "shown";
  f.clock.now += 1_000;
  f.timers.tick();
  assert.equal(f.bar.snapshots.length, attempts + 1);
  f.timers.tick();
  assert.equal(f.bar.snapshots.length, attempts + 1);
});

test("session write failures leave explicit start, pause and stop transitions uncommitted", async (context) => {
  const directory = await testDirectory(context);
  const store = new FailingSessionStore(directory, () => "goal-00000001-test");
  const f = await fixture(context, directory, undefined, undefined, START_OF_TEST_TIME, store);
  const goalId = readyToStart(f);

  store.failSessionWrites = true;
  assert.throws(
    () => f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 25 }),
    /session disk unavailable/
  );
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.store.load().session, null);
  assert.deepEqual(f.observations, [], "a failed start never begins observation");
  assert.deepEqual(f.bar.snapshots, [], "a failed start never appears on a native surface");

  store.failSessionWrites = false;
  f.controller.start({ goalId, intention: "Write the intro", durationMinutes: 25 });
  const running = f.controller.view().session;
  assert.equal(running.status, "active");
  const saved = structuredClone(f.store.load().session);
  const observations = [...f.observations];

  f.clock.now += 60_000;
  store.failSessionWrites = true;
  assert.throws(() => f.controller.pauseSession(), /session disk unavailable/);
  assert.deepEqual(f.controller.view().session, running, "a failed pause leaves the deadline running");
  assert.deepEqual(f.store.load().session, saved);
  assert.deepEqual(f.observations, observations, "a failed pause never stops observation");

  assert.throws(() => f.controller.stop(), /session disk unavailable/);
  assert.deepEqual(f.controller.view().session, running, "a failed stop cannot resurrect on restart");
  assert.deepEqual(f.store.load().session, saved);
});

test("automatic expiry logs and retries when its checkpoint cannot be cleared", async (context) => {
  const directory = await testDirectory(context);
  const store = new FailingSessionStore(directory, () => "goal-00000001-test");
  const f = await fixture(context, directory, undefined, undefined, START_OF_TEST_TIME, store);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 5 });
  f.clock.now += 5 * 60_000;
  store.failSessionWrites = true;

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...arguments_: unknown[]) => { errors.push(arguments_); };
  try {
    assert.doesNotThrow(() => f.timers.tick(), "a timer callback never leaks a storage exception");
  } finally {
    console.error = originalError;
  }
  assert.equal(f.controller.view().session.status, "active", "expiry waits until its clear is durable");
  assert.equal(f.store.load().session?.id, "session-fixed");
  assert.equal(f.timers.callbacks.size, 1, "the next tick can retry the clear");
  assert.equal(errors.some((entry) => String(entry[0]).includes("advance the Focus session")), true);

  store.failSessionWrites = false;
  f.timers.tick();
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.store.load().session, null);
  assert.equal(f.timers.callbacks.size, 0);
});

test("foreground expiry contains a failed checkpoint and retries automatically", async (context) => {
  const directory = await testDirectory(context);
  const store = new FailingSessionStore(directory, () => "goal-00000001-test");
  const f = await fixture(context, directory, undefined, undefined, START_OF_TEST_TIME, store);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 5 });
  f.clock.now += 5 * 60_000;
  store.failSessionWrites = true;

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...arguments_: unknown[]) => { errors.push(arguments_); };
  try {
    assert.doesNotThrow(() => evidence(f), "collector EventEmitter callbacks never leak storage errors");
  } finally {
    console.error = originalError;
  }
  assert.equal(f.controller.view().session.status, "active");
  assert.equal(f.store.load().session?.id, "session-fixed");
  assert.equal(f.timers.callbacks.size, 1);
  assert.equal(errors.some((entry) => String(entry[0]).includes("foreground evidence")), true);

  store.failSessionWrites = false;
  f.timers.tick();
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.store.load().session, null);
});

test("native session actions contain checkpoint failures without changing the clock", async (context) => {
  const directory = await testDirectory(context);
  const store = new FailingSessionStore(directory, () => "goal-00000001-test");
  const f = await fixture(context, directory, undefined, undefined, START_OF_TEST_TIME, store);
  const goalId = readyToStart(f);
  const running = f.controller.start({ goalId, intention: "", durationMinutes: 25 }).session;
  assert.equal(running.status, "active");
  store.failSessionWrites = true;

  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...arguments_: unknown[]) => { errors.push(arguments_); };
  try {
    assert.doesNotThrow(() => f.bar.handler?.(JSON.stringify({
      action: "pause",
      sessionId: "session-fixed"
    })));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(f.controller.view().session, running);
  assert.deepEqual(f.store.load().session, running.status === "active" ? {
    id: running.id,
    goal: running.goal,
    intention: running.intention,
    startedAt: running.startedAt,
    endsAt: running.endsAt,
    totalMs: running.totalMs,
    pausedRemainingMs: running.pausedRemainingMs,
    snoozedUntil: running.snoozedUntil
  } : null);
  assert.equal(errors.some((entry) => String(entry[0]).includes("Focus bar action")), true);
  store.failSessionWrites = false;
});

test("quit tears down every effect even when its final checkpoint cannot be written", async (context) => {
  const directory = await testDirectory(context);
  const store = new FailingSessionStore(directory, () => "goal-00000001-test");
  const filters = new FakeColorFilters({ enabled: true, type: 8 });
  const filter = new SystemColorFilterController({
    binding: filters,
    journalPath: resolve(directory, "color-filter-restore.json")
  });
  const f = await fixture(context, directory, new FakeScreenCapture(), filter, START_OF_TEST_TIME, store);
  f.controller.setExperience("grayscale_system");
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  f.clock.now += 1_000;
  evidence(f);
  assert.deepEqual(filters.settings, GRAY);

  store.failSessionWrites = true;
  store.failEvenUnchanged = true;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.doesNotThrow(() => f.controller.shutdown({ retainSession: true }));
  } finally {
    console.error = originalError;
  }
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.observations.at(-1), 0);
  assert.equal(f.overlay.hidden.length > 0, true);
  assert.deepEqual(filters.settings, { enabled: true, type: 8 });
  assert.equal(f.bar.hides, 1);
  assert.equal(f.timerBar.shutdowns, 1);
});

test("restoring after a wall-clock rollback preserves the saved deadline", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  const started = f.controller.start({ goalId, intention: "", durationMinutes: 25 }).session;
  assert.equal(started.status, "active");
  const deadline = started.status === "active" ? started.endsAt : null;

  const refusingStore = new FailingSessionStore(f.directory, () => "goal-00000002-test");
  refusingStore.failSessionWrites = true;
  const originalCheckpoint = structuredClone(refusingStore.load().session);
  const originalError = console.error;
  console.error = () => undefined;
  const earlier = await fixture(
    context,
    f.directory,
    undefined,
    undefined,
    f.clock.now - 10 * 60_000,
    refusingStore
  );
  console.error = originalError;
  const restored = earlier.controller.view().session;
  assert.equal(restored.status, "active");
  assert.equal(restored.status === "active" ? restored.endsAt : null, deadline);
  assert.equal(restored.status === "active" ? restored.totalMs : 0, 35 * 60_000,
    "the effective total grows so elapsed time never becomes negative");
  assert.deepEqual(refusingStore.load().session, originalCheckpoint,
    "a failed normalization keeps the original valid checkpoint without blocking restore");
  refusingStore.failSessionWrites = false;
});

test("an expired checkpoint that cannot be cleared never blocks startup", async (context) => {
  const directory = await testDirectory(context);
  const seed = new FocusStore(directory, () => "goal-00000001-test");
  const goal = seed.saveGoal({ title: "Finish", why: "", currentFocus: "" }).goal;
  seed.saveSession({
    id: "session-expired",
    goal,
    intention: "",
    startedAt: new Date(START_OF_TEST_TIME - 30 * 60_000).toISOString(),
    endsAt: new Date(START_OF_TEST_TIME - 5 * 60_000).toISOString(),
    totalMs: 25 * 60_000,
    pausedRemainingMs: null,
    snoozedUntil: null
  });
  const refusingStore = new FailingSessionStore(directory, () => "goal-00000002-test");
  refusingStore.failSessionWrites = true;

  const originalError = console.error;
  console.error = () => undefined;
  const f = await fixture(
    context,
    directory,
    undefined,
    undefined,
    START_OF_TEST_TIME,
    refusingStore
  );
  console.error = originalError;

  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(refusingStore.load().session?.id, "session-expired",
    "the still-expired record can be retried on a later launch");
  refusingStore.failSessionWrites = false;
});

test("repeated legal edits can persist a session whose total exceeds one day", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 240 });

  for (let extension = 0; extension < 7; extension += 1) {
    f.clock.now += 239 * 60_000;
    f.controller.editSession({ remainingMinutes: 240 });
  }

  const session = f.controller.view().session;
  assert.equal(session.status, "active");
  assert.equal(session.status === "active" && session.totalMs > 24 * 60 * 60_000, true);
  assert.equal(f.store.load().session?.totalMs, session.status === "active" ? session.totalMs : 0);
});
