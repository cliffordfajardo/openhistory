import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  SYSTEM_GRAYSCALE,
  SystemColorFilterController,
  type SystemColorFilterBinding,
  type SystemColorFilterSettings
} from "./system-color-filter";

/** Stands in for the persisted macOS setting. */
class FakeColorFilters implements SystemColorFilterBinding {
  writes: SystemColorFilterSettings[] = [];
  readable = true;
  writable = true;
  journalAtWrite: boolean[] = [];
  journalPath?: string;

  constructor(public settings: SystemColorFilterSettings = { enabled: false, type: 1 }) {}

  read(): SystemColorFilterSettings | null {
    return this.readable ? { ...this.settings } : null;
  }

  write(settings: SystemColorFilterSettings): boolean {
    if (this.journalPath) this.journalAtWrite.push(existsSync(this.journalPath));
    this.writes.push({ ...settings });
    if (!this.writable) return false;
    this.settings = { ...settings };
    return true;
  }
}

async function journalPath(context: TestContext): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "openhistory-color-filter-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return resolve(directory, "restore.json");
}

async function owner(context: TestContext, filters: FakeColorFilters) {
  const path = await journalPath(context);
  filters.journalPath = path;
  return { path, filter: new SystemColorFilterController({ binding: filters, journalPath: path }) };
}

test("journals the earlier settings before writing grayscale, then restores them exactly", async (context) => {
  for (const before of [{ enabled: false, type: 1 }, { enabled: true, type: 2 }, { enabled: false, type: 16 }]) {
    const filters = new FakeColorFilters(before);
    const { path, filter } = await owner(context, filters);
    assert.equal(filter.apply(), true);
    assert.deepEqual(filters.settings, SYSTEM_GRAYSCALE);
    assert.deepEqual(filters.journalAtWrite, [true], "the journal exists before the first write");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).baseline, before);
    assert.equal(filter.view().phase, "applied");

    assert.equal(filter.apply(), true);
    assert.equal(filters.writes.length, 1, "a repeated turn-on neither rewrites nor rejournals");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).baseline, before);

    assert.equal(filter.restore(), true);
    assert.deepEqual(filters.settings, before);
    assert.equal(existsSync(path), false);
    assert.deepEqual(filter.view(), { available: true, phase: "idle", failure: null, restorePending: false });
  }
});

test("settings already grayscale are left alone with nothing to restore", async (context) => {
  const filters = new FakeColorFilters({ ...SYSTEM_GRAYSCALE });
  const { path, filter } = await owner(context, filters);
  assert.equal(filter.apply(), true);
  assert.equal(filter.restore(), true);
  assert.deepEqual(filters.writes, []);
  assert.equal(existsSync(path), false);
  assert.deepEqual(filters.settings, SYSTEM_GRAYSCALE);
});

test("a change the person made while grayscale was on is kept", async (context) => {
  const filters = new FakeColorFilters({ enabled: false, type: 1 });
  const { path, filter } = await owner(context, filters);
  filter.apply();
  filters.settings = { enabled: true, type: 8 };
  assert.equal(filter.restore(), true);
  assert.deepEqual(filters.settings, { enabled: true, type: 8 });
  assert.equal(filters.writes.length, 1);
  assert.equal(existsSync(path), false);
  assert.equal(filter.view().phase, "idle");
});

test("a failed restore keeps the journal, blocks new turn-ons and succeeds on retry", async (context) => {
  const filters = new FakeColorFilters({ enabled: true, type: 4 });
  const { path, filter } = await owner(context, filters);
  filter.apply();
  filters.writable = false;
  assert.equal(filter.restore(), false);
  assert.deepEqual(filter.view(), { available: true, phase: "restore_failed", failure: null, restorePending: true });
  assert.equal(existsSync(path), true);
  assert.equal(filter.apply(), false, "no turn-on while earlier settings wait");

  filters.readable = false;
  assert.equal(filter.restore(), false);
  filters.readable = true;
  filters.writable = true;
  assert.equal(filter.restore(), true);
  assert.deepEqual(filters.settings, { enabled: true, type: 4 });
  assert.equal(existsSync(path), false);
});

test("failed turn-ons change nothing and say why", async (context) => {
  const filters = new FakeColorFilters();
  const { path, filter } = await owner(context, filters);
  filters.writable = false;
  assert.equal(filter.apply(), false);
  assert.deepEqual(filter.view(), { available: true, phase: "idle", failure: "apply_failed", restorePending: false });
  assert.equal(existsSync(path), false);

  filters.writable = true;
  filters.readable = false;
  assert.equal(filter.apply(), false);
  assert.deepEqual(filters.settings, { enabled: false, type: 1 });

  filters.readable = true;
  const unwritable = resolve(path, "..", "missing-directory", "restore.json");
  const blocked = new SystemColorFilterController({ binding: filters, journalPath: unwritable });
  assert.equal(blocked.apply(), false);
  assert.equal(blocked.view().failure, "journal_unwritable");
  assert.equal(filters.writes.length, 1, "nothing is written without a journal");

  assert.equal(filter.apply(), true);
  assert.equal(filter.view().failure, null);
});

test("a write that half-applied is rolled back", async (context) => {
  const filters = new FakeColorFilters({ enabled: false, type: 2 });
  const { path, filter } = await owner(context, filters);
  filters.write = (settings) => {
    filters.writes.push({ ...settings });
    if (filters.writes.length === 1) {
      filters.settings = { enabled: true, type: 2 };
      return false;
    }
    filters.settings = { ...settings };
    return true;
  };
  assert.equal(filter.apply(), false);
  assert.deepEqual(filters.settings, { enabled: false, type: 2 });
  assert.equal(existsSync(path), false);
  assert.equal(filter.view().phase, "idle");
});

test("a journal from an earlier launch is restored on creation before any turn-on", async (context) => {
  const path = await journalPath(context);
  const first = new FakeColorFilters({ enabled: true, type: 16 });
  new SystemColorFilterController({ binding: first, journalPath: path }).apply();
  assert.equal(existsSync(path), true, "a crash leaves the journal");

  const unavailable = new FakeColorFilters(first.settings);
  unavailable.readable = false;
  const offline = new SystemColorFilterController({ binding: unavailable, journalPath: path });
  assert.deepEqual(offline.view(), { available: false, phase: "restore_failed", failure: null, restorePending: true });
  assert.equal(existsSync(path), true, "kept while the setting can't be read");
  assert.deepEqual(
    new SystemColorFilterController({ binding: undefined, journalPath: path }).view().phase,
    "restore_failed"
  );

  const relaunched = new FakeColorFilters(first.settings);
  const filter = new SystemColorFilterController({ binding: relaunched, journalPath: path });
  assert.deepEqual(relaunched.settings, { enabled: true, type: 16 });
  assert.equal(existsSync(path), false);
  assert.equal(filter.view().phase, "idle");
});

test("an unreadable journal reports failed restoration without guessing the previous settings", async (context) => {
  const path = await journalPath(context);
  writeFileSync(path, "{not json");
  const filters = new FakeColorFilters({ ...SYSTEM_GRAYSCALE });
  const filter = new SystemColorFilterController({ binding: filters, journalPath: path });
  assert.deepEqual(filters.settings, SYSTEM_GRAYSCALE);
  assert.equal(filter.view().phase, "restore_failed");
  assert.equal(existsSync(path), true);
});

test("shutdown restores and refuses later turn-ons; unsupported never writes", async (context) => {
  const filters = new FakeColorFilters();
  const { filter } = await owner(context, filters);
  filter.apply();
  filter.shutdown();
  assert.deepEqual(filters.settings, { enabled: false, type: 1 });
  assert.equal(filter.apply(), false);

  const missing = new FakeColorFilters();
  missing.readable = false;
  const unsupported = new SystemColorFilterController({ binding: missing, journalPath: await journalPath(context) });
  assert.deepEqual(unsupported.view(), { available: false, phase: "unsupported", failure: null, restorePending: false });
  assert.equal(unsupported.apply(), false);
  assert.deepEqual(missing.writes, []);
});
