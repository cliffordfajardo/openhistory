import type { ActivityEvent } from "@shared/contracts";
import privacyPolicyData from "@shared/privacy-policy-data.json";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  filterProtectedActivityEvents,
  isProtectedAdultWebDomain,
  isSensitiveTextField
} from "./privacy-policy";

test("matches protected adult domains and their subdomains without matching lookalikes", () => {
  assert.equal(isProtectedAdultWebDomain("pornhub.com"), true);
  assert.equal(isProtectedAdultWebDomain("WWW.PORNHUB.COM."), true);
  assert.equal(isProtectedAdultWebDomain("media.pornhub.com"), true);
  assert.equal(isProtectedAdultWebDomain("notpornhub.com"), false);
  assert.equal(isProtectedAdultWebDomain("pornhub.com.example.org"), false);
});

test("keeps the generated Swift adult-domain policy synchronized", () => {
  const swift = readFileSync(
    "native/collector/Sources/ActivityCore/SemanticProtectionPolicy.swift",
    "utf8"
  );
  for (const domain of privacyPolicyData.adultWebDomains) {
    assert.match(swift, new RegExp(`\\"${domain.replaceAll(".", "\\.")}\\"`));
  }
});

test("recognizes secure web fields and password metadata", () => {
  assert.equal(isSensitiveTextField({ role: "AXTextField", subrole: "AXSecureTextField" }), true);
  assert.equal(isSensitiveTextField({ role: "AXTextField", identifier: "current-password" }), true);
  assert.equal(isSensitiveTextField({ role: "AXTextField", label: "Enter your passcode" }), true);
  assert.equal(isSensitiveTextField({ role: "AXSearchField", label: "Search project notes" }), false);
});

test("email activity remains absent from history when webmail can be a Focus target", () => {
  const filtered = filterProtectedActivityEvents([
    browserEvent("mail-url", "2026-08-15T09:00:00Z", "url_changed", {
      browser: { url: "https://mail.google.com/mail/u/0/#inbox", domain: "mail.google.com" }
    }),
    browserEvent("mail-window", "2026-08-15T09:00:01Z", "window_changed", {
      windowTitle: "Inbox - Gmail"
    }),
    browserEvent("mail-text", "2026-08-15T09:00:02Z", "text_input", {
      windowTitle: "Inbox - Gmail",
      textChange: { insertedText: "arbitrary-canary-message", deletedCharacterCount: 0, resultingValue: "arbitrary-canary-message" }
    })
  ], { captureEmailActivity: false });
  assert.equal(filtered.some((event) => ["mail-url", "mail-window", "mail-text"].includes(event.id)), false);
  assert.doesNotMatch(JSON.stringify(filtered), /mail\.google\.com|arbitrary-canary-message|Inbox - Gmail/);
});

test("replaces an adult browsing interval with content-free boundaries", () => {
  const filtered = filterProtectedActivityEvents([
    browserEvent("safe-before", "2026-08-15T09:00:00Z", "url_changed", {
      browser: { url: "https://example.com/work", domain: "example.com" }
    }),
    browserEvent("adult-url", "2026-08-15T09:00:01Z", "url_changed", {
      browser: { url: "https://pornhub.com/[redacted]", domain: "pornhub.com" }
    }),
    browserEvent("adult-click", "2026-08-15T09:00:02Z", "pointer_click", {
      element: { role: "AXButton", label: "private adult action" }
    }),
    browserEvent("safe-after", "2026-08-15T09:00:03Z", "url_changed", {
      browser: { url: "https://example.com/again", domain: "example.com" }
    })
  ]);

  assert.deepEqual(filtered.map(({ kind }) => kind), [
    "url_changed",
    "privacy_boundary",
    "privacy_boundary",
    "url_changed"
  ]);
  assert.equal(filtered[0]?.id, "safe-before");
  assert.equal(filtered[3]?.id, "safe-after");
  assert.doesNotMatch(JSON.stringify(filtered), /private adult action|pornhub/);
});

test("drops password typing and snapshots until focus moves to a safe field", () => {
  const filtered = filterProtectedActivityEvents([
    browserEvent("password-focus", "2026-08-15T09:00:00Z", "focused_element_changed", {
      element: { role: "AXTextField", identifier: "current-password" }
    }),
    browserEvent("password-text", "2026-08-15T09:00:01Z", "text_input", {
      element: { role: "AXTextField", identifier: "current-password" },
      textChange: {
        insertedText: "arbitrary-canary-password",
        deletedCharacterCount: 0,
        resultingValue: "arbitrary-canary-password"
      }
    }),
    browserEvent("password-snapshot", "2026-08-15T09:00:02Z", "ui_snapshot", {
      visibleText: ["arbitrary-canary-password"]
    }),
    browserEvent("safe-focus", "2026-08-15T09:00:03Z", "focused_element_changed", {
      element: { role: "AXSearchField", label: "Search" }
    })
  ]);

  assert.deepEqual(filtered.map(({ kind }) => kind), [
    "privacy_boundary",
    "privacy_boundary",
    "focused_element_changed"
  ]);
  assert.equal(filtered[2]?.id, "safe-focus");
  assert.doesNotMatch(JSON.stringify(filtered), /arbitrary-canary-password|current-password/);
});

function browserEvent(
  id: string,
  timestamp: string,
  kind: ActivityEvent["kind"],
  values: Partial<ActivityEvent>
): ActivityEvent {
  return {
    version: 1,
    id,
    timestamp,
    kind,
    application: {
      bundleIdentifier: "com.google.Chrome",
      localizedName: "Chrome",
      processIdentifier: 42
    },
    ...values
  };
}
