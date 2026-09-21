import type { FocusViewState, GoalDraft } from "@shared/focus";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { ForegroundEvidence } from "./foreground-evidence";
import {
  FocusPreferencesSchema,
  FocusStartRequestSchema,
  GoalDraftSchema,
  GoalIdSchema,
  firstIssueMessage
} from "./focus-schemas";
import {
  detectionState,
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

export type FocusOverlayShowResult =
  | "shown"
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
}

export interface FocusOverlayBinding {
  show(request: FocusOverlayRequest): FocusOverlayShowResult;
  hide(nudgeId: string, immediate: boolean): void;
  setActionHandler(handler: ((line: string) => void) | null): void;
}

export interface FocusControllerOptions {
  store: FocusStore;
  overlay: FocusOverlayBinding | undefined;
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
    this.machine = initialFocusState(this.currentCapability());
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
    const document = this.options.store.savePreferences(
      parseOrThrow(FocusPreferencesSchema, value, "Check the site list and duration")
    );
    this.dispatch({ type: "domains_changed", now: this.now(), domains: document.preferences.domains });
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
    if (result !== "shown") {
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
    this.dispatch({ type: "tick", now: this.now(), idleSeconds });
    this.publish();
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
