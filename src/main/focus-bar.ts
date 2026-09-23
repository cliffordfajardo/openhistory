import type { AppPresentationMode } from "@shared/contracts";
import {
  focusSessionRemainingMs,
  type ActiveFocusSession,
  type FocusBarGeometry,
  type FocusBarPosition,
  type FocusSession
} from "@shared/focus";
import { z } from "zod";

/**
 * What the floating bar sends back. `moved` reports where a drag finished and `resized` where an
 * edge drag or a width menu item left the whole capsule; the others are the session controls.
 * Every line carries the session it was drawn for, so a click that arrives after the session
 * changed is discarded instead of applied to the new one.
 */
export const FOCUS_BAR_ACTIONS = [
  "pause",
  "resume",
  "complete",
  "edit",
  "move_to_menu_bar",
  "moved",
  "resized"
] as const;
export type FocusBarAction = (typeof FOCUS_BAR_ACTIONS)[number];

export const FocusBarActionSchema = z.object({
  action: z.enum(FOCUS_BAR_ACTIONS),
  sessionId: z.string().min(1).max(100),
  x: z.number().finite().min(-200_000).max(200_000).optional(),
  y: z.number().finite().min(-200_000).max(200_000).optional(),
  width: z.number().finite().min(0).max(200_000).optional()
}).strict();

/**
 * What the bar draws. The deadline holds still while the countdown runs — the deadline is the
 * anchor the native paint timer counts down from — so a snapshot is sent only when something
 * really changes, never once a second.
 */
export interface FocusBarSnapshot {
  sessionId: string;
  goalTitle: string;
  intention: string;
  /** Deadline in seconds since the epoch, or null while the session is paused. */
  endsAtEpochSeconds: number | null;
  /** The frozen countdown while paused; null while running, when the deadline decides. */
  pausedRemainingSeconds: number | null;
  totalSeconds: number;
  snoozed: boolean;
  /** Saved bottom-left corner, or null to place the bar at the default position. */
  position: FocusBarPosition | null;
  /** Saved width in points; the native side trims it to the display it lands on. */
  width: number;
}

export type FocusBarShowResult = "shown" | "invalid_request" | "not_main_thread" | "no_display";

export function focusBarSnapshot(
  session: ActiveFocusSession,
  now: number,
  geometry: FocusBarGeometry
): FocusBarSnapshot {
  const snoozedUntil = session.snoozedUntil === null ? 0 : Date.parse(session.snoozedUntil);
  return {
    sessionId: session.id,
    goalTitle: session.goal.title,
    intention: session.intention,
    endsAtEpochSeconds: session.endsAt === null ? null : Date.parse(session.endsAt) / 1_000,
    pausedRemainingSeconds: session.endsAt === null
      ? focusSessionRemainingMs(session, now) / 1_000
      : null,
    totalSeconds: Math.max(1, session.totalMs / 1_000),
    snoozed: snoozedUntil > now,
    position: geometry.position,
    width: geometry.width
  };
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatFocusCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The menu-bar countdown beside the icon. Empty while no session runs, so the icon stands alone. */
export function focusMenuBarTitle(session: FocusSession, now: number): string {
  if (session.status !== "active") return "";
  const countdown = formatFocusCountdown(focusSessionRemainingMs(session, now));
  return session.endsAt === null ? `Paused ${countdown}` : countdown;
}

/**
 * Who the menu-bar icon belongs to. A running session always gets one, including in Dock
 * presentation, so its controls and keyboard entry are reachable; that temporary icon goes away
 * when the session ends, and the person's chosen presentation mode is never changed.
 */
export function trayPresence(
  mode: AppPresentationMode,
  sessionActive: boolean
): "presentation" | "session" | "none" {
  if (mode === "menuBar") return "presentation";
  return sessionActive ? "session" : "none";
}
