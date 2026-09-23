import {
  type FocusEffectFallbackReason,
  type FocusExperience,
  type FocusScreenCaptureAccess,
  type FocusViewState,
  type Goal,
  type GoalDraft,
  type PersistedFocusSession
} from "@shared/focus";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { ForegroundEvidence } from "./foreground-evidence";
import {
  FocusBarActionSchema,
  focusBarSnapshot,
  type FocusBarShowResult,
  type FocusBarSnapshot
} from "./focus-bar";
import {
  FocusBarPositionSchema,
  FocusBarPresentationSchema,
  FocusBarWidthSchema,
  FocusExperienceSchema,
  FocusPreferencesInputSchema,
  FocusProgressColorSchema,
  FocusSessionEditSchema,
  FocusStartRequestSchema,
  GoalDraftSchema,
  GoalIdSchema,
  firstIssueMessage
} from "./focus-schemas";
import {
  timerBarRequest,
  type TimerBarRequest,
  type TimerBarResult
} from "./focus-timer-bar";
import {
  detectionState,
  effectView,
  foregroundSummary,
  initialFocusState,
  needsTimer,
  reduceFocus,
  reminderCopy,
  sessionView,
  systemFilterWanted,
  type FocusCapability,
  type FocusEffect,
  type FocusInput,
  type FocusMachineState
} from "./focus-state";
import type { FocusStore } from "./focus-store";
import type { SystemColorFilterController } from "./system-color-filter";

/**
 * `shown_fallback_*`: the card (and the amber edge, if enabled) is on screen, but captured
 * grayscale was requested and the native side could not start it (no Screen Recording access, no
 * capture/GPU support, or no exactly matched distracting window on a single display).
 */
export type FocusOverlayShowResult =
  | "shown"
  | "shown_fallback_permission"
  | "shown_fallback_unavailable"
  | "shown_fallback_window"
  | "shown_fallback_window_spans_displays"
  | "invalid_request"
  | "not_main_thread"
  | "no_display"
  | "foreground_changed"
  | "unavailable";

export interface FocusOverlayRequest {
  nudgeId: string;
  sessionId: string | null;
  title: string;
  message: string;
  expectedProcessIdentifier: number | null;
  preview: boolean;
  experience: FocusExperience;
  amberEdge: boolean;
  domain?: string;
}

export interface FocusOverlayBinding {
  show(request: FocusOverlayRequest): FocusOverlayShowResult;
  hide(nudgeId: string, immediate: boolean): void;
  setActionHandler(handler: ((line: string) => void) | null): void;
}

/** The native floating bar: one compact panel that shows the running session. */
export interface FocusBarBinding {
  update(snapshot: FocusBarSnapshot): FocusBarShowResult;
  hide(): void;
  /** Makes the bar key so its controls can be reached from the keyboard. Only for explicit asks. */
  focus(): void;
  setActionHandler(handler: ((line: string) => void) | null): void;
}

/**
 * The native timer bar: one passive strip per display over the menu region. It draws whatever the
 * last request said and keeps no clock, so it can never disagree with the session.
 */
export interface TimerBarBinding {
  update(request: TimerBarRequest): TimerBarResult;
  /** Removes every panel and observer; used when the preference is off and when Focus shuts down. */
  shutdown(): void;
}

/** macOS Screen Recording access. `access` never prompts; `request` may show the system prompt once. */
export interface FocusScreenCaptureBinding {
  access(): boolean;
  request(): boolean;
}

export interface FocusControllerOptions {
  store: FocusStore;
  overlay: FocusOverlayBinding | undefined;
  /** Absent where the native bridge predates the floating bar; the menu bar then carries it. */
  bar?: FocusBarBinding;
  /** Absent where the native bridge predates the timer bar; the preference is then unavailable. */
  timerBar?: TimerBarBinding;
  /** Absent when the native bridge can't capture; grayscale then falls back to amber. */
  screenCapture?: FocusScreenCaptureBinding;
  /** Owns system grayscale; absent where the native bridge lacks it. */
  systemFilter?: SystemColorFilterController;
  setForegroundObservation: (generation: number) => void;
  capability: () => Omit<FocusCapability, "overlayAvailable">;
  now?: () => number;
  idleSeconds?: () => number;
  createSessionId?: () => string;
  createPreviewId?: () => string;
  timers?: {
    setInterval: (callback: () => void, milliseconds: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

const TICK_INTERVAL_MS = 1_000;
const OverlayActionSchema = z.object({
  action: z.enum(["snooze", "dismiss", "hidden"]),
  nudgeId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100).optional(),
  preview: z.boolean(),
  reason: z.string().max(100).optional()
}).strict();
const EffectStatusSchema = z.object({
  event: z.literal("effect"),
  status: z.enum(["active", "fallback"]),
  nudgeId: z.string().min(1).max(100),
  preview: z.boolean(),
  reason: z.enum([
    "permission_needed",
    "unsupported",
    "capture_failed",
    "no_frame",
    "display_unavailable",
    "window_unavailable",
    "window_spans_displays"
  ]).optional()
}).strict();
const SHOW_FALLBACK_REASONS: Partial<Record<FocusOverlayShowResult, FocusEffectFallbackReason>> = {
  shown_fallback_permission: "permission_needed",
  shown_fallback_unavailable: "unsupported",
  shown_fallback_window: "window_unavailable",
  shown_fallback_window_spans_displays: "window_spans_displays"
};

/** How Focus is being torn down. Only a quit keeps the saved session for the next launch. */
export interface FocusShutdownOptions {
  /**
   * Keep the saved session record so the next launch resumes it. Deleting local data must never
   * set this: a deleted session cannot come back.
   */
  retainSession?: boolean;
}

export class FocusController extends EventEmitter {
  private machine: FocusMachineState;
  private timer: unknown;
  private lastEmittedView = "";
  private lastBarSnapshot = "";
  private lastTimerBarRequest = "";
  private readonly now: () => number;
  private readonly idleSeconds: () => number;
  private readonly createSessionId: () => string;
  private readonly createPreviewId: () => string;
  private readonly timers: NonNullable<FocusControllerOptions["timers"]>;
  private shutDown = false;
  private systemFilterOn = false;
  private screenCaptureRequested = false;

  constructor(private readonly options: FocusControllerOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.idleSeconds = options.idleSeconds ?? (() => 0);
    this.createSessionId = options.createSessionId ?? (() => `session-${randomUUID()}`);
    this.createPreviewId = options.createPreviewId ?? (() => `preview-${randomUUID()}`);
    this.timers = options.timers ?? {
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
    };
    const document = options.store.load();
    this.machine = initialFocusState(
      this.currentCapability(),
      document.preferences.experience,
      this.currentScreenCapture(),
      document.preferences.amberEdge,
      Boolean(options.systemFilter?.available)
    );
    options.overlay?.setActionHandler((line) => this.runAutomaticAction(
      "Unable to handle the Focus reminder action",
      () => this.handleOverlayAction(line)
    ));
    options.bar?.setActionHandler((line) => this.runAutomaticAction(
      "Unable to handle the Focus bar action",
      () => this.handleBarAction(line)
    ));
    this.restoreSavedSession(document.session);
  }

  private restoreSavedSession(saved: PersistedFocusSession | null): void {
    if (!saved) return;
    const now = this.now();
    const remainingMs = saved.endsAt === null
      ? Math.max(0, saved.pausedRemainingMs ?? 0)
      : Math.max(0, Date.parse(saved.endsAt) - now);
    if (remainingMs <= 0) {
      this.tryWriteSessionRecord(null, "Unable to clear the expired Focus session");
      return;
    }
    this.dispatch({
      type: "restore",
      now,
      sessionId: saved.id,
      goal: saved.goal,
      intention: saved.intention,
      domains: this.options.store.load().preferences.domains,
      startedAt: Date.parse(saved.startedAt),
      totalMs: saved.totalMs,
      remainingMs,
      paused: saved.endsAt === null,
      snoozedUntil: saved.snoozedUntil === null ? null : Date.parse(saved.snoozedUntil)
    }, "bestEffort");
    this.publish();
  }

  view(): FocusViewState {
    const document = this.options.store.load();
    const now = this.now();
    return {
      goals: document.goals,
      selectedGoalId: document.selectedGoalId,
      preferences: document.preferences,
      session: sessionView(this.machine),
      detection: detectionState(this.machine.capability),
      foreground: foregroundSummary(this.machine, now),
      reminderVisible: Boolean(this.machine.nudge),
      lastReminderAt: this.machine.lastNudgeAt === undefined
        ? null
        : new Date(this.machine.lastNudgeAt).toISOString(),
      screenCapture: { access: this.machine.screenCapture, requested: this.screenCaptureRequested },
      systemFilter: this.options.systemFilter?.view() ??
        { available: false, phase: "unsupported", failure: null, restorePending: false },
      effect: effectView(this.machine),
      barPosition: document.barPosition,
      barAvailable: Boolean(this.options.bar),
      timerBarAvailable: Boolean(this.options.timerBar),
      recoveredFromInvalidFile: this.options.store.recoveredFromInvalidFile
    };
  }

  saveGoal(value: unknown): FocusViewState {
    const draft = parseOrThrow(GoalDraftSchema, value, "Check the goal details and try again") as GoalDraft;
    this.options.store.saveGoal(draft);
    return this.publish();
  }

  deleteGoal(value: unknown): FocusViewState {
    this.options.store.deleteGoal(parseOrThrow(GoalIdSchema, value, "Invalid goal"));
    return this.publish();
  }

  selectGoal(value: unknown): FocusViewState {
    const id = value === null ? null : parseOrThrow(GoalIdSchema, value, "Invalid goal");
    this.options.store.selectGoal(id);
    return this.publish();
  }

  savePreferences(value: unknown): FocusViewState {
    const input = parseOrThrow(FocusPreferencesInputSchema, value, "Check the site list and duration");
    const saved = this.options.store.load().preferences;
    const experience = input.experience ?? saved.experience;
    if (experience !== saved.experience) this.assertExperienceAvailable(experience);
    const document = this.options.store.savePreferences({
      ...saved,
      domains: input.domains,
      durationMinutes: input.durationMinutes,
      experience
    });
    this.dispatch({ type: "domains_changed", now: this.now(), domains: document.preferences.domains });
    this.applyExperience(document.preferences.experience);
    return this.publish();
  }

  /** Saves the grayscale choice and applies it to a running session without restarting it. */
  setExperience(value: unknown): FocusViewState {
    const experience = parseOrThrow(FocusExperienceSchema, value, "Choose a reminder style");
    this.assertExperienceAvailable(experience);
    this.options.store.setExperience(experience);
    this.applyExperience(experience);
    return this.publish();
  }

  /** Saves the amber edge and applies it to a visible reminder without restarting the session. */
  setAmberEdge(value: unknown): FocusViewState {
    const amberEdge = parseOrThrow(z.boolean(), value, "Choose whether to show the amber edge");
    this.options.store.updatePreferences({ amberEdge });
    this.dispatch({ type: "amber_edge_changed", now: this.now(), amberEdge });
    return this.publish();
  }

  /**
   * Puts back the Color Filters settings saved before system grayscale, including ones left by an
   * earlier launch, and keeps a visible reminder from turning it on again.
   */
  restoreSystemColors(): FocusViewState {
    const filter = this.options.systemFilter;
    if (!filter) throw new Error("System grayscale isn’t available in this build");
    const effect = this.machine.effect;
    if (effect?.visible && effect.requested === "grayscale_system" && effect.status !== "fallback") {
      this.dispatch({
        type: "effect_status",
        now: this.now(),
        nudgeId: effect.nudgeId,
        status: "fallback",
        reason: "system_filter_restored"
      });
    }
    filter.restore();
    return this.publish();
  }

  /** Re-reads Screen Recording access without prompting. */
  refreshScreenCapture(): FocusViewState {
    this.syncScreenCapture();
    return this.publish();
  }

  /**
   * Asks macOS for Screen Recording access. Only an explicit click reaches this, and the system
   * prompt is requested at most once per launch; afterwards the page offers System Settings.
   */
  requestScreenCapture(): FocusViewState {
    const binding = this.options.screenCapture;
    if (!binding) throw new Error("Screen capture isn't available in this build");
    this.syncScreenCapture();
    if (this.machine.screenCapture !== "granted" && !this.screenCaptureRequested) {
      this.screenCaptureRequested = true;
      try {
        binding.request();
      } catch (error) {
        console.error("Unable to request Screen Recording access", {
          name: error instanceof Error ? error.name : "UnknownError"
        });
      }
      this.syncScreenCapture();
    }
    return this.publish();
  }

  start(value: unknown): FocusViewState {
    if (this.shutDown) throw new Error("Focus is shutting down");
    const request = parseOrThrow(FocusStartRequestSchema, value, "Check the session details");
    const goal = this.options.store.goal(request.goalId);
    if (!goal) throw new Error("Choose an existing goal before starting");
    const document = this.options.store.load();
    if (document.preferences.domains.length === 0) {
      throw new Error("Add at least one distracting site before starting");
    }
    this.options.store.savePreferences({
      ...document.preferences,
      durationMinutes: request.durationMinutes
    });
    if (document.selectedGoalId !== goal.id) this.options.store.selectGoal(goal.id);
    this.dispatch({
      type: "start",
      now: this.now(),
      sessionId: this.createSessionId(),
      goal,
      intention: request.intention,
      domains: document.preferences.domains,
      durationMinutes: request.durationMinutes
    });
    return this.publish();
  }

  stop(): FocusViewState {
    this.dispatch({ type: "stop", now: this.now() });
    return this.publish();
  }

  /** Freezes the countdown and stops reminders until the session is resumed. */
  pauseSession(): FocusViewState {
    this.dispatch({ type: "pause_session", now: this.now() });
    return this.publish();
  }

  /** Starts the countdown again from where it stopped, keeping the same session. */
  resumeSession(): FocusViewState {
    this.dispatch({ type: "resume_session", now: this.now() });
    return this.publish();
  }

  /**
   * Changes the goal, intention or remaining minutes of the running session. The session keeps
   * its identity, elapsed progress and snooze; the goal itself is only selected, never rewritten.
   */
  editSession(value: unknown): FocusViewState {
    const edit = parseOrThrow(FocusSessionEditSchema, value, "Check the session changes");
    if (this.machine.session.status !== "active") throw new Error("No focus session is running");
    let goal: Goal | undefined;
    if (edit.goalId !== undefined) {
      goal = this.options.store.goal(edit.goalId);
      if (!goal) throw new Error("Choose an existing goal");
      if (this.options.store.load().selectedGoalId !== goal.id) this.options.store.selectGoal(goal.id);
    }
    this.dispatch({
      type: "edit_session",
      now: this.now(),
      ...(goal ? { goal } : {}),
      ...(edit.intention !== undefined ? { intention: edit.intention } : {}),
      ...(edit.remainingMinutes !== undefined ? { remainingMinutes: edit.remainingMinutes } : {})
    });
    return this.publish();
  }

  /** Saves where the session is shown. Switching back to floating keeps the session and position. */
  setBarPresentation(value: unknown): FocusViewState {
    const presentation = parseOrThrow(
      FocusBarPresentationSchema,
      value,
      "Choose where to show the running session"
    );
    this.options.store.updatePreferences({ barPresentation: presentation });
    return this.publish();
  }

  /**
   * Saves whether the timer bar is shown. It is independent of where the session is shown, so it
   * can be on with the floating bar, with the menu bar alone, or with both.
   */
  setShowTimerBar(value: unknown): FocusViewState {
    const showTimerBar = parseOrThrow(z.boolean(), value, "Choose whether to show the timer bar");
    if (showTimerBar && !this.options.timerBar) {
      throw new Error("The timer bar isn’t available in this build");
    }
    this.options.store.updatePreferences({ showTimerBar });
    return this.publish();
  }

  /**
   * Saves the one color both progress fills use and sends it to whichever bars are on screen. The
   * session is untouched: no clock moves, so changing the color mid-session costs no time.
   */
  setProgressColor(value: unknown): FocusViewState {
    const progressColor = parseOrThrow(
      FocusProgressColorSchema,
      value,
      "Choose a color written as #rrggbb"
    );
    this.options.store.updatePreferences({ progressColor });
    return this.publish();
  }

  /** Makes the floating bar key so its controls can be used from the keyboard. */
  focusBar(): FocusViewState {
    if (!this.options.bar) throw new Error("The floating bar isn't available in this build");
    if (this.machine.session.status !== "active") throw new Error("No focus session is running");
    if (this.options.store.load().preferences.barPresentation !== "floating") {
      this.options.store.updatePreferences({ barPresentation: "floating" });
    }
    const view = this.publish();
    try {
      this.options.bar.focus();
    } catch (error) {
      console.error("Unable to focus the Focus bar", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
    return view;
  }

  snooze(): FocusViewState {
    this.dispatch({ type: "snooze", now: this.now() });
    return this.publish();
  }

  resume(): FocusViewState {
    this.dispatch({ type: "resume", now: this.now() });
    return this.publish();
  }

  /** Shows the same native reminder through the same path, clearly labeled as a preview. */
  preview(): FocusViewState {
    if (!this.options.overlay) throw new Error("The native reminder isn't available in this build");
    if (this.machine.nudge) throw new Error("A reminder is already showing");
    const document = this.options.store.load();
    const session = this.machine.session;
    const goal = session.status === "active"
      ? session.goal
      : document.goals.find((candidate) => candidate.id === document.selectedGoalId);
    const intention = session.status === "active" ? session.intention : goal?.currentFocus ?? "";
    this.syncScreenCapture();
    this.dispatch({
      type: "preview",
      now: this.now(),
      previewId: this.createPreviewId(),
      copy: reminderCopy(goal, intention)
    });
    if (!this.machine.preview) {
      throw new Error("The reminder could not be shown on this display. Try again on the active desktop.");
    }
    return this.publish();
  }

  handleEvidence(evidence: ForegroundEvidence): void {
    this.runAutomaticAction("Unable to process Focus foreground evidence", () => {
      this.dispatch({ type: "evidence", now: this.now(), evidence });
      this.publish();
    });
  }

  /** The collector restarted or stopped: sequence numbers restart, so forget prior evidence. */
  resetEvidence(): void {
    this.runAutomaticAction("Unable to reset Focus foreground evidence", () => {
      const session = this.machine.session;
      if (session.status !== "active") return;
      this.machine = { ...this.machine, evidence: undefined };
      this.dispatch({ type: "tick", now: this.now() });
      this.publish();
    });
  }

  refreshCapability(): void {
    this.runAutomaticAction("Unable to refresh Focus capability", () => {
      this.dispatch({ type: "capability", now: this.now(), capability: this.currentCapability() });
      this.syncScreenCapture();
      this.publish();
    });
  }

  /**
   * The Mac woke, or something else moved the clock: re-evaluates the session now rather than
   * waiting up to a second, so one that ran out while the Mac slept ends immediately.
   */
  wake(): void {
    if (this.shutDown) return;
    this.tick();
  }

  /**
   * Ends any session and removes reminders before quit or data deletion; ending a system
   * grayscale reminder restores the earlier Color Filters settings synchronously. The session
   * always ends in memory and every native panel goes away; `retainSession` only decides whether
   * the saved record survives for the next launch, so deleting local data can never bring one back.
   */
  shutdown(options: FocusShutdownOptions = {}): void {
    if (this.shutDown) return;
    const retained = options.retainSession === true ? this.sessionRecord() : null;
    this.tryWriteSessionRecord(retained, "Unable to save the Focus session during shutdown");
    this.dispatch({ type: "stop", now: this.now() }, "skip");
    if (this.machine.preview) {
      this.options.overlay?.hide(this.machine.preview.id, true);
      this.machine = { ...this.machine, preview: undefined };
    }
    this.shutDown = true;
    this.stopTimer();
    this.options.overlay?.setActionHandler(null);
    this.hideBar();
    this.options.bar?.setActionHandler(null);
    this.hideTimerBar();
  }

  private handleBarAction(line: string): void {
    if (this.shutDown) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = FocusBarActionSchema.safeParse(value);
    if (!parsed.success) return;
    const session = this.machine.session;
    if (session.status !== "active" || session.id !== parsed.data.sessionId) return;
    switch (parsed.data.action) {
      case "pause":
        if (session.runningSince !== null) this.pauseSession();
        break;
      case "resume":
        if (session.runningSince === null) this.resumeSession();
        break;
      case "complete":
        this.stop();
        break;
      case "edit":
        this.emit("editRequested");
        break;
      case "move_to_menu_bar":
        this.setBarPresentation("menuBar");
        break;
      case "moved": {
        const { x, y } = parsed.data;
        if (x === undefined || y === undefined) return;
        const position = FocusBarPositionSchema.safeParse({ x, y });
        if (!position.success) return;
        this.options.store.saveBarGeometry({ position: position.data });
        this.publish();
        break;
      }
      case "resized": {
        const { x, y, width } = parsed.data;
        if (x === undefined || y === undefined || width === undefined) return;
        const position = FocusBarPositionSchema.safeParse({ x, y });
        const parsedWidth = FocusBarWidthSchema.safeParse(width);
        if (!position.success || !parsedWidth.success) return;
        this.options.store.saveBarGeometry({ position: position.data, width: parsedWidth.data });
        this.publish();
        break;
      }
    }
  }

  private syncBar(): void {
    const bar = this.options.bar;
    if (!bar) return;
    const session = sessionView(this.machine);
    const document = this.options.store.load();
    if (this.shutDown || session.status !== "active" || document.preferences.barPresentation !== "floating") {
      this.hideBar();
      return;
    }
    const snapshot = focusBarSnapshot(
      session,
      this.now(),
      { position: document.barPosition, width: document.barWidth },
      document.preferences.progressColor
    );
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastBarSnapshot) return;
    try {
      if (bar.update(snapshot) === "shown") this.lastBarSnapshot = serialized;
    } catch (error) {
      console.error("Unable to show the Focus bar", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private syncTimerBar(): void {
    const timerBar = this.options.timerBar;
    if (!timerBar) return;
    const preferences = this.options.store.load().preferences;
    const enabled = !this.shutDown && preferences.showTimerBar;
    const request = timerBarRequest(
      sessionView(this.machine),
      this.now(),
      enabled,
      preferences.progressColor
    );
    const serialized = JSON.stringify(request);
    if (request.session === null && serialized === this.lastTimerBarRequest) return;
    try {
      this.lastTimerBarRequest = timerBar.update(request) === "applied" ? serialized : "";
    } catch (error) {
      this.lastTimerBarRequest = "";
      console.error("Unable to update the Focus timer bar", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private hideTimerBar(): void {
    const timerBar = this.options.timerBar;
    if (!timerBar) return;
    this.lastTimerBarRequest = "";
    try {
      timerBar.shutdown();
    } catch (error) {
      console.error("Unable to remove the Focus timer bar", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private sessionRecord(state: FocusMachineState = this.machine): PersistedFocusSession | null {
    const session = sessionView(state);
    if (session.status !== "active") return null;
    return {
      id: session.id,
      goal: session.goal,
      intention: session.intention,
      startedAt: session.startedAt,
      endsAt: session.endsAt,
      totalMs: Math.round(session.totalMs),
      pausedRemainingMs: session.pausedRemainingMs === null
        ? null
        : Math.max(0, Math.round(session.pausedRemainingMs)),
      snoozedUntil: session.snoozedUntil
    };
  }

  private tryWriteSessionRecord(record: PersistedFocusSession | null, message: string): void {
    try {
      this.options.store.saveSession(record);
    } catch (error) {
      console.error(message, {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  /** EventEmitter and native callbacks have no caller that can receive a persistence exception. */
  private runAutomaticAction(message: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      console.error(message, {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private hideBar(): void {
    if (!this.options.bar || this.lastBarSnapshot === "") return;
    this.lastBarSnapshot = "";
    try {
      this.options.bar.hide();
    } catch (error) {
      console.error("Unable to hide the Focus bar", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private handleOverlayAction(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const status = EffectStatusSchema.safeParse(value);
    if (status.success) {
      this.dispatch({
        type: "effect_status",
        now: this.now(),
        nudgeId: status.data.nudgeId,
        status: status.data.status,
        ...(status.data.reason ? { reason: status.data.reason } : {})
      });
      if (status.data.reason === "permission_needed") this.syncScreenCapture();
      this.publish();
      return;
    }
    const parsed = OverlayActionSchema.safeParse(value);
    if (!parsed.success) return;
    this.dispatch({
      type: "overlay_action",
      now: this.now(),
      action: parsed.data.action,
      nudgeId: parsed.data.nudgeId,
      ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      preview: parsed.data.preview
    });
    this.publish();
  }

  private dispatch(
    input: FocusInput,
    persistence: "required" | "bestEffort" | "skip" = "required"
  ): void {
    if (this.shutDown) return;
    const transition = reduceFocus(this.machine, input);
    const record = this.sessionRecord(transition.state);
    if (persistence === "required") {
      this.options.store.saveSession(record);
    } else if (persistence === "bestEffort") {
      this.tryWriteSessionRecord(record, "Unable to normalize the restored Focus session");
    }
    this.machine = transition.state;
    for (const effect of transition.effects) this.perform(effect);
    this.syncTimer();
    this.syncSystemFilter();
  }

  private syncSystemFilter(): void {
    const filter = this.options.systemFilter;
    if (!filter || this.shutDown) return;
    const wanted = systemFilterWanted(this.machine);
    if (wanted) {
      this.systemFilterOn = filter.apply();
    } else if (this.systemFilterOn) {
      filter.restore();
      this.systemFilterOn = false;
    }
    const effect = this.machine.effect;
    if (!wanted || !effect) return;
    if (!this.systemFilterOn) {
      this.dispatch({
        type: "effect_status",
        now: this.now(),
        nudgeId: effect.nudgeId,
        status: "fallback",
        reason: "system_filter_failed"
      });
    } else if (effect.status === "preparing") {
      this.dispatch({ type: "effect_status", now: this.now(), nudgeId: effect.nudgeId, status: "active" });
    }
  }

  private assertExperienceAvailable(experience: FocusExperience): void {
    if (experience === "grayscale_system" && !this.options.systemFilter?.available) {
      throw new Error("System grayscale isn’t available on this Mac");
    }
  }

  private perform(effect: FocusEffect): void {
    if (effect.type === "observe") {
      try {
        this.options.setForegroundObservation(effect.generation);
      } catch (error) {
        console.error("Unable to change Focus observation", {
          name: error instanceof Error ? error.name : "UnknownError"
        });
      }
      return;
    }
    if (effect.type === "hide") {
      try {
        this.options.overlay?.hide(effect.nudgeId, effect.immediate);
      } catch (error) {
        console.error("Unable to hide the Focus reminder", {
          name: error instanceof Error ? error.name : "UnknownError"
        });
      }
      return;
    }
    let result: FocusOverlayShowResult = "unavailable";
    try {
      result = this.options.overlay?.show(effect.request) ?? "unavailable";
    } catch (error) {
      console.error("Unable to show the Focus reminder", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
    const fallbackReason = SHOW_FALLBACK_REASONS[result];
    if (fallbackReason) {
      this.dispatch({
        type: "effect_status",
        now: this.now(),
        nudgeId: effect.request.nudgeId,
        status: "fallback",
        reason: fallbackReason
      });
      if (fallbackReason === "permission_needed") this.syncScreenCapture();
    } else if (result !== "shown") {
      this.dispatch({ type: "overlay_rejected", now: this.now(), nudgeId: effect.request.nudgeId });
    }
  }

  private tick(): void {
    try {
      let idleSeconds = 0;
      try {
        idleSeconds = this.idleSeconds();
      } catch {
        idleSeconds = 0;
      }
      this.dispatch({ type: "capability", now: this.now(), capability: this.currentCapability() });
      this.syncScreenCapture();
      this.dispatch({ type: "tick", now: this.now(), idleSeconds });
      this.publish();
    } catch (error) {
      // Interval callbacks have no caller to receive a storage error. Keep the old state and timer
      // alive so the next heartbeat retries the same durable transition.
      console.error("Unable to advance the Focus session", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private applyExperience(experience: FocusExperience): void {
    if (experience === this.machine.experience) return;
    this.syncScreenCapture();
    this.dispatch({ type: "experience_changed", now: this.now(), experience });
  }

  private syncScreenCapture(): void {
    const access = this.currentScreenCapture();
    if (access !== this.machine.screenCapture) this.dispatch({ type: "screen_capture", now: this.now(), access });
  }

  private currentScreenCapture(): FocusScreenCaptureAccess {
    const binding = this.options.screenCapture;
    if (!binding) return "unsupported";
    try {
      return binding.access() ? "granted" : "not_granted";
    } catch {
      return "unsupported";
    }
  }

  private syncTimer(): void {
    if (needsTimer(this.machine) && !this.shutDown) {
      this.timer ??= this.timers.setInterval(() => this.tick(), TICK_INTERVAL_MS);
    } else {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }

  private currentCapability(): FocusCapability {
    return { ...this.options.capability(), overlayAvailable: Boolean(this.options.overlay) };
  }

  private publish(): FocusViewState {
    this.syncBar();
    this.syncTimerBar();
    const view = this.view();
    const serialized = JSON.stringify(view);
    if (serialized !== this.lastEmittedView) {
      this.lastEmittedView = serialized;
      this.emit("state", view);
    }
    return view;
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(firstIssueMessage(parsed.error, fallback));
  return parsed.data;
}
