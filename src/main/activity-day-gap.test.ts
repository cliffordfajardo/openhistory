import type { ActivityEvent } from "@shared/contracts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildActivityChronology, readActivityDay } from "./activity-day";

const date = "2026-09-21";
const midnight = new Date(2026, 8, 21);
const at = (minutes: number): string => new Date(midnight.getTime() + minutes * 60_000).toISOString();
const event = (id: string, minutes: number, kind: ActivityEvent["kind"]): ActivityEvent => ({
  version: 1, id, timestamp: at(minutes), kind
});
const gaps = (entries: ReturnType<typeof buildActivityChronology>["entries"]) => entries
  .filter((entry) => entry.kind === "gap")
  .map(({ reason, startTime, endTime }) => [reason, startTime, endTime]);

test("sleep has precedence over lock, then lock resumes until its own unlock", () => {
  const result = buildActivityChronology([
    event("lock", 600, "session_locked"),
    event("sleep", 601, "screen_slept"),
    event("wake", 610, "screen_woke"),
    event("unlock", 630, "session_unlocked")
  ], date, new Date(at(631)));
  assert.deepEqual(gaps(result.entries), [
    ["locked", at(600), at(601)],
    ["asleep", at(601), at(610)],
    ["locked", at(610), at(630)]
  ]);
});

test("waking never closes a lock and unlocking never closes sleep", () => {
  const result = buildActivityChronology([
    event("sleep", 600, "screen_slept"),
    event("lock", 601, "session_locked"),
    event("unlock", 610, "session_unlocked"),
    event("wake", 630, "screen_woke")
  ], date, new Date(at(631)));
  assert.deepEqual(gaps(result.entries), [["asleep", at(600), at(630)]]);
});

test("application observations cannot turn a known lock into apparent active time", () => {
  const result = buildActivityChronology([
    event("lock", 600, "session_locked"),
    { ...browserEvent("stray", 605, "pointer_click"), windowTitle: "during lock" },
    event("unlock", 610, "session_unlocked"),
    { ...browserEvent("return", 611, "pointer_click"), windowTitle: "after lock" }
  ], date, new Date(at(615)));
  assert.deepEqual(gaps(result.entries), [["locked", at(600), at(610)]]);
  assert.equal(result.entries.filter((entry) => entry.kind === "span").length, 1);
  assert.doesNotMatch(JSON.stringify(result.entries), /during lock/);
});

test("collector restart ends stale physical state and permits later observed activity", () => {
  for (const [marker, reason] of [
    ["session_locked", "locked"], ["screen_slept", "asleep"]
  ] as const) {
    const result = buildActivityChronology([
      event(`start-${marker}`, 600, marker),
      event(`restart-${marker}`, 630, "collector_started"),
      { ...browserEvent(`app-${marker}`, 631, "application_activated"), windowTitle: "observed work" },
      { ...browserEvent(`window-${marker}`, 632, "window_changed"), windowTitle: "observed work" }
    ], date, new Date(at(635)));
    assert.deepEqual(gaps(result.entries), [[reason, at(600), at(630)]]);
    const spans = result.entries.filter((entry) => entry.kind === "span");
    assert.deepEqual(spans.map(({ startTime, endTime }) => [startTime, endTime]), [[at(631), at(632)]]);
  }
});

test("known overnight sleep and lock continue from local midnight, clipped to that day", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-day-gap-"));
  try {
    writeEvents(directory, "2026-09-20", [
      event("lock", -60, "session_locked"),
      event("sleep", -50, "screen_slept")
    ]);
    writeEvents(directory, date, [
      event("wake", 15, "screen_woke"),
      event("unlock", 30, "session_unlocked")
    ]);
    const view = readActivityDay(directory, date, {}, { now: new Date(at(1440)) });
    assert.deepEqual(gaps(view.entries), [
      ["asleep", at(0), at(15)],
      ["locked", at(15), at(30)]
    ]);
    assert.equal(view.eventCount, 2);
    assert.equal(view.observedMilliseconds, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unfinished overnight lock is bounded by the requested local day", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-day-gap-"));
  try {
    writeEvents(directory, "2026-09-20", [event("lock", -60, "session_locked")]);
    const view = readActivityDay(directory, date, {}, { now: new Date(at(3000)) });
    assert.deepEqual(gaps(view.entries), [["locked", at(0), at(1440)]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incomplete privacy carry-in withholds browser context until an explicit safe navigation", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-day-gap-"));
  try {
    writeEvents(directory, "2026-09-20", [
      { ...browserEvent("adult", -60, "url_changed"), browser: { url: "https://pornhub.com/private", domain: "pornhub.com" } },
      ...Array.from({ length: 15 }, (_, index) => event(`filler-${index}`, -40 + index, "screen_woke"))
    ]);
    writeEvents(directory, date, [
      { ...browserEvent("secret", 5, "pointer_click"), windowTitle: "private browser title" },
      { ...browserEvent("safe", 10, "url_changed"), browser: { url: "https://example.com/work", domain: "example.com" } },
      { ...browserEvent("public", 11, "pointer_click"), windowTitle: "public title" }
    ]);
    const view = readActivityDay(directory, date, {}, { limits: { primingBytes: 256 }, now: new Date(at(20)) });
    assert.doesNotMatch(JSON.stringify(view), /private browser title/);
    assert.match(JSON.stringify(view), /public title/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("complete previous-day privacy carry-in protects browser events after midnight", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-day-gap-"));
  try {
    writeEvents(directory, "2026-09-20", [
      { ...browserEvent("adult", -60, "url_changed"), browser: { url: "https://pornhub.com/private", domain: "pornhub.com" } }
    ]);
    writeEvents(directory, date, [
      { ...browserEvent("secret", 5, "pointer_click"), windowTitle: "private browser title" },
      { ...browserEvent("safe", 10, "url_changed"), browser: { url: "https://example.com/work", domain: "example.com" } }
    ]);
    const view = readActivityDay(directory, date, {}, { now: new Date(at(20)) });
    assert.doesNotMatch(JSON.stringify(view), /private browser title/);
    assert.equal(view.entries.some((entry) => entry.kind === "span" && entry.domain === "example.com"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function browserEvent(id: string, minutes: number, kind: ActivityEvent["kind"]): ActivityEvent {
  return { ...event(id, minutes, kind), application: {
    bundleIdentifier: "com.google.Chrome", localizedName: "Chrome", processIdentifier: 42
  } };
}

function writeEvents(directory: string, day: string, events: ActivityEvent[]): void {
  writeFileSync(join(directory, `events-${day}.jsonl`), `${events.map((value) => JSON.stringify(value)).join("\n")}\n`);
}


test("a previous-day collector restart clears lock and sleep before midnight carry-in", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-day-restart-"));
  try {
    for (const marker of ["session_locked", "screen_slept"] as const) {
      writeEvents(directory, "2026-09-20", [
        event("away", -60, marker),
        event("restart", -50, "collector_started")
      ]);
      writeEvents(directory, date, [
        { ...browserEvent("work", 540, "window_changed"), windowTitle: "Morning work" }
      ]);
      const view = readActivityDay(directory, date, {}, { now: new Date(at(600)) });
      assert.equal(view.entries.filter((entry) => entry.kind === "span").length, 1);
      assert.deepEqual(gaps(view.entries), []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
