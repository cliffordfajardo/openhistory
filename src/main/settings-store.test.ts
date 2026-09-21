import type { CollectionSettings } from "../shared/contracts";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_COLLECTION_SETTINGS, SettingsStore } from "./settings-store";

test("uses privacy defaults before settings are saved", async (context) => {
  const directory = await testDirectory(context);
  assert.deepEqual(new SettingsStore(directory).load(), DEFAULT_COLLECTION_SETTINGS);
});

test("defaults to minimal capture: app activation, window titles and browser addresses only", () => {
  assert.equal(DEFAULT_COLLECTION_SETTINGS.captureWindowTitles, true);
  assert.equal(DEFAULT_COLLECTION_SETTINGS.captureBrowserURLs, true);
  for (const key of [
    "captureFocusedElements",
    "captureTextInput",
    "capturePointerClicks",
    "captureDocumentContext",
    "captureUISnapshots",
    "captureEmailActivity",
    "captureMessagingActivity",
    "capturePaused"
  ] as const) {
    assert.equal(DEFAULT_COLLECTION_SETTINGS[key], false, key);
  }
});

test("persists a capture pause across launches", async (context) => {
  const directory = await testDirectory(context);
  const store = new SettingsStore(directory);
  store.save({ ...DEFAULT_COLLECTION_SETTINGS, capturePaused: true });
  assert.equal(new SettingsStore(directory).load().capturePaused, true);
});

test("persists normalized collection settings", async (context) => {
  const directory = await testDirectory(context);
  const store = new SettingsStore(directory);
  const settings: CollectionSettings = {
    version: 1,
    privacyNoticeVersion: 1,
    inferenceOnboardingVersion: 1,
    cloudInferenceConsents: ["openai", "openai", "anthropic"],
    appearanceMode: "dark",
    appPresentationMode: "menuBar",
    capturePaused: false,
    captureWindowTitles: false,
    captureFocusedElements: true,
    captureTextInput: false,
    capturePointerClicks: true,
    captureBrowserURLs: true,
    captureDocumentContext: true,
    captureUISnapshots: false,
    captureEmailActivity: true,
    captureMessagingActivity: true,
    excludedBundleIdentifiers: ["com.example.Secret", "com.example.Secret", "com.example.Chat"]
  };

  assert.deepEqual(store.save(settings).excludedBundleIdentifiers, ["com.example.Chat", "com.example.Secret"]);
  assert.deepEqual(store.load().cloudInferenceConsents, ["anthropic", "openai"]);
  assert.equal(store.load().captureWindowTitles, false);
  assert.equal(store.load().captureEmailActivity, true);
  assert.equal(store.load().captureMessagingActivity, true);
  assert.equal(store.load().appearanceMode, "dark");
  assert.equal(store.load().appPresentationMode, "menuBar");
});

test("migrates the original two-field settings file with minimal fork defaults", async (context) => {
  const directory = await testDirectory(context);
  writeFileSync(resolve(directory, "settings.json"), JSON.stringify({
    version: 1,
    captureWindowTitles: false,
    excludedBundleIdentifiers: ["com.example.Private"]
  }));
  const settings = new SettingsStore(directory).load();
  assert.equal(settings.captureWindowTitles, false);
  assert.equal(settings.privacyNoticeVersion, 0);
  assert.equal(settings.inferenceOnboardingVersion, 0);
  assert.deepEqual(settings.cloudInferenceConsents, []);
  assert.equal(settings.appearanceMode, "system");
  assert.equal(settings.appPresentationMode, "dock");
  assert.equal(settings.capturePaused, false);
  assert.equal(settings.captureTextInput, false);
  assert.equal(settings.captureDocumentContext, false);
  assert.equal(settings.captureUISnapshots, false);
  assert.equal(settings.captureEmailActivity, false);
  assert.equal(settings.captureMessagingActivity, false);
});

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "openhistory-settings-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
