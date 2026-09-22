import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { CollectorService, type NativeCollectorBinding } from "./collector-service";
import { FOREGROUND_EVIDENCE_PREFIX } from "./foreground-evidence";
import { DEFAULT_COLLECTION_SETTINGS } from "./settings-store";

class FakeNativeCollector implements NativeCollectorBinding {
  starts: Array<{ dataDirectory: string; configuration: Record<string, unknown> }> = [];
  stopCount = 0;
  requestCount = 0;
  trusted = true;
  observations: number[] = [];
  onEvent?: (line: string) => void;

  setForegroundObservation(generation: number): boolean {
    this.observations.push(generation);
    return true;
  }

  startCollector(
    dataDirectory: string,
    configurationJSON: string,
    onEvent: (line: string) => void
  ): boolean {
    this.onEvent = onEvent;
    this.starts.push({
      dataDirectory,
      configuration: JSON.parse(configurationJSON) as Record<string, unknown>
    });
    onEvent(JSON.stringify({
      version: 1,
      id: `collector-start-${this.starts.length}`,
      timestamp: "2026-08-16T12:00:00Z",
      kind: "collector_started",
      accessibilityTrusted: this.trusted
    }));
    return true;
  }

  stopCollector(): void {
    this.stopCount += 1;
  }

  isTrusted(): boolean {
    return this.trusted;
  }

  requestTrust(): boolean {
    this.requestCount += 1;
    return this.trusted;
  }
}

test("runs the collector inside the host identity and forwards native events", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  const collector = new CollectorService(directory, {
    ...DEFAULT_COLLECTION_SETTINGS,
    captureEmailActivity: true,
    captureMessagingActivity: true
  }, native);
  context.after(() => collector.stop());

  const eventKinds: string[] = [];
  collector.on("event", (event) => eventKinds.push(event.kind));
  collector.start();

  assert.equal(collector.state, "running");
  assert.equal(collector.accessibilityTrusted, true);
  assert.deepEqual(eventKinds, ["collector_started"]);
  assert.equal(native.starts.length, 1);
  const start = native.starts[0];
  assert(start);
  assert.equal(start.dataDirectory, directory);
  assert.deepEqual(start.configuration.excludedProcessIdentifiers, [process.pid]);
  assert.equal(start.configuration.captureEmailActivity, true);
  assert.equal(start.configuration.captureMessagingActivity, true);
});

test("restarts the embedded collector when settings change", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  const collector = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  context.after(() => collector.stop());

  collector.start();
  collector.setSettings({
    ...DEFAULT_COLLECTION_SETTINGS,
    captureTextInput: false
  });

  assert.equal(native.stopCount, 1);
  assert.equal(native.starts.length, 2);
  const restart = native.starts[1];
  assert(restart);
  assert.equal(restart.configuration.captureTextInput, false);
});

test("requests Accessibility through the host process bridge", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  const collector = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  context.after(() => collector.stop());

  collector.requestAccessibilityPermission();

  assert.equal(native.requestCount, 1);
});

test("refreshes Accessibility state and restarts capture when access changes", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  native.trusted = false;
  const collector = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  context.after(() => collector.stop());
  collector.start();

  native.trusted = true;
  assert.equal(collector.refreshAccessibilityPermission(), true);

  assert.equal(collector.accessibilityTrusted, true);
  assert.equal(native.stopCount, 1);
  assert.equal(native.starts.length, 2);
});

function evidencePacket(generation: number, domain = "video.example"): string {
  return `${FOREGROUND_EVIDENCE_PREFIX}${JSON.stringify({
    kind: "browser",
    generation,
    sequence: 1,
    observedAt: Date.now(),
    processIdentifier: 501,
    bundleIdentifier: "com.apple.Safari",
    domain
  })}`;
}

test("routes tagged foreground evidence separately from persisted activity", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  const collector = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  context.after(() => collector.stop());
  const events: string[] = [];
  const evidence: unknown[] = [];
  collector.on("event", (event) => events.push(event.kind));
  collector.on("foreground", (packet) => evidence.push(packet));
  collector.start();
  collector.setForegroundObservation(4);
  assert.deepEqual(native.observations, [4]);

  native.onEvent?.(evidencePacket(4));
  native.onEvent?.(evidencePacket(3));
  native.onEvent?.(`${FOREGROUND_EVIDENCE_PREFIX}{"kind":"browser"}`);

  assert.equal(evidence.length, 1, "only the current observation generation is forwarded");
  assert.deepEqual(events, ["collector_started"], "evidence is never treated as an activity event");
  assert.equal(collector.recentEvents.some((event) => event.kind !== "collector_started"), false);
});

test("drops evidence from a collector generation that has been restarted", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  const collector = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  context.after(() => collector.stop());
  const resets: number[] = [];
  const evidence: unknown[] = [];
  collector.on("foregroundReset", () => resets.push(1));
  collector.on("foreground", (packet) => evidence.push(packet));
  collector.setForegroundObservation(2);
  collector.start();
  const staleCallback = native.onEvent!;
  collector.setSettings({ ...DEFAULT_COLLECTION_SETTINGS });
  staleCallback(evidencePacket(2));
  assert.equal(evidence.length, 0);
  assert(resets.length >= 2, "start and restart both reset Focus evidence");

  collector.setEnabled(false);
  native.onEvent?.(evidencePacket(2));
  assert.equal(evidence.length, 0, "no evidence is accepted while paused");
});

test("forwards Gmail host to Focus while withholding Gmail activity", async (context) => {
  const directory = await testDirectory(context);
  const native = new FakeNativeCollector();
  const collector = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  context.after(() => collector.stop());
  const events: string[] = [];
  const evidence: unknown[] = [];
  collector.on("event", (event) => events.push(event.kind));
  collector.on("foreground", (value) => evidence.push(value));
  collector.start();
  collector.setForegroundObservation(1);
  native.onEvent?.(evidencePacket(1, "mail.google.com"));
  native.onEvent?.(JSON.stringify({
    version: 1, id: "gmail-activity", timestamp: "2026-08-16T12:00:01Z",
    kind: "url_changed",
    application: { bundleIdentifier: "com.apple.Safari", localizedName: "Safari", processIdentifier: 501 },
    browser: { url: "https://mail.google.com/mail/u/0/#inbox", domain: "mail.google.com" }
  }));
  assert.equal(evidence.length, 1);
  assert.equal((evidence[0] as { domain?: string }).domain, "mail.google.com");
  assert.deepEqual(events, ["collector_started"]);
  assert.equal(collector.recentEvents.some((event) => event.id === "gmail-activity"), false);
  assert.doesNotMatch(JSON.stringify(collector.recentEvents), /mail\.google\.com|inbox/);
});

test("exposes the native reminder only when the bridge provides it", async (context) => {
  const directory = await testDirectory(context);
  const withoutOverlay = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, new FakeNativeCollector());
  assert.equal(withoutOverlay.focusOverlay(), undefined);

  const requests: string[] = [];
  const native = Object.assign(new FakeNativeCollector(), {
    showFocusOverlay: (json: string) => {
      requests.push(json);
      return 3;
    },
    hideFocusOverlay: () => undefined,
    setFocusOverlayActionHandler: () => undefined
  });
  const overlay = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native).focusOverlay();
  assert(overlay);
  assert.equal(overlay.show({
    nudgeId: "preview-1",
    sessionId: null,
    title: "Title",
    message: "",
    expectedProcessIdentifier: null,
    preview: true,
    experience: "amber",
    amberEdge: true
  }), "no_display");
  assert.equal((JSON.parse(requests[0]!) as { nudgeId: string }).nudgeId, "preview-1");
});

test("exposes Color Filters only when the bridge has both calls, passing settings as arguments", async (context) => {
  const directory = await testDirectory(context);
  const readOnly = Object.assign(new FakeNativeCollector(), { systemColorFilterRead: () => null });
  assert.equal(new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, readOnly).focusSystemFilter(), undefined);

  const writes: unknown[][] = [];
  const binding = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, Object.assign(new FakeNativeCollector(), {
    systemColorFilterRead: () => ({ enabled: false, type: 2 }),
    systemColorFilterWrite: (...args: unknown[]) => {
      writes.push(args);
      return true;
    }
  })).focusSystemFilter();
  assert(binding);
  assert.deepEqual(binding.read(), { enabled: false, type: 2 });
  assert.equal(binding.write({ enabled: true, type: 1 }), true);
  assert.deepEqual(writes, [[true, 1]]);
});

test("exposes Screen Recording access only when the bridge supports grayscale", async (context) => {
  const directory = await testDirectory(context);
  const overlayFunctions = {
    showFocusOverlay: () => 5,
    hideFocusOverlay: () => undefined,
    setFocusOverlayActionHandler: () => undefined
  };
  const withoutCapture = new CollectorService(
    directory,
    DEFAULT_COLLECTION_SETTINGS,
    Object.assign(new FakeNativeCollector(), overlayFunctions)
  );
  assert.equal(withoutCapture.focusScreenCapture(), undefined, "an older bridge would ignore grayscale requests");
  const withoutOverlay = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, Object.assign(new FakeNativeCollector(), {
    screenCaptureAccess: () => true,
    requestScreenCaptureAccess: () => true
  }));
  assert.equal(withoutOverlay.focusScreenCapture(), undefined);

  let requests = 0;
  const native = Object.assign(new FakeNativeCollector(), overlayFunctions, {
    screenCaptureAccess: () => false,
    requestScreenCaptureAccess: () => {
      requests += 1;
      return false;
    }
  });
  const service = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, native);
  const capture = service.focusScreenCapture();
  assert(capture);
  assert.equal(capture.access(), false);
  assert.equal(requests, 0, "checking access never prompts");
  assert.equal(capture.request(), false);
  assert.equal(requests, 1);
  assert.equal(service.focusOverlay()?.show({
    nudgeId: "preview-2",
    sessionId: null,
    title: "Title",
    message: "",
    expectedProcessIdentifier: null,
    preview: true,
    experience: "grayscale_screen",
    amberEdge: false
  }), "shown_fallback_permission");

  const windowRequests: string[] = [];
  for (const [code, result] of [[7, "shown_fallback_window"], [8, "shown_fallback_window_spans_displays"]] as const) {
    const windowService = new CollectorService(directory, DEFAULT_COLLECTION_SETTINGS, Object.assign(new FakeNativeCollector(), {
      ...overlayFunctions,
      showFocusOverlay: (json: string) => {
        windowRequests.push(json);
        return code;
      }
    }));
    assert.equal(windowService.focusOverlay()?.show({
      nudgeId: "nudge-1",
      sessionId: "session-1",
      title: "Title",
      message: "",
      expectedProcessIdentifier: 501,
      preview: false,
      experience: "grayscale_window",
      amberEdge: true,
      domain: "video.example"
    }), result);
  }
  assert.equal((JSON.parse(windowRequests[0]!) as { domain: string }).domain, "video.example");
});

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "openhistory-collector-service-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
