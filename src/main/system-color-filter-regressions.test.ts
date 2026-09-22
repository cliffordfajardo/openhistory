import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SYSTEM_GRAYSCALE,
  SystemColorFilterController,
  type SystemColorFilterBinding,
  type SystemColorFilterSettings
} from "./system-color-filter";

class FakeBinding implements SystemColorFilterBinding {
  writes: SystemColorFilterSettings[] = [];
  constructor(public settings: SystemColorFilterSettings) {}
  read(): SystemColorFilterSettings { return { ...this.settings }; }
  write(settings: SystemColorFilterSettings): boolean {
    this.writes.push({ ...settings });
    this.settings = { ...settings };
    return true;
  }
}

function fixture(initial: SystemColorFilterSettings): {
  binding: FakeBinding;
  controller: SystemColorFilterController;
  journalPath: string;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "openhistory-filter-lifecycle-"));
  const journalPath = join(directory, "restore.json");
  const binding = new FakeBinding(initial);
  const controller = new SystemColorFilterController({ binding, journalPath });
  return { binding, controller, journalPath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("manual disable keeps filters off while restoring the original type", (t) => {
  const f = fixture({ enabled: false, type: 2 });
  t.after(f.cleanup);
  assert.equal(f.controller.apply(), true);
  f.binding.settings = { enabled: false, type: 1 };
  assert.equal(f.controller.restore(), true);
  assert.deepEqual(f.binding.settings, { enabled: false, type: 2 });
  assert.equal(existsSync(f.journalPath), false);
});

test("manual disable stays disabled even if original filter was enabled", (t) => {
  const f = fixture({ enabled: true, type: 2 });
  t.after(f.cleanup);
  assert.equal(f.controller.apply(), true);
  f.binding.settings = { enabled: false, type: 1 };
  assert.equal(f.controller.restore(), true);
  assert.deepEqual(f.binding.settings, { enabled: false, type: 2 });
});

test("manual type change preserves the entire current setting", (t) => {
  const f = fixture({ enabled: false, type: 2 });
  t.after(f.cleanup);
  assert.equal(f.controller.apply(), true);
  f.binding.settings = { enabled: true, type: 3 };
  const count = f.binding.writes.length;
  assert.equal(f.controller.restore(), true);
  assert.deepEqual(f.binding.settings, { enabled: true, type: 3 });
  assert.equal(f.binding.writes.length, count);
});

test("unreadable journal does not turn off possibly user-owned grayscale", (t) => {
  const f = fixture(SYSTEM_GRAYSCALE);
  t.after(f.cleanup);
  writeFileSync(f.journalPath, "{broken", "utf8");
  const controller = new SystemColorFilterController({ binding: f.binding, journalPath: f.journalPath });
  assert.equal(controller.view().phase, "restore_failed");
  assert.equal(controller.view().restorePending, true);
  assert.deepEqual(f.binding.writes, []);
  assert.equal(existsSync(f.journalPath), true);
});

test("unreadable journal is released without writing when settings differ", (t) => {
  const f = fixture({ enabled: false, type: 2 });
  t.after(f.cleanup);
  writeFileSync(f.journalPath, "{broken", "utf8");
  const controller = new SystemColorFilterController({ binding: f.binding, journalPath: f.journalPath });
  assert.equal(controller.view().restorePending, false);
  assert.deepEqual(f.binding.writes, []);
});

test("a repeated apply detects a manual override without re-enabling", (t) => {
  const f = fixture({ enabled: false, type: 2 });
  t.after(f.cleanup);
  assert.equal(f.controller.apply(), true);
  f.binding.settings = { enabled: false, type: 1 };
  assert.equal(f.controller.apply(), false);
  assert.deepEqual(f.binding.settings, { enabled: false, type: 2 });
  assert.equal(f.controller.view().failure, "apply_failed");
  assert.equal(existsSync(f.journalPath), false);
});

test("journal types outside the native signed range are not restored", (t) => {
  const f = fixture(SYSTEM_GRAYSCALE);
  t.after(f.cleanup);
  writeFileSync(f.journalPath, JSON.stringify({
    version: 1,
    baseline: { enabled: false, type: 0x8000_0000 },
    applied: SYSTEM_GRAYSCALE,
    writtenAt: new Date().toISOString()
  }));
  const controller = new SystemColorFilterController({ binding: f.binding, journalPath: f.journalPath });
  assert.equal(controller.view().phase, "restore_failed");
  assert.equal(controller.view().restorePending, true);
  assert.deepEqual(f.binding.writes, []);
  assert.ok(readFileSync(f.journalPath, "utf8"));
});
