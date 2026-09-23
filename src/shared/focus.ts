
export const FOCUS_LIMITS = {
  goals: 50,
  goalTitle: 120,
  goalWhy: 1_000,
  goalCurrentFocus: 500,
  intention: 500,
  domains: 100,
  domainLength: 253,
  minimumDurationMinutes: 5,
  maximumDurationMinutes: 240,
  /** A running session can be shortened to a single minute; only starting needs five. */
  minimumRemainingMinutes: 1
} as const;

export const FOCUS_DURATION_PRESETS = [25, 50] as const;

export const FOCUS_TIMING = {
  /** Global snooze from the reminder card or the app. */
  snoozeMs: 5 * 60_000,
  /** Quiet period after the person dismisses a reminder. */
  dismissCooldownMs: 60_000,
  /** Minimum time between two automatic reminders. */
  globalCooldownMs: 2_000,
  /** Preview reminders fade out after this long. */
  previewDurationMs: 8_000,
  /** Foreground evidence older than this is treated as unknown. */
  evidenceFreshnessMs: 3_000,
  /** Aggregate system idle time above this suppresses reminders. */
  idleSuppressionSeconds: 120
} as const;

export interface Goal {
  id: string;
  title: string;
  why: string;
  currentFocus: string;
}

export interface GoalDraft {
  id?: string;
  title: string;
  why: string;
  currentFocus: string;
}

/**
 * Which grayscale a reminder uses; the amber edge is the separate `amberEdge` preference. `amber`
 * is the stored name for no grayscale, kept from before the two were independent.
 * `grayscale_window` shows only the distracting window in grayscale. `grayscale_screen` shows the
 * display that holds the distracting window in grayscale. `grayscale_system` switches macOS Color
 * Filters to grayscale through a private system setting; that affects every display, the amber
 * edge included, and needs no Screen Recording access.
 */
export const FOCUS_EXPERIENCES = ["amber", "grayscale_window", "grayscale_screen", "grayscale_system"] as const;
export type FocusExperience = (typeof FOCUS_EXPERIENCES)[number];

/**
 * Where the running session is shown: the floating bar (a small native panel) or only the
 * menu-bar icon. Both always offer the same session controls.
 */
export const FOCUS_BAR_PRESENTATIONS = ["floating", "menuBar"] as const;
export type FocusBarPresentation = (typeof FOCUS_BAR_PRESENTATIONS)[number];

/** Bottom-left corner of the floating bar in global AppKit points (y up). */
export interface FocusBarPosition {
  x: number;
  y: number;
}

/**
 * How wide the floating bar is, in points. The height is fixed. The maximum is generous rather
 * than a real display width: a bar wider than its display is trimmed to fit when it is placed.
 */
export const FOCUS_BAR_WIDTH = {
  default: 460,
  minimum: 360,
  maximum: 20_000
} as const;

/** Where the floating bar sits and how wide it is, as saved between sessions. */
export interface FocusBarGeometry {
  position: FocusBarPosition | null;
  width: number;
}

export interface FocusPreferences {
  domains: string[];
  durationMinutes: number;
  experience: FocusExperience;
  /** Warm edge around the display, independent of grayscale. */
  amberEdge: boolean;
  barPresentation: FocusBarPresentation;
  /**
   * The strip across the menu region of every display that shrinks as the session runs. Off unless
   * it is chosen, and independent of `barPresentation`: either, both or neither can be on.
   */
  showTimerBar: boolean;
}

/**
 * System grayscale ownership. `applied`: this app switched Color Filters to grayscale and will put
 * the earlier settings back. `restore_failed`: they couldn't be put back yet and are kept for a
 * retry. Phases follow the settings macOS reports, not what is verified on screen.
 */
export interface FocusSystemFilterState {
  /** The private Color Filters setting could be read on this Mac. */
  available: boolean;
  phase: "idle" | "applied" | "restore_failed" | "unsupported";
  /** Why the last turn-on didn't happen; cleared by the next success. */
  failure: "apply_failed" | "journal_unwritable" | null;
  /** Earlier settings still wait to be restored, possibly from a previous launch. */
  restorePending: boolean;
}

/** Whether macOS currently allows this app to capture the screen, checked without prompting. */
export type FocusScreenCaptureAccess = "granted" | "not_granted" | "unsupported";

export interface FocusScreenCaptureState {
  access: FocusScreenCaptureAccess;
  /** The system prompt was already requested in this launch; macOS shows it at most once. */
  requested: boolean;
}

/** Why a reminder showed without its requested grayscale. */
export type FocusEffectFallbackReason =
  | "permission_needed"
  | "unsupported"
  | "capture_failed"
  | "no_frame"
  | "display_unavailable"
  | "window_unavailable"
  | "window_spans_displays"
  | "system_filter_failed"
  | "system_filter_unavailable"
  /** The person restored colors while this reminder was visible. */
  | "system_filter_restored";

/**
 * The visual effect of the latest reminder or preview. Captured grayscale stays "preparing" until
 * the native side reports its first frame on screen; system grayscale until its setting is written.
 */
export interface FocusEffectState {
  requested: FocusExperience;
  status: "preparing" | "showing" | "fallback";
  fallbackReason: FocusEffectFallbackReason | null;
  preview: boolean;
  visible: boolean;
  updatedAt: string;
}

export interface FocusStartRequest {
  goalId: string;
  intention: string;
  durationMinutes: number;
}

/**
 * A session is paused when `endsAt` is null; `pausedRemainingMs` then holds the frozen countdown.
 * `totalMs` is the planned length including edits, so progress survives a pause and a new
 * deadline (it is never derived from `endsAt - startedAt`).
 */
export type FocusSession =
  | { status: "idle" }
  | {
    status: "active";
    id: string;
    goal: Goal;
    intention: string;
    domains: string[];
    startedAt: string;
    endsAt: string | null;
    totalMs: number;
    pausedRemainingMs: number | null;
    snoozedUntil: string | null;
  };

export type ActiveFocusSession = Extract<FocusSession, { status: "active" }>;

/**
 * The one session record kept on disk so a session survives a quit or a crash. It holds the same
 * clock the running session publishes and an immutable copy of the goal, so a session whose goal
 * was deleted still comes back. Nothing about the foreground, the reminders or the overlays is
 * stored: after a restart, a reminder needs fresh evidence just as it does after a pause.
 */
export interface PersistedFocusSession {
  id: string;
  goal: Goal;
  intention: string;
  startedAt: string;
  /** Deadline while the session runs; null while it is paused. */
  endsAt: string | null;
  totalMs: number;
  /** The frozen remainder while paused; null while the deadline decides. */
  pausedRemainingMs: number | null;
  snoozedUntil: string | null;
}

/** Time left in a session: frozen while paused, counted down from the deadline while running. */
export function focusSessionRemainingMs(session: ActiveFocusSession, now: number): number {
  if (session.endsAt === null) return Math.max(0, session.pausedRemainingMs ?? 0);
  return Math.max(0, Date.parse(session.endsAt) - now);
}

/** Share of the planned length already spent, from 0 to 1. */
export function focusSessionProgress(session: ActiveFocusSession, now: number): number {
  const total = Math.max(1, session.totalMs);
  return Math.min(1, Math.max(0, (total - focusSessionRemainingMs(session, now)) / total));
}

/** A change to a running session. Omitted fields are left as they are. */
export interface FocusSessionEdit {
  goalId?: string;
  intention?: string;
  remainingMinutes?: number;
}

/**
 * Why Focus cannot currently notice a listed site. Anything other than "ready" means reminders
 * are suppressed; the renderer explains the reason instead of implying protection.
 */
export type FocusDetectionState =
  | "ready"
  | "capture_paused"
  | "needs_privacy_notice"
  | "needs_accessibility"
  | "url_capture_off"
  | "collector_unavailable"
  | "overlay_unavailable";

/** Coarse, content-free summary of the latest foreground evidence for the Focus page. */
export type FocusForegroundSummary =
  | "not_watching"
  | "paused"
  | "waiting"
  | "listed_site"
  | "other_site"
  | "other_app"
  | "address_unavailable"
  | "protected_context"
  | "excluded_app"
  | "idle"
  | "locked"
  | "asleep"
  | "unknown";

export interface FocusViewState {
  goals: Goal[];
  selectedGoalId: string | null;
  preferences: FocusPreferences;
  session: FocusSession;
  detection: FocusDetectionState;
  foreground: FocusForegroundSummary;
  reminderVisible: boolean;
  lastReminderAt: string | null;
  screenCapture: FocusScreenCaptureState;
  systemFilter: FocusSystemFilterState;
  effect: FocusEffectState | null;
  /** Saved bottom-left corner of the floating bar, or null while it has never been moved. */
  barPosition: FocusBarPosition | null;
  /** The native floating bar exists in this build. */
  barAvailable: boolean;
  /** The native timer bar exists in this build; without it the preference cannot be honored. */
  timerBarAvailable: boolean;
  recoveredFromInvalidFile: boolean;
}

export type ActivityDayGapReason =
  | "no_recorded_activity"
  | "asleep"
  | "locked"
  | "capture_off"
  | "private";

export type ActivityDayEntry =
  | {
    kind: "span";
    id: string;
    startTime: string;
    endTime: string;
    application: { name: string; bundleIdentifier: string | null };
    windowTitle?: string;
    domain?: string;
    eventCount: number;
  }
  | {
    kind: "gap";
    id: string;
    startTime: string;
    endTime: string;
    reason: ActivityDayGapReason;
  };

export interface ActivityDayView {
  date: string;
  entries: ActivityDayEntry[];
  eventCount: number;
  observedMilliseconds: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  truncated: boolean;
  availableDates: string[];
}

export const FOCUS_INITIAL_BROWSERS = ["com.apple.Safari", "com.google.Chrome"] as const;

export const FOCUS_EXPERIMENTAL_BROWSERS = [
  "com.google.Chrome.beta",
  "com.google.Chrome.canary",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "org.mozilla.firefox",
  "org.mozilla.firefoxdeveloperedition",
  "org.chromium.Chromium",
  "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi",
  "com.operasoftware.Opera"
] as const;

const SHARED_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in",
  "com.br", "com.cn", "com.mx", "com.tr", "com.tw", "com.hk", "com.sg", "co.za",
  "github.io", "gitlab.io", "pages.dev", "vercel.app", "netlify.app", "herokuapp.com",
  "blogspot.com", "wordpress.com", "tumblr.com", "appspot.com", "web.app", "firebaseapp.com"
]);

export type FocusDomainParseResult =
  | { ok: true; domain: string }
  | { ok: false; reason: string };

/**
 * Normalizes a distracting-site rule. Accepts a bare host ("youtube.com") or an http(s) URL and
 * returns its lowercase ASCII host without a leading "www.". Rejects credentials, ports, other
 * schemes, IP addresses, single-label hosts and shared suffixes.
 */
export function parseFocusDomain(input: string): FocusDomainParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Enter a site such as youtube.com" };
  if (trimmed.length > 2_048) return { ok: false, reason: "That address is too long" };
  if (/\s/.test(trimmed)) return { ok: false, reason: "Sites can't contain spaces" };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, reason: "Only http and https sites are supported" };
  }
  const withoutWildcard = trimmed.replace(/^\*\./, "");
  let url: URL;
  try {
    url = new URL(hasScheme ? withoutWildcard : `https://${withoutWildcard}`);
  } catch {
    return { ok: false, reason: "That doesn't look like a site address" };
  }
  if (url.username || url.password) return { ok: false, reason: "Remove the sign-in details from the address" };
  if (url.port) return { ok: false, reason: "Remove the port from the address" };

  const host = normalizeObservedHost(url.hostname);
  if (!host) return { ok: false, reason: "That doesn't look like a site address" };
  if (host.length > FOCUS_LIMITS.domainLength) return { ok: false, reason: "That address is too long" };
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.startsWith("[")) {
    return { ok: false, reason: "Use a site name instead of an IP address" };
  }
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, reason: "Include the full site name, like example.com" };
  if (!labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    return { ok: false, reason: "That doesn't look like a site address" };
  }
  const topLevel = labels.at(-1)!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(topLevel)) {
    return { ok: false, reason: "That doesn't look like a site address" };
  }
  if (SHARED_SUFFIXES.has(host)) {
    return { ok: false, reason: "That suffix is shared by many sites; enter a specific site" };
  }
  return { ok: true, domain: host };
}

/** Lowercases, converts IDNs to punycode, drops trailing dots and one leading "www.". */
export function normalizeObservedHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed || trimmed.length > 2_048 || /[\s/\\@?#:]/.test(trimmed)) return undefined;
  let hostname: string;
  try {
    hostname = new URL(`https://${trimmed}`).hostname;
  } catch {
    return undefined;
  }
  const normalized = hostname.replace(/\.+$/, "");
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

/** True when the observed host is the rule's host or a dot-delimited subdomain of it. */
export function focusDomainMatches(observedHost: string, rule: string): boolean {
  const observed = normalizeObservedHost(observedHost);
  if (!observed || !rule) return false;
  return observed === rule || observed.endsWith(`.${rule}`);
}

export function matchingFocusDomain(observedHost: string, rules: readonly string[]): string | undefined {
  return rules.find((rule) => focusDomainMatches(observedHost, rule));
}

export function normalizeFocusDomainList(values: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const value of values) {
    const parsed = parseFocusDomain(value);
    if (parsed.ok) domains.add(parsed.domain);
  }
  return [...domains].sort();
}
