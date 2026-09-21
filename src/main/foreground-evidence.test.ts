import assert from "node:assert/strict";
import test from "node:test";
import {
  FOREGROUND_EVIDENCE_PREFIX,
  isForegroundEvidencePacket,
  parseForegroundEvidencePacket
} from "./foreground-evidence";

const privacy = { captureEmailActivity: false, captureMessagingActivity: false };

function packet(value: Record<string, unknown>): string {
  return `${FOREGROUND_EVIDENCE_PREFIX}${JSON.stringify(value)}`;
}

const browser = {
  kind: "browser",
  generation: 3,
  sequence: 10,
  observedAt: 1_800_000_000_000,
  processIdentifier: 501,
  bundleIdentifier: "com.google.Chrome",
  domain: "WWW.Video.Example"
};

test("accepts a tagged browser packet and normalizes its host", () => {
  const evidence = parseForegroundEvidencePacket(packet(browser), privacy);
  assert.deepEqual(evidence, { ...browser, domain: "video.example" });
});

test("keeps persisted activity lines and evidence packets distinct", () => {
  assert.equal(isForegroundEvidencePacket(packet(browser)), true);
  assert.equal(isForegroundEvidencePacket(JSON.stringify(browser)), false);
  assert.equal(parseForegroundEvidencePacket(JSON.stringify(browser), privacy), undefined);
});

test("accepts unknown packets and never invents a domain for them", () => {
  const evidence = parseForegroundEvidencePacket(packet({
    kind: "unknown",
    generation: 3,
    sequence: 11,
    observedAt: 1_800_000_000_500,
    reason: "browser_address_unavailable",
    processIdentifier: 501
  }), privacy);
  assert.equal(evidence?.kind, "unknown");
  assert.equal(evidence && "domain" in evidence, false);
});

test("drops malformed, oversized, unexpected or out-of-contract packets", () => {
  const invalid = [
    `${FOREGROUND_EVIDENCE_PREFIX}{not json`,
    packet({ ...browser, generation: 0 }),
    packet({ ...browser, sequence: -1 }),
    packet({ ...browser, processIdentifier: 0 }),
    packet({ ...browser, domain: "" }),
    packet({ ...browser, url: "https://video.example/secret" }),
    packet({ ...browser, windowTitle: "Private title" }),
    packet({ ...browser, kind: "maybe" }),
    packet({ kind: "unknown", generation: 1, sequence: 1, observedAt: 1, reason: "collector_stopped" }),
    packet({ kind: "unknown", generation: 1, sequence: 1, observedAt: 1, reason: "made_up" }),
    packet({ ...browser, domain: "x".repeat(5_000) }),
    `${FOREGROUND_EVIDENCE_PREFIX}null`,
    `${FOREGROUND_EVIDENCE_PREFIX}[]`
  ];
  for (const line of invalid) assert.equal(parseForegroundEvidencePacket(line, privacy), undefined, line.slice(0, 80));
});

test("re-applies the privacy policy and downgrades protected sites to unknown", () => {
  for (const domain of ["pornhub.com", "media.pornhub.com", "mail.google.com", "app.slack.com", "user@example.com"]) {
    const evidence = parseForegroundEvidencePacket(packet({ ...browser, domain }), privacy);
    assert.equal(evidence?.kind, "unknown", domain);
    assert.equal(evidence?.kind === "unknown" ? evidence.reason : undefined, "protected_context", domain);
    assert.equal(JSON.stringify(evidence).includes(domain), false, domain);
  }
});

test("respects explicit email and messaging opt-ins without unblocking adult sites", () => {
  const optedIn = { captureEmailActivity: true, captureMessagingActivity: true };
  assert.equal(parseForegroundEvidencePacket(packet({ ...browser, domain: "mail.google.com" }), optedIn)?.kind, "browser");
  assert.equal(parseForegroundEvidencePacket(packet({ ...browser, domain: "app.slack.com" }), optedIn)?.kind, "browser");
  assert.equal(parseForegroundEvidencePacket(packet({ ...browser, domain: "pornhub.com" }), optedIn)?.kind, "unknown");
});

test("treats evidence from protected applications as unknown", () => {
  const evidence = parseForegroundEvidencePacket(packet({
    ...browser,
    bundleIdentifier: "com.1password.1password",
    domain: "video.example"
  }), privacy);
  assert.equal(evidence?.kind, "unknown");
});
