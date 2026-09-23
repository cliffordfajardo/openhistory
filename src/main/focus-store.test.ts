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
      barPresentation: "floating"
    },
    barPosition: null,
    barWidth: 460
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
    barPresentation: "floating"
  });
  assert.deepEqual(new FocusStore(directory).load().preferences, {
    domains: ["social.example", "video.example"],
    durationMinutes: 50,
    experience: "amber",
    amberEdge: true,
    barPresentation: "floating"
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
      barPresentation: "floating"
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
    barPresentation: "floating"
  });
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

test("remembers how wide the floating bar was left, alongside where it was left", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory);
  store.saveBarGeometry({ position: { x: 0, y: 40 }, width: 1_512.6 });
  const reloaded = new FocusStore(directory).load();
  assert.equal(reloaded.barWidth, 1_513, "the width is rounded like the coordinates");
  assert.deepEqual(reloaded.barPosition, { x: 0, y: 40 }, "one resize saves the corner and the width together");

  store.saveBarGeometry({ position: { x: 20, y: 40 } });
  assert.equal(new FocusStore(directory).load().barWidth, 1_513, "a move on its own keeps the width");
  assert.throws(() => store.saveBarGeometry({ width: 10 }));
  assert.throws(() => store.saveBarGeometry({ width: 1e9 }));
  assert.throws(() => store.saveBarGeometry({ width: Number.NaN }));
  assert.equal(new FocusStore(directory).load().barWidth, 1_513, "a rejected width never reaches the file");
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
      barPresentation: "floating"
    },
    barPosition: null,
    barWidth: 460
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

test("never stores an active session", async (context) => {
  const directory = await testDirectory(context);
  const store = new FocusStore(directory, sequentialIds());
  store.saveGoal({ title: "Goal", why: "", currentFocus: "" });
  const stored = JSON.parse(readFileSync(store.path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["barPosition", "barWidth", "goals", "preferences", "selectedGoalId", "version"]
  );
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
