import {
  FOCUS_TIMING,
  matchingFocusDomain,
  type FocusDetectionState,
  type FocusEffectFallbackReason,
  type FocusEffectState,
  type FocusExperience,
  type FocusForegroundSummary,
  type FocusScreenCaptureAccess,
  type FocusSession,
  type Goal
} from "@shared/focus";
import type { ForegroundEvidence } from "./foreground-evidence";


const REJECTED_REMINDER_RETRY_MS = 5_000;

export interface FocusCapability {
  privacyAccepted: boolean;
  captureEnabled: boolean;
  collectorAvailable: boolean;
  accessibilityTrusted: boolean;
  captureBrowserURLs: boolean;
  overlayAvailable: boolean;
}

type ActiveSession = {
  status: "active";
  id: string;
  goal: Goal;
  intention: string;
  domains: string[];
  startedAt: number;
  endsAt: number;
  snoozedUntil: number | null;
  generation: number;
};

export interface VisibleNudge {
  id: string;
  sessionId: string;
  processIdentifier: number;
  domain: string;
  shownAt: number;
}

/** Effect of the reminder or preview named by `nudgeId`; kept after it hides for the Focus page. */
export interface ReminderEffect {
  nudgeId: string;
  requested: FocusExperience;
  status: FocusEffectState["status"];
  fallbackReason: FocusEffectFallbackReason | null;
  preview: boolean;
  visible: boolean;
  updatedAt: number;
}

export interface FocusMachineState {
  session: { status: "idle" } | ActiveSession;
  capability: FocusCapability;
  experience: FocusExperience;
  screenCapture: FocusScreenCaptureAccess;
  effect?: ReminderEffect;
  /** Set only within the transition that replaced a visible reminder for a new style. */
  restyling?: boolean;
  evidence?: ForegroundEvidence;
  nudge?: VisibleNudge;
  /** Most recent reminder shown in this session; late native actions may still refer to it. */
  lastNudgeId?: string;
  preview?: { id: string; hideAt: number };
  lastNudgeAt?: number;
  dismissedUntil?: number;
  /** Aggregate system idle time from the last tick; reminders wait while the person is away. */
  idleSeconds: number;
  nudgeCounter: number;
  generationCounter: number;
}

export type FocusInput =
  | {
    type: "start";
    now: number;
    sessionId: string;
    goal: Goal;
    intention: string;
    domains: string[];
    durationMinutes: number;
  }
  | { type: "stop"; now: number }
  | { type: "domains_changed"; now: number; domains: string[] }
  | { type: "snooze"; now: number }
  | { type: "resume"; now: number }
  | { type: "evidence"; now: number; evidence: ForegroundEvidence }
  | { type: "tick"; now: number; idleSeconds?: number }
  | { type: "capability"; now: number; capability: FocusCapability }
  | { type: "preview"; now: number; previewId: string; copy: { title: string; message: string } }
  | {
    type: "overlay_action";
    now: number;
    action: "snooze" | "dismiss" | "hidden";
    nudgeId: string;
    sessionId?: string;
    preview: boolean;
  }
  | { type: "overlay_rejected"; now: number; nudgeId: string }
  | { type: "experience_changed"; now: number; experience: FocusExperience }
  | { type: "screen_capture"; now: number; access: FocusScreenCaptureAccess }
  | {
    type: "effect_status";
    now: number;
    nudgeId: string;
    status: "active" | "fallback";
    reason?: FocusEffectFallbackReason;
  };

export type FocusEffect =
  | { type: "observe"; generation: number }
  | {
    type: "show";
    request: {
      nudgeId: string;
      sessionId: string | null;
      title: string;
      message: string;
      expectedProcessIdentifier: number | null;
      preview: boolean;
      experience: FocusExperience;
    };
  }
  | { type: "hide"; nudgeId: string; immediate: boolean };

export interface FocusTransition {
  state: FocusMachineState;
  effects: FocusEffect[];
}

export function initialFocusState(
  capability: FocusCapability,
  experience: FocusExperience = "amber",
  screenCapture: FocusScreenCaptureAccess = "unsupported"
): FocusMachineState {
  return {
    session: { status: "idle" },
    capability,
    experience,
    screenCapture,
    idleSeconds: 0,
    nudgeCounter: 0,
    generationCounter: 0
  };
}

export function capabilityReady(capability: FocusCapability): boolean {
  return detectionState(capability) === "ready";
}

export function detectionState(capability: FocusCapability): FocusDetectionState {
  if (!capability.privacyAccepted) return "needs_privacy_notice";
  if (!capability.captureEnabled) return "capture_paused";
  if (!capability.collectorAvailable) return "collector_unavailable";
  if (!capability.accessibilityTrusted) return "needs_accessibility";
  if (!capability.captureBrowserURLs) return "url_capture_off";
  if (!capability.overlayAvailable) return "overlay_unavailable";
  return "ready";
}

export function reduceFocus(previous: FocusMachineState, input: FocusInput): FocusTransition {
  const state: FocusMachineState = { ...previous };
  const effects: FocusEffect[] = [];
  const { now } = input;

  switch (input.type) {
    case "start": {
      if (state.nudge) effects.push(hideNudge(state, true));
      if (state.preview) effects.push(hidePreview(state, true));
      state.generationCounter += 1;
      state.session = {
        status: "active",
        id: input.sessionId,
        goal: structuredClone(input.goal),
        intention: input.intention,
        domains: [...input.domains],
        startedAt: now,
        endsAt: now + input.durationMinutes * 60_000,
        snoozedUntil: null,
        generation: state.generationCounter
      };
      state.evidence = undefined;
      state.lastNudgeId = undefined;
      state.lastNudgeAt = undefined;
      state.dismissedUntil = undefined;
      effects.push({ type: "observe", generation: state.generationCounter });
      break;
    }
    case "domains_changed":
      if (state.session.status === "active") {
        state.session = { ...state.session, domains: [...input.domains] };
      }
      break;
    case "stop":
      if (state.session.status === "active") endSession(state, effects);
      break;
    case "snooze":
      if (state.session.status === "active") {
        state.session = { ...state.session, snoozedUntil: now + FOCUS_TIMING.snoozeMs };
        if (state.nudge) effects.push(hideNudge(state, false));
      }
      break;
    case "resume":
      if (state.session.status === "active") {
        state.session = { ...state.session, snoozedUntil: null };
        state.dismissedUntil = undefined;
      }
      break;
    case "evidence":
      acceptEvidence(state, input.evidence, effects);
      break;
    case "capability":
      state.capability = input.capability;
      if (!capabilityReady(input.capability)) {
        state.evidence = undefined;
        if (state.nudge) effects.push(hideNudge(state, true));
      }
      break;
    case "preview":
      if (state.nudge) break;
      if (state.preview) effects.push(hidePreview(state, true));
      state.preview = { id: input.previewId, hideAt: now + FOCUS_TIMING.previewDurationMs };
      effects.push({
        type: "show",
        request: {
          nudgeId: input.previewId,
          sessionId: null,
          title: input.copy.title,
          message: input.copy.message,
          expectedProcessIdentifier: null,
          preview: true,
          experience: beginEffect(state, input.previewId, true, now)
        }
      });
      break;
    case "overlay_action":
      applyOverlayAction(state, input);
      break;
    case "overlay_rejected":
      if (state.nudge?.id === input.nudgeId) {
        state.nudge = undefined;
        state.lastNudgeAt = now - FOCUS_TIMING.globalCooldownMs + REJECTED_REMINDER_RETRY_MS;
      }
      if (state.preview?.id === input.nudgeId) state.preview = undefined;
      break;
    case "experience_changed":
      if (state.experience === input.experience) break;
      state.experience = input.experience;
      if (state.preview) effects.push(hidePreview(state, true));
      if (state.nudge) {
        effects.push(hideNudge(state, true));
        state.restyling = true;
      }
      break;
    case "screen_capture":
      state.screenCapture = input.access;
      break;
    case "effect_status":
      applyEffectStatus(state, input);
      break;
    case "tick":
      if (input.idleSeconds !== undefined && Number.isFinite(input.idleSeconds)) {
        state.idleSeconds = Math.max(0, input.idleSeconds);
      }
      break;
  }

  evaluate(state, now, effects);
  delete state.restyling;
  const effect = state.effect;
  if (effect?.visible && effect.nudgeId !== state.nudge?.id && effect.nudgeId !== state.preview?.id) {
    state.effect = { ...effect, visible: false, updatedAt: now };
  }
  return { state, effects };
}

function beginEffect(state: FocusMachineState, nudgeId: string, preview: boolean, now: number): FocusExperience {
  const base = { nudgeId, requested: state.experience, preview, visible: true, updatedAt: now };
  if (state.experience === "amber") {
    state.effect = { ...base, status: "showing", fallbackReason: null };
    return "amber";
  }
  if (state.screenCapture !== "granted") {
    state.effect = {
      ...base,
      status: "fallback",
      fallbackReason: state.screenCapture === "unsupported" ? "unsupported" : "permission_needed"
    };
    return "amber";
  }
  state.effect = { ...base, status: "preparing", fallbackReason: null };
  return "grayscale_screen";
}

function applyEffectStatus(
  state: FocusMachineState,
  input: Extract<FocusInput, { type: "effect_status" }>
): void {
  const effect = state.effect;
  if (!effect?.visible || effect.nudgeId !== input.nudgeId || effect.requested !== "grayscale_screen") return;
  if (input.status === "active" && effect.status === "preparing") {
    state.effect = { ...effect, status: "showing", updatedAt: input.now };
  } else if (input.status === "fallback" && effect.status !== "fallback") {
    state.effect = {
      ...effect,
      status: "fallback",
      fallbackReason: input.reason ?? "capture_failed",
      updatedAt: input.now
    };
  }
}

function acceptEvidence(
  state: FocusMachineState,
  evidence: ForegroundEvidence,
  effects: FocusEffect[]
): void {
  if (state.session.status !== "active") return;
  if (evidence.generation !== state.session.generation) return;
  if (state.evidence && evidence.sequence <= state.evidence.sequence &&
      evidence.generation === state.evidence.generation) return;
  state.evidence = evidence;
  if (evidence.kind === "unknown" && evidence.reason === "protected_context" && state.nudge) {
    effects.push(hideNudge(state, true));
  }
}

function applyOverlayAction(
  state: FocusMachineState,
  input: Extract<FocusInput, { type: "overlay_action" }>
): void {
  if (input.preview) {
    if (state.preview?.id === input.nudgeId) state.preview = undefined;
    return;
  }
  const session = state.session;
  if (session.status !== "active" || input.sessionId !== session.id) return;
  const currentNudge = input.nudgeId === state.nudge?.id;
  const knownNudge = currentNudge || input.nudgeId === state.lastNudgeId;
  if (!knownNudge || (input.action === "hidden" && !currentNudge)) return;
  if (currentNudge) state.nudge = undefined;
  if (input.action === "hidden" && state.evidence) {
    state.evidence = {
      kind: "unknown",
      generation: state.evidence.generation,
      sequence: state.evidence.sequence,
      observedAt: input.now,
      reason: "transient_overlay"
    };
  }
  if (input.action === "snooze") {
    state.session = { ...session, snoozedUntil: input.now + FOCUS_TIMING.snoozeMs };
  } else if (input.action === "dismiss") {
    state.dismissedUntil = input.now + FOCUS_TIMING.dismissCooldownMs;
  }
}

function evaluate(state: FocusMachineState, now: number, effects: FocusEffect[]): void {
  if (state.preview && now >= state.preview.hideAt) effects.push(hidePreview(state, false));

  if (state.session.status !== "active") return;
  if (now >= state.session.endsAt) {
    endSession(state, effects);
    return;
  }
  if (state.session.snoozedUntil !== null && now >= state.session.snoozedUntil) {
    state.session = { ...state.session, snoozedUntil: null };
  }

  const session = state.session;
  const ready = capabilityReady(state.capability);
  const evidence = freshEvidence(state, now);
  const matchedDomain = evidence?.kind === "browser"
    ? matchingFocusDomain(evidence.domain, session.domains)
    : undefined;

  if (state.nudge) {
    const nudge = state.nudge;
    const stillMatching = evidence?.kind === "browser" &&
      evidence.processIdentifier === nudge.processIdentifier && matchedDomain !== undefined;
    if (!ready || !stillMatching) effects.push(hideNudge(state, true));
    else if (session.snoozedUntil !== null) effects.push(hideNudge(state, false));
    return;
  }

  if (!ready || evidence?.kind !== "browser" || !matchedDomain) return;
  if (session.snoozedUntil !== null) return;
  if (state.dismissedUntil !== undefined && now < state.dismissedUntil) return;
  if (!state.restyling && state.lastNudgeAt !== undefined &&
      now - state.lastNudgeAt < FOCUS_TIMING.globalCooldownMs) return;
  if (state.idleSeconds >= FOCUS_TIMING.idleSuppressionSeconds) return;

  if (state.preview) effects.push(hidePreview(state, true));
  state.nudgeCounter += 1;
  const nudge: VisibleNudge = {
    id: `nudge-${session.generation}-${state.nudgeCounter}`,
    sessionId: session.id,
    processIdentifier: evidence.processIdentifier,
    domain: matchedDomain,
    shownAt: now
  };
  state.nudge = nudge;
  state.lastNudgeId = nudge.id;
  state.lastNudgeAt = now;
  effects.push({
    type: "show",
    request: {
      nudgeId: nudge.id,
      sessionId: session.id,
      ...reminderCopy(session.goal, session.intention),
      expectedProcessIdentifier: nudge.processIdentifier,
      preview: false,
      experience: beginEffect(state, nudge.id, false, now)
    }
  });
}

export function freshEvidence(state: FocusMachineState, now: number): ForegroundEvidence | undefined {
  const evidence = state.evidence;
  if (!evidence || state.session.status !== "active") return undefined;
  if (evidence.generation !== state.session.generation) return undefined;
  const age = now - evidence.observedAt;
  if (age > FOCUS_TIMING.evidenceFreshnessMs || age < -FOCUS_TIMING.evidenceFreshnessMs) return undefined;
  return evidence;
}

function endSession(state: FocusMachineState, effects: FocusEffect[]): void {
  if (state.nudge) effects.push(hideNudge(state, true));
  state.session = { status: "idle" };
  state.evidence = undefined;
  state.dismissedUntil = undefined;
  effects.push({ type: "observe", generation: 0 });
}

function hideNudge(state: FocusMachineState, immediate: boolean): FocusEffect {
  const id = state.nudge!.id;
  state.nudge = undefined;
  return { type: "hide", nudgeId: id, immediate };
}

function hidePreview(state: FocusMachineState, immediate: boolean): FocusEffect {
  const id = state.preview!.id;
  state.preview = undefined;
  return { type: "hide", nudgeId: id, immediate };
}

/** Concise reminder text: the goal title plus the intention (or the goal's current focus). */
export function reminderCopy(goal: Goal | undefined, intention: string): { title: string; message: string } {
  if (!goal) {
    return {
      title: "Back to what matters",
      message: "This is how a Focus reminder looks. It never blocks a site."
    };
  }
  const focus = intention.trim() || goal.currentFocus.trim();
  return {
    title: truncate(goal.title, 120),
    message: truncate(focus ? `Back to: ${focus}` : "Is this helping right now?", 200)
  };
}

function truncate(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

export function sessionView(state: FocusMachineState): FocusSession {
  const session = state.session;
  if (session.status !== "active") return { status: "idle" };
  return {
    status: "active",
    id: session.id,
    goal: structuredClone(session.goal),
    intention: session.intention,
    domains: [...session.domains],
    startedAt: new Date(session.startedAt).toISOString(),
    endsAt: new Date(session.endsAt).toISOString(),
    snoozedUntil: session.snoozedUntil === null ? null : new Date(session.snoozedUntil).toISOString()
  };
}

export function foregroundSummary(state: FocusMachineState, now: number): FocusForegroundSummary {
  if (state.session.status !== "active") return "not_watching";
  if (state.idleSeconds >= FOCUS_TIMING.idleSuppressionSeconds) return "idle";
  if (!state.evidence) return "waiting";
  const evidence = freshEvidence(state, now);
  if (!evidence) return "unknown";
  if (evidence.kind === "browser") {
    return matchingFocusDomain(evidence.domain, state.session.domains) ? "listed_site" : "other_site";
  }
  switch (evidence.reason) {
    case "other_application":
    case "own_process": return "other_app";
    case "browser_address_unavailable": return "address_unavailable";
    case "protected_context": return "protected_context";
    case "excluded_application": return "excluded_app";
    case "screen_asleep": return "asleep";
    case "session_locked": return "locked";
    default: return "unknown";
  }
}

export function effectView(state: FocusMachineState): FocusEffectState | null {
  const effect = state.effect;
  if (!effect) return null;
  return {
    requested: effect.requested,
    status: effect.status,
    fallbackReason: effect.fallbackReason,
    preview: effect.preview,
    visible: effect.visible,
    updatedAt: new Date(effect.updatedAt).toISOString()
  };
}

export function needsTimer(state: FocusMachineState): boolean {
  return state.session.status === "active" || Boolean(state.nudge) || Boolean(state.preview);
}
