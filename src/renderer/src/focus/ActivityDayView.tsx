import type { ActivityDayEntry, ActivityDayGapReason, ActivityDayView as DayView } from "@shared/focus";
import { useEffect, useState } from "react";
import { InlineError, formatClock, formatDuration, readableError } from "./shared";

const GAP_LABELS: Record<ActivityDayGapReason, string> = {
  no_recorded_activity: "No recorded activity",
  asleep: "Display asleep",
  locked: "Screen locked",
  capture_off: "Capture off or app not running",
  private: "Private activity excluded"
};

const TODAY_REFRESH_MS = 60_000;

export function ActivityDayTimeline(): React.JSX.Element {
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const [day, setDay] = useState<DayView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const today = localDateKey(new Date());
  const isToday = date === today;

  useEffect(() => {
    let cancelled = false;
    let request = 0;
    async function load(): Promise<void> {
      const currentRequest = ++request;
      setLoading(true);
      try {
        const view = await window.openHistory.getActivityDay(date);
        if (cancelled || currentRequest !== request) return;
        setDay(view);
        setError(undefined);
      } catch (caught) {
        if (!cancelled && currentRequest === request) setError(readableError(caught));
      } finally {
        if (!cancelled && currentRequest === request) setLoading(false);
      }
    }
    void load();
    const timer = date === localDateKey(new Date())
      ? window.setInterval(() => void load(), TODAY_REFRESH_MS)
      : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [date]);

  const earlierDates = day?.availableDates.filter((candidate) => candidate < date) ?? [];

  return (
    <section className="activity-day" aria-labelledby="activity-day-title">
      <div className="activity-day-nav">
        <button
          aria-label="Previous day"
          className="activity-day-step"
          onClick={() => setDate(shiftDate(date, -1))}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m9.75 3.25-4.5 4.75 4.5 4.75" /></svg>
        </button>
        <div className="activity-day-heading">
          <h2 id="activity-day-title">{isToday ? "Today" : weekday(date)}</h2>
          <span>{longDate(date)}</span>
        </div>
        <button
          aria-label="Next day"
          className="activity-day-step"
          disabled={isToday}
          onClick={() => setDate(shiftDate(date, 1) > today ? today : shiftDate(date, 1))}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6.25 3.25 4.5 4.75-4.5 4.75" /></svg>
        </button>
      </div>
      <div className="activity-day-jumps">
        {earlierDates[0] && earlierDates[0] !== shiftDate(date, -1) ? (
          <button className="focus-link-button" onClick={() => setDate(earlierDates[0]!)} type="button">
            ← Last day with activity ({shortDate(earlierDates[0]!)})
          </button>
        ) : <span />}
        {!isToday ? (
          <button className="focus-link-button" onClick={() => setDate(today)} type="button">
            Back to today →
          </button>
        ) : null}
      </div>

      {error ? <InlineError>{error}</InlineError> : null}
      {day && day.date === date ? (
        <>
          <p className="activity-day-summary" aria-live="polite">
            {day.eventCount === 0
              ? "No recorded activity on this day."
              : `${day.eventCount.toLocaleString()} recorded ${day.eventCount === 1 ? "event" : "events"}` +
                (day.firstEventAt && day.lastEventAt
                  ? ` between ${formatClock(day.firstEventAt)} and ${formatClock(day.lastEventAt)}`
                  : "") +
                (day.observedMilliseconds >= 60_000
                  ? ` · ${formatDuration(day.observedMilliseconds)} within observed spans`
                  : "")}
            {loading ? <span className="activity-day-loading"> · Updating…</span> : null}
          </p>
          {day.truncated ? (
            <div className="notice" role="status">This day is very large, so only the first part is shown.</div>
          ) : null}
          {day.entries.length ? (
            <ol className="activity-day-list">
              {day.entries.map((entry) => <ActivityDayRow entry={entry} key={entry.id} />)}
            </ol>
          ) : day.eventCount > 0 ? (
            <p className="focus-quiet">Only capture markers were recorded on this day.</p>
          ) : null}
          <p className="activity-day-footnote">
            Times come from recorded events only. A row’s duration spans its first to last observed event; quiet stretches aren’t counted as active or idle time, and pauses or sleep appear as their own rows when they were recorded.
          </p>
        </>
      ) : loading ? (
        <p className="focus-quiet">Loading…</p>
      ) : null}
    </section>
  );
}

function ActivityDayRow({ entry }: { entry: ActivityDayEntry }): React.JSX.Element {
  const start = Date.parse(entry.startTime);
  const end = Date.parse(entry.endTime);
  const range = end - start >= 60_000 ? `${formatClock(start)} – ${formatClock(end)}` : formatClock(start);
  if (entry.kind === "gap") {
    return (
      <li className={`activity-day-gap is-${entry.reason}`}>
        <time dateTime={entry.startTime}>{range}</time>
        <span>{GAP_LABELS[entry.reason]}</span>
        <small>{formatDuration(end - start)}</small>
      </li>
    );
  }
  const detail = entry.domain && entry.windowTitle && !entry.windowTitle.includes(entry.domain)
    ? `${entry.windowTitle} · ${entry.domain}`
    : entry.windowTitle ?? entry.domain;
  return (
    <li className="activity-day-span">
      <time dateTime={entry.startTime}>{range}</time>
      <div className="activity-day-copy">
        <strong>{entry.application.name}</strong>
        {detail ? <span title={detail}>{detail}</span> : null}
      </div>
      <small>{end - start >= 60_000 ? formatDuration(end - start) : "brief"}</small>
    </li>
  );
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12);
}

function shiftDate(value: string, days: number): string {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function weekday(value: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(parseDateKey(value));
}

function longDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(parseDateKey(value));
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parseDateKey(value));
}
