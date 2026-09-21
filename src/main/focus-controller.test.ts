import type { FocusViewState } from "@shared/focus";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  FocusController,
  type FocusOverlayBinding,
  type FocusOverlayRequest,
  type FocusOverlayShowResult,
  type FocusScreenCaptureBinding
} from "./focus-controller";
import type { FocusCapability } from "./focus-state";
import { FocusStore } from "./focus-store";

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

interface Fixture {
  controller: FocusController;
  overlay: FakeOverlay;
  timers: ManualTimers;
  observations: number[];
  clock: { now: number };
  capability: Omit<FocusCapability, "overlayAvailable">;
  states: FocusViewState[];
  store: FocusStore;
  directory: string;
  screenCapture: FakeScreenCapture;
}

async function fixture(
  context: TestContext,
  directory?: string,
  screenCapture = new FakeScreenCapture()
): Promise<Fixture> {
  const dataDirectory = directory ?? await testDirectory(context);
  const overlay = new FakeOverlay();
  const timers = new ManualTimers();
  const observations: number[] = [];
  const clock = { now: 1_800_000_000_000 };
  const capability = {
    privacyAccepted: true,
    captureEnabled: true,
    collectorAvailable: true,
    accessibilityTrusted: true,
    captureBrowserURLs: true
  };
  let goalCounter = 0;
  const store = new FocusStore(dataDirectory, () => `goal-0000000${(goalCounter += 1)}-test`);
  const controller = new FocusController({
    store,
    overlay,
    screenCapture,
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
    controller, overlay, timers, observations, clock, capability, states, store, directory: dataDirectory, screenCapture
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

test("expires sessions on the timer and never resumes them after a restart", async (context) => {
  const f = await fixture(context);
  const goalId = readyToStart(f);
  f.controller.start({ goalId, intention: "", durationMinutes: 5 });
  f.clock.now += 5 * 60_000;
  f.timers.tick();
  assert.equal(f.controller.view().session.status, "idle");
  assert.equal(f.observations.at(-1), 0);

  f.controller.start({ goalId, intention: "", durationMinutes: 25 });
  const restarted = await fixture(context, f.directory);
  assert.equal(restarted.controller.view().session.status, "idle");
  assert.equal(restarted.controller.view().goals.length, 1, "goals persist across restarts");
  assert.deepEqual(restarted.observations, []);
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
    experience: "amber"
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
