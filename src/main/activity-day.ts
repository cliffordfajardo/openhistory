import type { ActivityEvent } from "@shared/contracts";
import type { ActivityDayEntry, ActivityDayGapReason, ActivityDayView } from "@shared/focus";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseRawActivityEvent } from "./activity-event-file";
import { ActivityPrivacyFilter, isBrowserEvent, type ActivityPrivacyOptions } from "./privacy-policy";


export interface ActivityDayLimits {
  maxBytes: number;
  maxEvents: number;
  maxEntries: number;
  primingBytes: number;
  silenceMs: number;
  minimumExplicitGapMs: number;
}

export const ACTIVITY_DAY_LIMITS: ActivityDayLimits = {
  maxBytes: 48 * 1_024 * 1_024,
  maxEvents: 60_000,
  maxEntries: 3_000,
  primingBytes: 2 * 1_024 * 1_024,
  silenceMs: 5 * 60_000,
  minimumExplicitGapMs: 60_000
};
const CHUNK_BYTES = 1_024 * 1_024;
const MAX_LISTED_DATES = 3_660;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FILE_NAME = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const CONTEXT_KINDS = new Set<ActivityEvent["kind"]>(["application_activated", "window_changed", "url_changed"]);

export interface ActivityDayOptions {
  limits?: Partial<ActivityDayLimits>;
  now?: Date;
}

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2200) return false;
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function previousDateKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return localDateKey(new Date(year, month - 1, day - 1, 12));
}

export function listActivityDates(dataDirectory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dataDirectory);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const match = FILE_NAME.exec(name);
      return match && isValidDateKey(match[1]) ? [match[1]!] : [];
    })
    .sort()
    .reverse()
    .slice(0, MAX_LISTED_DATES);
}

export function readActivityDay(
  dataDirectory: string,
  date: string,
  privacy: ActivityPrivacyOptions,
  options: ActivityDayOptions = {}
): ActivityDayView {
  if (!isValidDateKey(date)) throw new Error("Invalid date");
  const limits = { ...ACTIVITY_DAY_LIMITS, ...options.limits };
  const read = readEventFile(dataDirectory, date, 0, limits.maxBytes, limits.maxEvents);

  const filter = new ActivityPrivacyFilter(privacy);
  const priming = readEventFile(dataDirectory, previousDateKey(date), -limits.primingBytes, limits.primingBytes, limits.maxEvents);
  const previousEvents = sortChronologically(priming.events);
  filter.filter(previousEvents);

  const filtered = filter.filter(sortChronologically(read.events));
  const events = priming.incompleteStart || priming.truncated
    ? withholdUncertainBrowserContext(filtered)
    : filtered;
  const now = options.now ?? new Date();
  const dayStart = localDayStart(date);
  const physicalState = { asleep: false, locked: false };
  // If the event cap cut off the end of the tail, its last physical state is unknown.
  if (!priming.truncated) {
    for (const event of previousEvents) {
      if (Date.parse(event.timestamp) >= dayStart) continue;
      if (event.kind === "collector_started") {
        physicalState.asleep = false;
        physicalState.locked = false;
      }
      if (event.kind === "screen_slept") physicalState.asleep = true;
      if (event.kind === "screen_woke") physicalState.asleep = false;
      if (event.kind === "session_locked") physicalState.locked = true;
      if (event.kind === "session_unlocked") physicalState.locked = false;
    }
  }
  const chronology = buildActivityChronology(events, date, now, limits, physicalState);
  const spans = chronology.entries.filter((entry) => entry.kind === "span");
  return {
    date,
    entries: chronology.entries,
    eventCount: events.length,
    observedMilliseconds: spans.reduce(
      (total, entry) => total + Date.parse(entry.endTime) - Date.parse(entry.startTime),
      0
    ),
    firstEventAt: events[0]?.timestamp ?? null,
    lastEventAt: events.at(-1)?.timestamp ?? null,
    truncated: read.truncated || chronology.truncated,
    availableDates: listActivityDates(dataDirectory)
  };
}

interface OpenSpan {
  key: string;
  startMs: number;
  endMs: number;
  name: string;
  bundleIdentifier: string | null;
  windowTitle?: string;
  domain?: string;
  eventCount: number;
  firstId: string;
}

export function buildActivityChronology(
  events: ActivityEvent[],
  date: string,
  now: Date,
  limits: Pick<ActivityDayLimits, "maxEntries" | "silenceMs" | "minimumExplicitGapMs"> = ACTIVITY_DAY_LIMITS,
  initialState: Readonly<{ asleep: boolean; locked: boolean }> = { asleep: false, locked: false }
): { entries: ActivityDayEntry[]; truncated: boolean } {
  const dayStart = localDayStart(date);
  const dayEnd = nextLocalDayStart(date);
  const entries: ActivityDayEntry[] = [];
  let truncated = false;
  let span: OpenSpan | undefined;
  let asleep = initialState.asleep;
  let locked = initialState.locked;
  let privatePeriod = false;
  let explicitGap: { reason: ActivityDayGapReason; startMs: number } | undefined =
    asleep || locked ? { reason: asleep ? "asleep" : "locked", startMs: dayStart } : undefined;
  let lastEventMs: number | undefined;

  const push = (entry: ActivityDayEntry): void => {
    if (entries.length >= limits.maxEntries) {
      truncated = true;
      return;
    }
    entries.push(entry);
  };
  const closeSpan = (): void => {
    if (!span) return;
    push({
      kind: "span",
      id: `span-${span.firstId}`,
      startTime: new Date(span.startMs).toISOString(),
      endTime: new Date(span.endMs).toISOString(),
      application: { name: span.name, bundleIdentifier: span.bundleIdentifier },
      ...(span.windowTitle ? { windowTitle: span.windowTitle } : {}),
      ...(span.domain ? { domain: span.domain } : {}),
      eventCount: span.eventCount
    });
    span = undefined;
  };
  const gap = (reason: ActivityDayGapReason, startMs: number, endMs: number, minimum: number): void => {
    if (endMs - startMs < minimum) return;
    push({
      kind: "gap",
      id: `gap-${reason}-${startMs}`,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      reason
    });
  };
  const closeExplicitGap = (endMs: number): void => {
    if (!explicitGap) return;
    gap(explicitGap.reason, explicitGap.startMs, endMs, limits.minimumExplicitGapMs);
    explicitGap = undefined;
  };
  const updateExplicitGap = (time: number): void => {
    const reason: ActivityDayGapReason | undefined = asleep ? "asleep" : locked ? "locked" :
      privatePeriod ? "private" : undefined;
    if (reason === explicitGap?.reason) return;
    closeExplicitGap(time);
    if (reason) explicitGap = { reason, startMs: time };
  };

  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time) || time < dayStart || time >= dayEnd) continue;

    if (event.kind === "screen_slept" || event.kind === "session_locked") {
      closeSpan();
      if (event.kind === "screen_slept") asleep = true;
      else locked = true;
      updateExplicitGap(time);
      lastEventMs = time;
      continue;
    }
    if (event.kind === "screen_woke" || event.kind === "session_unlocked") {
      if (event.kind === "screen_woke") asleep = false;
      else locked = false;
      updateExplicitGap(time);
      lastEventMs = time;
      continue;
    }
    if (event.kind === "privacy_boundary") {
      closeSpan();
      privatePeriod = true;
      updateExplicitGap(time);
      lastEventMs = time;
      continue;
    }
    if (event.kind === "collector_started") {
      closeSpan();
      const hadExplicitGap = Boolean(explicitGap);
      // A new collector starts from fresh screen/session state. Unlock/wake notifications missed
      // while capture was off cannot arrive later, so old physical markers end at this boundary.
      asleep = false;
      locked = false;
      privatePeriod = false;
      updateExplicitGap(time);
      if (!hadExplicitGap && lastEventMs !== undefined) gap("capture_off", lastEventMs, time, limits.silenceMs);
      lastEventMs = time;
      continue;
    }

    const application = event.application;
    if (asleep || locked) {
      lastEventMs = time;
      continue;
    }
    if (!application) {
      lastEventMs = time;
      continue;
    }

    const hadExplicitGap = Boolean(explicitGap);
    privatePeriod = false;
    updateExplicitGap(time);
    if (!hadExplicitGap && lastEventMs !== undefined && time - lastEventMs >= limits.silenceMs) {
      closeSpan();
      gap("no_recorded_activity", lastEventMs, time, limits.silenceMs);
    }
    lastEventMs = time;

    const key = application.bundleIdentifier ?? application.localizedName ?? `pid:${application.processIdentifier}`;
    if (event.kind === "application_terminated") {
      if (span?.key === key) {
        span.endMs = time;
        span.eventCount += 1;
        closeSpan();
      }
      continue;
    }

    const domain = event.browser?.domain;
    const title = event.windowTitle;
    if (span && span.key === key) {
      const contextChanged = CONTEXT_KINDS.has(event.kind) && (
        (title !== undefined && span.windowTitle !== undefined && title !== span.windowTitle) ||
        (domain !== undefined && span.domain !== undefined && domain !== span.domain)
      );
      if (!contextChanged) {
        span.endMs = time;
        span.eventCount += 1;
        span.windowTitle ??= title;
        span.domain ??= domain;
        continue;
      }
    }
    closeSpan();
    span = {
      key,
      startMs: time,
      endMs: time,
      name: application.localizedName ?? application.bundleIdentifier ?? "Unknown app",
      bundleIdentifier: application.bundleIdentifier ?? null,
      ...(title ? { windowTitle: title } : {}),
      ...(domain ? { domain } : {}),
      eventCount: 1,
      firstId: event.id
    };
  }

  closeSpan();
  if (explicitGap) {
    closeExplicitGap(Math.max(explicitGap.startMs, Math.min(dayEnd, now.getTime())));
  }
  return { entries, truncated };
}

function localDayStart(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).getTime();
}

function nextLocalDayStart(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day + 1).getTime();
}

function withholdUncertainBrowserContext(events: ActivityEvent[]): ActivityEvent[] {
  const established = new Set<string>();
  return events.filter((event) => {
    const key = event.application?.bundleIdentifier;
    if (!key || !isBrowserEvent(event)) return true;
    if (event.kind === "url_changed" && event.browser?.domain && event.browser.url) established.add(key);
    return established.has(key);
  });
}

function sortChronologically(events: ActivityEvent[]): ActivityEvent[] {
  const unique = new Map<string, ActivityEvent>();
  for (const event of events) unique.set(event.id, event);
  return [...unique.values()]
    .map((event, index) => ({ event, index, time: Date.parse(event.timestamp) }))
    .sort((left, right) => left.time - right.time || left.index - right.index)
    .map(({ event }) => event);
}

function readEventFile(
  dataDirectory: string,
  date: string,
  offset: number,
  maxBytes: number,
  maxEvents: number
): { events: ActivityEvent[]; truncated: boolean; incompleteStart: boolean } {
  const root = resolve(dataDirectory);
  const path = resolve(root, `events-${date}.jsonl`);
  if (dirname(path) !== root) return { events: [], truncated: false, incompleteStart: false };
  let size: number;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return { events: [], truncated: false, incompleteStart: false };
    size = stats.size;
  } catch {
    return { events: [], truncated: false, incompleteStart: false };
  }

  const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
  const end = Math.min(size, start + maxBytes);
  const events: ActivityEvent[] = [];
  let truncated = end < size;
  let pending: Buffer = Buffer.alloc(0);
  let discardFirstLine = start > 0;
  const descriptor = openSync(path, "r");
  try {
    let position = start;
    while (position < end && events.length < maxEvents) {
      const length = Math.min(CHUNK_BYTES, end - position);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(descriptor, chunk, 0, length, position);
      if (count === 0) break;
      position += count;
      let bytes: Buffer = pending.length
        ? Buffer.concat([pending, chunk.subarray(0, count)])
        : chunk.subarray(0, count);
      let newline = bytes.indexOf(0x0a);
      while (newline >= 0) {
        const line = bytes.subarray(0, newline).toString("utf8");
        bytes = bytes.subarray(newline + 1);
        if (discardFirstLine) {
          discardFirstLine = false;
        } else if (line) {
          const event = parseRawActivityEvent(line);
          if (event) events.push(event);
          if (events.length >= maxEvents) {
            truncated = bytes.length > 0 || position < size;
            break;
          }
        }
        newline = bytes.indexOf(0x0a);
      }
      pending = Buffer.from(bytes);
    }
    if (pending.length && !discardFirstLine && events.length < maxEvents && position >= size) {
      const event = parseRawActivityEvent(pending.toString("utf8"));
      if (event) events.push(event);
    }
  } finally {
    closeSync(descriptor);
  }
  return { events, truncated, incompleteStart: start > 0 };
}
