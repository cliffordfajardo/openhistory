import { FOCUS_PROGRESS_COLOR_DEFAULT } from "@shared/focus";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { FocusStore } from "./focus-store";

function sequentialIds(): () => string {
  let next = 0;
  return () => `goal-0000000${(next += 1)}-test`;
}

test("starts empty, creates goals privately and selects the first one", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory, sequentialIds());
  assert.deepEqual(store.load(), {
    version: 1,
    goals: [],
    selectedGoalId: null,
    preferences: {
      domains: [],
      durationMinutes: 25,
      experience: "amber",
      amberEdge: true,
      barPresentation: "floating",
      showTimerBar: false,
      progressColor: FOCUS_PROGRESS_COLOR_DEFAULT
    },
    barPosition: null,
    barWidth: 460,
    barHeight: 54,
    session: null
  });

  const { goal } = store.saveGoal({ title: "  Ship\tthe   guide ", why: "Readers\r\nare waiting", currentFocus: "Outline" });
  assert.deepEqual(goal, {
    id: "goal-00000001-test",
    title: "Ship the guide",
    why: "Readers\nare waiting",
    currentFocus: "Outline"
  });
  const reloaded = new FocusStore(directory).load();
  assert.equal(reloaded.selectedGoalId, goal.id);
  assert.equal(reloaded.goals.length, 1);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
});

test("edits, selects and deletes goals without leaving a dangling selection", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory, sequentialIds());
  const first = store.saveGoal({ title: "First", why: "", currentFocus: "" }).goal;
  const second = store.saveGoal({ title: "Second", why: "", currentFocus: "" }).goal;
  store.saveGoal({ id: second.id, title: "Second, renamed", why: "Because", currentFocus: "Now" });
  store.selectGoal(second.id);
  assert.equal(store.goal(second.id)?.title, "Second, renamed");

  const afterDelete = store.deleteGoal(second.id);
  assert.equal(afterDelete.selectedGoalId, first.id);
  assert.equal(store.deleteGoal(first.id).selectedGoalId, null);
  assert.throws(() => store.deleteGoal(first.id), /no longer exists/);
  assert.throws(() => store.selectGoal("goal-00000099-test"), /no longer exists/);
  assert.throws(() => store.saveGoal({ id: "goal-00000099-test", title: "Ghost", why: "", currentFocus: "" }), /no longer exists/);
});

test("persists normalized distracting sites and duration", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory);
  store.savePreferences({
    domains: ["video.example", "social.example"],
    durationMinutes: 50,
    experience: "amber",
    amberEdge: true,
    barPresentation: "floating",
    showTimerBar: false,
    progressColor: FOCUS_PROGRESS_COLOR_DEFAULT
  });
  assert.deepEqual(new FocusStore(directory).load().preferences, {
    domains: ["social.example", "video.example"],
    durationMinutes: 50,
    experience: "amber",
    amberEdge: true,
    barPresentation: "floating",
    showTimerBar: false,
    progressColor: FOCUS_PROGRESS_COLOR_DEFAULT
  });
});

test("files from before the separate amber edge keep their look", async (context) => {
  for (const [experience, amberEdge] of [
    [undefined, true],
    ["amber", true],
    ["grayscale_window", false],
    ["grayscale_screen", false]
  ] as const) {
    const directory = await testDirectory(context);
    const legacy = JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: ["video.example"], durationMinutes: 25, ...(experience ? { experience } : {}) }
    });
    writeFileSync(resolve(directory, "focus.json"), legacy);
    const store = new FocusStore(directory);
    assert.equal(store.recoveredFromInvalidFile, false);
    assert.deepEqual(store.load().preferences, {
      domains: ["video.example"],
      durationMinutes: 25,
      experience: experience ?? "amber",
      amberEdge,
      barPresentation: "floating",
      showTimerBar: false,
      progressColor: FOCUS_PROGRESS_COLOR_DEFAULT
    }, String(experience));
    assert.equal(readFileSync(store.path, "utf8"), legacy, "reading never rewrites the file");
  }
});

test("persists the amber edge independently of the grayscale choice", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory);
  store.updatePreferences({ experience: "grayscale_system", amberEdge: false });
  store.updatePreferences({ experience: "grayscale_screen" });
  assert.deepEqual(new FocusStore(directory).load().preferences, {
    domains: [],
    durationMinutes: 25,
    experience: "grayscale_screen",
    amberEdge: false,
    barPresentation: "floating",
    showTimerBar: false,
    progressColor: FOCUS_PROGRESS_COLOR_DEFAULT
  });
});

test("a file written before the color could be chosen keeps the green, and a choice survives", async (context) => {
  const directory = await testDirectory(context);
  writeFileSync(resolve(directory, "focus.json"), JSON.stringify({
    version: 1,
    goals: [],
    selectedGoalId: null,
    preferences: { domains: ["video.example"], durationMinutes: 25, experience: "amber", amberEdge: true }
  }));
  const store = new FocusStore(directory);
  assert.equal(store.recoveredFromInvalidFile, false);
  assert.equal(store.load().preferences.progressColor, FOCUS_PROGRESS_COLOR_DEFAULT);

  store.updatePreferences({ progressColor: "#b86b5c" });
  assert.equal(new FocusStore(directory).load().preferences.progressColor, "#b86b5c");
  assert.deepEqual(new FocusStore(directory).load().preferences.domains, ["video.example"],
    "and choosing a color keeps everything else in the file");
});

test("a saved color the file cannot vouch for is refused with the rest of that file", async (context) => {
  const directory = await testDirectory(context);
  writeFileSync(resolve(directory, "focus.json"), JSON.stringify({
    version: 1,
    goals: [],
    selectedGoalId: null,
    preferences: {
      domains: [],
      durationMinutes: 25,
      experience: "amber",
      amberEdge: true,
      progressColor: "chartreuse"
    }
  }));
  const store = new FocusStore(directory);
  assert.equal(store.recoveredFromInvalidFile, true);
  assert.equal(store.load().preferences.progressColor, FOCUS_PROGRESS_COLOR_DEFAULT);
});

test("files from before the floating bar get it, and the choice survives a restart", async (context) => {
  const directory = await testDirectory(context);
  writeFileSync(resolve(directory, "focus.json"), JSON.stringify({
    version: 1,
    goals: [],
    selectedGoalId: null,
    preferences: { domains: ["video.example"], durationMinutes: 25, experience: "amber", amberEdge: true }
  }));
  const store = new FocusStore(directory);
  assert.equal(store.recoveredFromInvalidFile, false);
  assert.equal(store.load().preferences.barPresentation, "floating");
  assert.equal(store.load().barPosition, null);
  assert.equal(store.load().barWidth, 460, "a file written before resizing gets the compact width");
  assert.equal(store.load().barHeight, 54, "and the compact height it has always had");

  store.updatePreferences({ barPresentation: "menuBar" });
  assert.equal(new FocusStore(directory).load().preferences.barPresentation, "menuBar");
});

test("remembers where the floating bar was left and rounds the coordinates", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory);
  store.saveBarGeometry({ position: { x: 120.4, y: -33.6 } });
  assert.deepEqual(new FocusStore(directory).load().barPosition, { x: 120, y: -34 });
  store.saveBarGeometry({ position: null });
  assert.equal(new FocusStore(directory).load().barPosition, null);
  assert.throws(() => store.saveBarGeometry({ position: { x: Number.NaN, y: 0 } }));
  assert.throws(() => store.saveBarGeometry({ position: { x: 1e9, y: 0 } }));
});

test("remembers how big the floating bar was left, alongside where it was left", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory);
  store.saveBarGeometry({ position: { x: 0, y: 40 }, width: 1_512.6, height: 95.6 });
  const reloaded = new FocusStore(directory).load();
  assert.equal(reloaded.barWidth, 1_513, "the width is rounded like the coordinates");
  assert.equal(reloaded.barHeight, 96, "and so is the height");
  assert.deepEqual(reloaded.barPosition, { x: 0, y: 40 },
    "one resize saves the corner, the width and the height together");

  store.saveBarGeometry({ position: { x: 20, y: 40 } });
  const moved = new FocusStore(directory).load();
  assert.equal(moved.barWidth, 1_513, "a move on its own keeps the width");
  assert.equal(moved.barHeight, 96, "and the height");
  assert.throws(() => store.saveBarGeometry({ width: 10 }));
  assert.throws(() => store.saveBarGeometry({ width: 1e9 }));
  assert.throws(() => store.saveBarGeometry({ width: Number.NaN }));
  assert.throws(() => store.saveBarGeometry({ height: 10 }));
  assert.throws(() => store.saveBarGeometry({ height: 1e9 }));
  assert.throws(() => store.saveBarGeometry({ height: Number.NaN }));
  const untouched = new FocusStore(directory).load();
  assert.equal(untouched.barWidth, 1_513, "a rejected width never reaches the file");
  assert.equal(untouched.barHeight, 96, "and neither does a rejected height");
});

test("reads files saved before reminder styles as amber without losing goals or sites", async (context) => {
  const directory = await testDirectory(context);
  const legacy = JSON.stringify({
    version: 1,
    goals: [{ id: "goal-00000001-test", title: "Kept", why: "Because", currentFocus: "Now" }],
    selectedGoalId: "goal-00000001-test",
    preferences: { domains: ["video.example"], durationMinutes: 50 }
  });
  writeFileSync(resolve(directory, "focus.json"), legacy);
  const store = new FocusStore(directory);
  assert.equal(store.recoveredFromInvalidFile, false);
  assert.deepEqual(store.load(), {
    version: 1,
    goals: [{ id: "goal-00000001-test", title: "Kept", why: "Because", currentFocus: "Now" }],
    selectedGoalId: "goal-00000001-test",
    preferences: {
      domains: ["video.example"],
      durationMinutes: 50,
      experience: "amber",
      amberEdge: true,
      barPresentation: "floating",
      showTimerBar: false,
      progressColor: FOCUS_PROGRESS_COLOR_DEFAULT
    },
    barPosition: null,
    barWidth: 460,
    barHeight: 54,
    session: null
  });
  assert.equal(readFileSync(store.path, "utf8"), legacy, "reading never rewrites the file");
  assert.deepEqual(readdirSync(directory), ["focus.json"]);

  store.setExperience("grayscale_screen");
  const reloaded = new FocusStore(directory).load();
  assert.equal(reloaded.preferences.experience, "grayscale_screen");
  assert.deepEqual(reloaded.preferences.domains, ["video.example"]);
  assert.equal(reloaded.goals[0]?.title, "Kept");
  assert.equal(reloaded.version, 1);

  store.setExperience("grayscale_window");
  assert.equal(new FocusStore(directory).load().preferences.experience, "grayscale_window");
});

test("stores only the session's clock, and only when that clock moves", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory, sequentialIds());
  const goal = store.saveGoal({ title: "Goal", why: "", currentFocus: "" }).goal;
  const withoutSession = JSON.parse(readFileSync(store.path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(withoutSession).sort(),
    ["barHeight", "barPosition", "barWidth", "goals", "preferences", "selectedGoalId", "session", "version"]
  );
  assert.equal(withoutSession.session, null, "no session is saved until one runs");

  const running = {
    id: "session-1",
    goal,
    intention: "Write the intro",
    startedAt: "2026-09-23T10:00:00.000Z",
    endsAt: "2026-09-23T10:25:00.000Z",
    totalMs: 1_500_000,
    pausedRemainingMs: null,
    snoozedUntil: null
  };
  store.saveSession(running);
  assert.deepEqual(new FocusStore(directory).load().session, running);
  const stored = JSON.parse(readFileSync(store.path, "utf8")) as { session: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(stored.session).sort(),
    ["endsAt", "goal", "id", "intention", "pausedRemainingMs", "snoozedUntil", "startedAt", "totalMs"],
    "nothing about the foreground, the reminders or the panels is saved"
  );

  writeFileSync(store.path, "still the same file");
  for (let repeat = 0; repeat < 5; repeat += 1) store.saveSession({ ...running });
  assert.equal(readFileSync(store.path, "utf8"), "still the same file",
    "an unchanged clock never touches the disk");

  store.saveSession({ ...running, endsAt: null, pausedRemainingMs: 900_000 });
  assert.equal(new FocusStore(directory).load().session?.pausedRemainingMs, 900_000);
  store.saveSession(null);
  assert.equal(new FocusStore(directory).load().session, null);
});

test("refuses a saved session that is not exactly one clock", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory, sequentialIds());
  const goal = store.saveGoal({ title: "Goal", why: "", currentFocus: "" }).goal;
  const valid = {
    id: "session-1",
    goal,
    intention: "",
    startedAt: "2026-09-23T10:00:00.000Z",
    endsAt: "2026-09-23T10:25:00.000Z",
    totalMs: 1_500_000,
    pausedRemainingMs: null,
    snoozedUntil: null
  };
  assert.throws(() => store.saveSession({ ...valid, pausedRemainingMs: 900_000 }), "two clocks");
  assert.throws(() => store.saveSession({ ...valid, endsAt: null }), "no clock at all");
  assert.throws(() => store.saveSession({ ...valid, endsAt: "whenever" }));
  assert.throws(() => store.saveSession({ ...valid, totalMs: 0 }));
  assert.throws(() => store.saveSession({
    ...valid,
    endsAt: null,
    pausedRemainingMs: valid.totalMs + 1
  }), "more time left than the session was ever given");
  assert.equal(new FocusStore(directory).load().session, null, "no rejected session reaches the file");
});

test("a malformed saved session is dropped without losing goals or preferences", async (context) => {
  const directory = await testDirectory(context);
  writeFileSync(resolve(directory, "focus.json"), JSON.stringify({
    version: 1,
    goals: [{ id: "goal-00000001-test", title: "Kept", why: "", currentFocus: "" }],
    selectedGoalId: "goal-00000001-test",
    preferences: { domains: ["video.example"], durationMinutes: 50, amberEdge: true },
    session: { id: "session-1", goal: "gone", totalMs: "forever" }
  }));
  const store = new FocusStore(directory, sequentialIds(), () => 4321);
  assert.equal(store.recoveredFromInvalidFile, false, "a bad session never quarantines a good file");
  assert.equal(store.load().session, null);
  assert.equal(store.load().goals[0]?.title, "Kept");
  assert.deepEqual(store.load().preferences.domains, ["video.example"]);
  assert.deepEqual(readdirSync(directory), ["focus.json"]);
});

test("recovers from malformed files by starting fresh and preserving the original", async (context) => {
  for (const contents of [
    "{not json",
    JSON.stringify({ version: 2, goals: [] }),
    JSON.stringify({
      version: 1,
      goals: [{ id: "../../escape", title: "x", why: "", currentFocus: "" }],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25 }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: ["javascript:alert(1)"], durationMinutes: 25 }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 100_000 }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, experience: "sepia" }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: "yes" }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: true, barPresentation: "hud" }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: true },
      barPosition: { x: "left", y: 0 }
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: true },
      barWidth: 40
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: true },
      barWidth: "wide"
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: true },
      barHeight: 10
    }),
    JSON.stringify({
      version: 1,
      goals: [],
      selectedGoalId: null,
      preferences: { domains: [], durationMinutes: 25, amberEdge: true },
      barHeight: "tall"
    })
  ]) {
    const directory = await testDirectory(context);
    writeFileSync(resolve(directory, "focus.json"), contents);
    const store = new FocusStore(directory, sequentialIds(), () => 1234);
    assert.equal(store.recoveredFromInvalidFile, true);
    assert.deepEqual(store.load().goals, []);
    assert.equal(readFileSync(resolve(directory, "focus.json.invalid-1234"), "utf8"), contents);
    store.saveGoal({ title: "New start", why: "", currentFocus: "" });
    assert.equal(readFileSync(resolve(directory, "focus.json.invalid-1234"), "utf8"), contents);
  }
});

test("drops a selection that points at a missing goal", async (context) => {
  const directory = await testDirectory(context);
  writeFileSync(resolve(directory, "focus.json"), JSON.stringify({
    version: 1,
    goals: [{ id: "goal-00000001-test", title: "Kept", why: "", currentFocus: "" }],
    selectedGoalId: "goal-00000002-test",
    preferences: { domains: [], durationMinutes: 25 }
  }));
  const store = new FocusStore(directory);
  assert.equal(store.recoveredFromInvalidFile, false);
  assert.equal(store.load().selectedGoalId, null);
});

test("refuses to follow a symbolic link in place of the Focus file", async (context) => {
  const directory = await testDirectory(context);
  const outside = resolve(directory, "outside.json");
  writeFileSync(outside, JSON.stringify({ secret: true }));
  symlinkSync(outside, resolve(directory, "focus.json"));
  const store = new FocusStore(directory, sequentialIds(), () => 99);
  assert.equal(store.recoveredFromInvalidFile, true);
  assert.deepEqual(store.load().goals, []);
  assert.equal(readFileSync(outside, "utf8"), JSON.stringify({ secret: true }));
  assert(readdirSync(directory).includes("focus.json.invalid-99"));
});

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "openhistory-focus-store-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
