import {
  effectiveFocusEdgeColor,
  matchingFocusDomain,
  type FocusEdgeMode,
  type FocusPreferences
} from "@shared/focus";
import type { ForegroundUnknownReason } from "./foreground-evidence";
import { capabilityReady, freshEvidence, type FocusMachineState } from "./focus-state";

/**
 * Whether fresh unknown evidence still shows focus halo. Only the two ordinary non-browser contexts
 * show it; every other reason says nothing about whether a listed site is in front. A reason added
 * later must be classified here before the code compiles.
 */
export const FOCUS_HALO_UNKNOWN_POLICY: Record<ForegroundUnknownReason, "show" | "hide"> = {
  other_application: "show",
  own_process: "show",
  browser_address_unavailable: "hide",
  protected_context: "hide",
  excluded_application: "hide",
  no_frontmost_application: "hide",
  transient_overlay: "hide",
  screen_asleep: "hide",
  session_locked: "hide",
  accessibility_untrusted: "hide",
  url_capture_off: "hide",
  collector_stopped: "hide"
};

/** The accepted evidence a visible halo stands on; native keeps an invalidated one hidden. */
export interface FocusHaloObservation {
  generation: number;
  sequence: number;
}

export type FocusHaloDecision =
  | { kind: "visible"; observation: FocusHaloObservation }
  | {
    kind: "hidden";
    reason: "mode" | "session" | "paused" | "preview" | "capability" | "uncertain" | "distracting";
  };

/** Everything the native edge owner is told: no storage details and no browsing data. */
export interface FocusEdgeSnapshot {
  mode: FocusEdgeMode;
  /** The effective `#rrggbb` color, already resolved from `syncWithProgress`. */
  color: string;
  halo: { kind: "hidden" } | ({ kind: "visible" } & FocusHaloObservation);
}

/**
 * Whether focus halo shows now. It deliberately ignores the reminder, snooze, dismiss, cooldowns
 * and idle time: those decide whether a card shows, not whether a listed site is in front.
 */
export function focusHaloDecision(state: FocusMachineState, now: number, mode: FocusEdgeMode): FocusHaloDecision {
  if (mode !== "focus_halo") return { kind: "hidden", reason: "mode" };
  const session = state.session;
  if (session.status !== "active") return { kind: "hidden", reason: "session" };
  if (session.runningSince === null) return { kind: "hidden", reason: "paused" };
  if (state.preview) return { kind: "hidden", reason: "preview" };
  if (!capabilityReady(state.capability)) return { kind: "hidden", reason: "capability" };
  const evidence = freshEvidence(state, now);
  if (!evidence) return { kind: "hidden", reason: "uncertain" };
  if (evidence.kind === "browser") {
    if (matchingFocusDomain(evidence.domain, session.domains)) return { kind: "hidden", reason: "distracting" };
  } else if (FOCUS_HALO_UNKNOWN_POLICY[evidence.reason] === "hide") {
    return { kind: "hidden", reason: "uncertain" };
  }
  return { kind: "visible", observation: { generation: evidence.generation, sequence: evidence.sequence } };
}

export function focusEdgeSnapshot(
  state: FocusMachineState,
  now: number,
  preferences: Pick<FocusPreferences, "edge" | "progressColor">
): FocusEdgeSnapshot {
  const decision = focusHaloDecision(state, now, preferences.edge.mode);
  return {
    mode: preferences.edge.mode,
    color: effectiveFocusEdgeColor(preferences),
    halo: decision.kind === "visible" ? { kind: "visible", ...decision.observation } : { kind: "hidden" }
  };
}
