import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FOREGROUND_EVIDENCE_PREFIX } from "../src/main/foreground-evidence";

interface NativeBridge {
  startCollector(dataDirectory: string, configurationJSON: string, onEvent: (line: string) => void): boolean;
  stopCollector(): void;
  isTrusted(): boolean;
  setForegroundObservation(generation: number): boolean;
  showFocusOverlay(requestJSON: string): number;
  hideFocusOverlay(nudgeId: string, immediate: boolean): void;
  setFocusOverlayActionHandler(handler: ((line: string) => void) | null): void;
  updateFocusBar(snapshotJSON: string): number;
  hideFocusBar(): void;
  focusFocusBar(): void;
  setFocusBarActionHandler(handler: ((line: string) => void) | null): void;
  screenCaptureAccess(): boolean;
  requestScreenCaptureAccess(): boolean;
  systemColorFilterRead(): { enabled: boolean; type: number } | null;
  systemColorFilterWrite(enabled: boolean, type: number): boolean;
}

const root = resolve(import.meta.dirname, "..");
const modulePath = resolve(root, ".todesktop", "native", arch() === "x64" ? "x64" : "arm64", "openhistory-native.node");
const require = createRequire(import.meta.url);
const bridge = require(modulePath) as NativeBridge;
const dataDirectory = join(mkdtempSync(join(tmpdir(), "openhistory-focus-bridge-smoke-")), "activity-data");
const lines: string[] = [];

try {
  for (const name of [
    "startCollector", "stopCollector", "setForegroundObservation",
    "showFocusOverlay", "hideFocusOverlay", "setFocusOverlayActionHandler",
    "updateFocusBar", "hideFocusBar", "focusFocusBar", "setFocusBarActionHandler",
    "screenCaptureAccess", "requestScreenCaptureAccess", "systemColorFilterRead", "systemColorFilterWrite"
  ] as const) {
    assert.equal(typeof bridge[name], "function", `bridge is missing ${name}`);
  }
  // Read only: writing would change the person's persisted Color Filters settings.
  const colorFilters = bridge.systemColorFilterRead();
  assert(colorFilters === null ||
    (typeof colorFilters.enabled === "boolean" && Number.isInteger(colorFilters.type)),
    "Color Filters must read as settings, or null where the private setting is unavailable");
  // Never call requestScreenCaptureAccess here: it may show the system prompt.
  const screenCaptureAccess = bridge.screenCaptureAccess();
  assert.equal(typeof screenCaptureAccess, "boolean");
  assert.equal(bridge.showFocusOverlay(JSON.stringify({
    nudgeId: "smoke-style", sessionId: null, title: "Smoke", message: "",
    expectedProcessIdentifier: null, preview: true, experience: "sepia"
  })), 1, "an unknown reminder style must be rejected");
  assert.equal(bridge.showFocusOverlay(JSON.stringify({
    nudgeId: "smoke-gray",
    sessionId: "session-smoke",
    title: "Smoke",
    message: "",
    expectedProcessIdentifier: 1,
    preview: false,
    experience: "grayscale_screen"
  })), 4, "a grayscale reminder for a process that is not frontmost must be refused before capture");
  assert.equal(bridge.showFocusOverlay(JSON.stringify({
    nudgeId: "smoke-system",
    sessionId: "session-smoke",
    title: "Smoke",
    message: "",
    expectedProcessIdentifier: 1,
    preview: false,
    experience: "grayscale_system",
    amberEdge: false
  })), 4, "a system grayscale reminder is a valid request and still requires the expected foreground process");
  const windowRequest = {
    nudgeId: "smoke-window",
    sessionId: "session-smoke",
    title: "Smoke",
    message: "",
    expectedProcessIdentifier: 1,
    preview: false,
    experience: "grayscale_window"
  };
  assert.equal(bridge.showFocusOverlay(JSON.stringify(windowRequest)), 1,
    "a window reminder without its site rule must be rejected");
  assert.equal(bridge.showFocusOverlay(JSON.stringify({ ...windowRequest, domain: "video.example" })), 4,
    "a window reminder for a process that is not frontmost must be refused before capture");

  assert.throws(() => bridge.setForegroundObservation(-1), TypeError);
  assert.throws(() => bridge.showFocusOverlay(42 as unknown as string), TypeError);
  assert.equal(bridge.showFocusOverlay("{not json"), 1, "malformed overlay request must be rejected");
  assert.equal(bridge.showFocusOverlay(JSON.stringify({
    nudgeId: "", sessionId: null, title: "", message: "", expectedProcessIdentifier: null, preview: false
  })), 1, "empty overlay request must be rejected");
  assert.equal(bridge.showFocusOverlay(JSON.stringify({
    nudgeId: "smoke-1",
    sessionId: "session-smoke",
    title: "Smoke",
    message: "",
    expectedProcessIdentifier: 1,
    preview: false
  })), 4, "a reminder for a process that is not frontmost must be refused");
  bridge.hideFocusOverlay("smoke-1", true);
  bridge.setFocusOverlayActionHandler(() => undefined);
  bridge.setFocusOverlayActionHandler(null);

  // Only malformed bar snapshots are sent: a valid one would put a panel on the person's screen.
  const barSnapshot = {
    sessionId: "session-smoke",
    goalTitle: "Smoke",
    intention: "",
    endsAtEpochSeconds: Math.round(Date.now() / 1_000) + 600,
    pausedRemainingSeconds: null,
    totalSeconds: 600,
    snoozed: false,
    position: null
  };
  assert.throws(() => bridge.updateFocusBar(42 as unknown as string), TypeError);
  assert.equal(bridge.updateFocusBar("{not json"), 1, "a malformed bar snapshot must be rejected");
  assert.equal(bridge.updateFocusBar("{}"), 1, "an incomplete bar snapshot must be rejected");
  assert.equal(bridge.updateFocusBar(JSON.stringify({ ...barSnapshot, sessionId: "" })), 1,
    "a bar snapshot without a session must be rejected");
  assert.equal(bridge.updateFocusBar(JSON.stringify({ ...barSnapshot, pausedRemainingSeconds: 600 })), 1,
    "a snapshot that is both running and paused must be rejected");
  assert.equal(bridge.updateFocusBar(JSON.stringify({ ...barSnapshot, totalSeconds: 0 })), 1,
    "a bar snapshot without a length must be rejected");
  assert.equal(bridge.updateFocusBar(JSON.stringify({
    ...barSnapshot,
    position: { x: 1e9, y: 0 }
  })), 1, "a bar position far outside any display must be rejected");
  bridge.hideFocusBar();
  bridge.setFocusBarActionHandler(() => undefined);
  bridge.setFocusBarActionHandler(null);

  const started = bridge.startCollector(dataDirectory, JSON.stringify({
    captureWindowTitles: false,
    captureFocusedElements: false,
    captureTextInput: false,
    capturePointerClicks: false,
    captureBrowserURLs: false,
    captureDocumentContext: false,
    captureUISnapshots: false,
    captureEmailActivity: false,
    captureMessagingActivity: false,
    excludedBundleIdentifiers: [],
    excludedProcessIdentifiers: [process.pid]
  }), (line) => lines.push(line));
  assert.equal(started, true);
  assert.equal(bridge.setForegroundObservation(7), true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));

  const activity = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { kind: string });
  const evidence = lines
    .filter((line) => line.startsWith(FOREGROUND_EVIDENCE_PREFIX))
    .map((line) => JSON.parse(line.slice(FOREGROUND_EVIDENCE_PREFIX.length)) as {
      generation: number; kind: string; reason?: string; domain?: string;
    });
  assert(activity.some((event) => event.kind === "collector_started"), "collector_started did not arrive through the callback");
  assert(evidence.length > 0, "no tagged foreground evidence arrived through the callback");
  assert(evidence.every((packet) => packet.generation === 7), "evidence must carry the requested generation");
  assert(evidence.every((packet) => packet.kind === "unknown" && !packet.domain),
    "with browser URL capture off, evidence must never carry a site");

  const persisted = readdirSync(dataDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dataDirectory, name), "utf8"))
    .join("");
  assert(!persisted.includes(FOREGROUND_EVIDENCE_PREFIX) && !persisted.includes("\"generation\""),
    "foreground evidence must never be written to activity files");

  bridge.setForegroundObservation(0);
  process.stdout.write(`Native bridge smoke passed: ${activity.map((event) => event.kind).join(", ")}; ` +
    `evidence ${evidence.map((packet) => packet.reason ?? packet.kind).join(", ")}; ` +
    `accessibility trusted: ${bridge.isTrusted()}; screen recording allowed: ${screenCaptureAccess}; ` +
    `color filters readable: ${colorFilters !== null}\n`);
} finally {
  bridge.stopCollector();
  rmSync(resolve(dataDirectory, ".."), { recursive: true, force: true });
}
