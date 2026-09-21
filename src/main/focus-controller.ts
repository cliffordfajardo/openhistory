import type {
  FocusEffectFallbackReason,
  FocusExperience,
  FocusScreenCaptureAccess,
  FocusViewState,
  GoalDraft
} from "@shared/focus";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { ForegroundEvidence } from "./foreground-evidence";
import {
  FocusExperienceSchema,
  FocusPreferencesInputSchema,
  FocusStartRequestSchema,
  GoalDraftSchema,
  GoalIdSchema,
  firstIssueMessage
} from "./focus-schemas";
import {
  detectionState,
  effectView,
  foregroundSummary,
  initialFocusState,
  needsTimer,
  reduceFocus,
  reminderCopy,
  sessionView,
  type FocusCapability,
  type FocusEffect,
  type FocusInput,
  type FocusMachineState
} from "./focus-state";
import type { FocusStore } from "./focus-store";

/**
 * `shown_fallback_*`: the card and amber edge are on screen, but grayscale was requested and the
 * native side could not start it (no Screen Recording access, no capture/GPU support, or no
 * exactly matched distracting window on a single display).
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
  domain?: string;
}

export interface FocusOverlayBinding {
  show(request: FocusOverlayRequest): FocusOverlayShowResult;
  hide(nudgeId: string, immediate: boolean): void;
  setActionHandler(handler: ((line: string) => void) | null): void;
}

/** macOS Screen Recording access. `access` never prompts; `request` may show the system prompt once. */
export interface FocusScreenCaptureBinding {
  access(): boolean;
  request(): boolean;
}

export interface FocusControllerOptions {
  store: FocusStore;
  overlay: FocusOverlayBinding | undefined;
  /** Absent when the native bridge can't capture; grayscale then falls back to amber. */
  screenCapture?: FocusScreenCaptureBinding;
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

export class FocusController extends EventEmitter {
  private machine: FocusMachineState;
  private timer: unknown;
  private lastEmittedView = "";
  private readonly now: () => number;
  private readonly idleSeconds: () => number;
  private readonly createSessionId: () => string;
  private readonly createPreviewId: () => string;
  private readonly timers: NonNullable<FocusControllerOptions["timers"]>;
  private shutDown = false;
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
    this.machine = initialFocusState(
      this.currentCapability(),
      options.store.load().preferences.experience,
      this.currentScreenCapture()
    );
    options.overlay?.setActionHandler((line) => this.handleOverlayAction(line));
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
      effect: effectView(this.machine),
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
    const document = this.options.store.savePreferences({
      domains: input.domains,
      durationMinutes: input.durationMinutes,
      experience: input.experience ?? this.options.store.load().preferences.experience
    });
    this.dispatch({ type: "domains_changed", now: this.now(), domains: document.preferences.domains });
    this.applyExperience(document.preferences.experience);
    return this.publish();
  }

  /** Saves the reminder style and applies it to a running session without restarting it. */
  setExperience(value: unknown): FocusViewState {
    const experience = parseOrThrow(FocusExperienceSchema, value, "Choose a reminder style");
    this.options.store.setExperience(experience);
    this.applyExperience(experience);
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
    this.dispatch({ type: "evidence", now: this.now(), evidence });
    this.publish();
  }

  /** The collector restarted or stopped: sequence numbers restart, so forget prior evidence. */
  resetEvidence(): void {
    const session = this.machine.session;
    if (session.status !== "active") return;
    this.machine = { ...this.machine, evidence: undefined };
    this.dispatch({ type: "tick", now: this.now() });
    this.publish();
  }

  refreshCapability(): void {
    this.dispatch({ type: "capability", now: this.now(), capability: this.currentCapability() });
    this.syncScreenCapture();
    this.publish();
  }

  /** Ends any session and removes reminders before quit or data deletion. */
  shutdown(): void {
    if (this.shutDown) return;
    this.dispatch({ type: "stop", now: this.now() });
    if (this.machine.preview) {
      this.options.overlay?.hide(this.machine.preview.id, true);
      this.machine = { ...this.machine, preview: undefined };
    }
    this.shutDown = true;
    this.stopTimer();
    this.options.overlay?.setActionHandler(null);
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

  private dispatch(input: FocusInput): void {
    if (this.shutDown) return;
    const transition = reduceFocus(this.machine, input);
    this.machine = transition.state;
    for (const effect of transition.effects) this.perform(effect);
    this.syncTimer();
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
