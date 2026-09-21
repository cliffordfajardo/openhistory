import type { ActivityEvent } from "@shared/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import { FOREGROUND_EVIDENCE_PREFIX, parseForegroundEvidencePacket } from "./foreground-evidence";
import { filterProtectedActivityEvents, isBrowserEvent } from "./privacy-policy";

const appId = "abcdefghijklmnopabcdefghijklmnop";
const pwaBundle = `com.google.Chrome.app.${appId}`;
const privacy = { captureEmailActivity: false, captureMessagingActivity: false };

function event(id: string, kind: ActivityEvent["kind"], values: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    version: 1,
    id,
    timestamp: `2026-09-21T10:00:${String(Number(id.slice(-1)) || 0).padStart(2, "0")}Z`,
    kind,
    application: { bundleIdentifier: pwaBundle, localizedName: "Installed web app", processIdentifier: 501 },
    ...values
  };
}

function packet(bundleIdentifier: string, domain: string): string {
  return `${FOREGROUND_EVIDENCE_PREFIX}${JSON.stringify({
    kind: "browser", generation: 1, sequence: 1, observedAt: 1_800_000_000_000,
    processIdentifier: 501, bundleIdentifier, domain
  })}`;
}

test("recognizes only exact Chrome installed web app bundle IDs", () => {
  assert.equal(isBrowserEvent(event("event-0", "url_changed")), true);
  for (const invalid of [
    `com.google.Chrome.app.${appId.slice(1)}`,
    `com.google.Chrome.app.${appId}a`,
    `com.google.Chrome.app.${appId.slice(0, -1)}q`,
    `com.google.Chrome.app.${appId.toUpperCase()}`,
    `com.google.Chrome.beta.app.${appId}`,
    `com.google.Chrome.app.${appId}.extra`,
    `evil.com.google.Chrome.app.${appId}`
  ]) {
    assert.equal(isBrowserEvent(event("event-0", "url_changed", {
      application: { bundleIdentifier: invalid, localizedName: "Installed web app", processIdentifier: 501 }
    })), false, invalid);
  }
});

test("Chrome PWA protected context persists until a safe URL observation", () => {
  const filtered = filterProtectedActivityEvents([
    event("event-0", "url_changed", { browser: { url: "https://pornhub.com/private", domain: "pornhub.com" } }),
    event("event-1", "pointer_click", { windowTitle: "private title" }),
    event("event-2", "url_changed", { browser: { url: "https://youtube.com/watch", domain: "youtube.com" } }),
    event("event-3", "pointer_click", { windowTitle: "public title" })
  ]);
  assert.deepEqual(filtered.map(({ kind }) => kind), [
    "privacy_boundary", "privacy_boundary", "url_changed", "pointer_click"
  ]);
  assert.doesNotMatch(JSON.stringify(filtered), /private title|pornhub/);
  assert.match(JSON.stringify(filtered), /youtube\.com|public title/);
});

test("PWA foreground evidence uses the observed host and fails closed for protected or invalid identity", () => {
  const safe = parseForegroundEvidencePacket(packet(pwaBundle, "youtube.com"), privacy);
  assert.equal(safe?.kind, "browser");
  assert.equal(safe?.kind === "browser" ? safe.domain : undefined, "youtube.com");
  const lookalike = parseForegroundEvidencePacket(packet(pwaBundle, "youtube.com.evil.example"), privacy);
  assert.equal(lookalike?.kind === "browser" ? lookalike.domain : undefined, "youtube.com.evil.example");

  for (const domain of ["pornhub.com", "mail.google.com", "app.slack.com"]) {
    const protectedResult = parseForegroundEvidencePacket(packet(pwaBundle, domain), privacy);
    assert.equal(protectedResult?.kind, "unknown", domain);
    assert.equal(protectedResult?.kind === "unknown" ? protectedResult.reason : undefined, "protected_context");
    assert.doesNotMatch(JSON.stringify(protectedResult), new RegExp(domain.replaceAll(".", "\\.")));
  }
  const malformed = parseForegroundEvidencePacket(packet(`com.google.Chrome.app.${appId.slice(1)}`, "youtube.com"), privacy);
  assert.equal(malformed?.kind, "unknown");
});
