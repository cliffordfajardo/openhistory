import type { BootstrapState } from "@shared/contracts";
import type { FocusViewState } from "@shared/focus";
import { useEffect, useState } from "react";

export type SetAppState = React.Dispatch<React.SetStateAction<BootstrapState | undefined>>;

export function withFocus(setState: SetAppState, focus: FocusViewState): void {
  setState((current) => current ? { ...current, focus } : current);
}

/** Runs a Focus mutation and returns a readable error message instead of throwing. */
export async function focusAction(
  setState: SetAppState,
  action: () => Promise<FocusViewState>
): Promise<string | undefined> {
  try {
    withFocus(setState, await action());
    return undefined;
  } catch (caught) {
    return readableError(caught);
  }
}

export function readableError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  // Electron prefixes IPC errors with the channel; show only the human part.
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return cleaned || "Something went wrong. Try again.";
}

export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export function formatClock(value: string | number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function InlineError({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="error-message" role="alert">{children}</div>;
}
