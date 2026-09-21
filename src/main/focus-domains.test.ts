import assert from "node:assert/strict";
import test from "node:test";
import {
  focusDomainMatches,
  matchingFocusDomain,
  normalizeFocusDomainList,
  normalizeObservedHost,
  parseFocusDomain
} from "../shared/focus";

function parsed(value: string): string | undefined {
  const result = parseFocusDomain(value);
  return result.ok ? result.domain : undefined;
}

test("normalizes typed sites, URLs and www prefixes to one lowercase host", () => {
  assert.equal(parsed("YouTube.com"), "youtube.com");
  assert.equal(parsed("  www.youtube.com  "), "youtube.com");
  assert.equal(parsed("https://www.YouTube.com/watch?v=abc#t=1"), "youtube.com");
  assert.equal(parsed("http://news.example.com/path"), "news.example.com");
  assert.equal(parsed("*.reddit.com"), "reddit.com");
  assert.equal(parsed("example.com."), "example.com");
  assert.equal(parsed("bücher.example"), "xn--bcher-kva.example");
});

test("rejects malformed, credentialed, non-web and overly broad rules", () => {
  for (const value of [
    "",
    "   ",
    "localhost",
    "com",
    "javascript:alert(1)",
    "file:///etc/hosts",
    "ftp://example.com",
    "https://user:secret@example.com",
    "user@example.com",
    "https://example.com:8443",
    "192.168.1.10",
    "https://[::1]/",
    "exa mple.com",
    "-bad.example.com",
    "example.c",
    "example.123",
    "co.uk",
    "github.io",
    `${"a".repeat(64)}.com`,
    "x".repeat(3_000)
  ]) {
    assert.equal(parseFocusDomain(value).ok, false, `expected ${JSON.stringify(value.slice(0, 40))} to be rejected`);
  }
});

test("matches exact hosts and dot-delimited subdomains only", () => {
  assert.equal(focusDomainMatches("youtube.com", "youtube.com"), true);
  assert.equal(focusDomainMatches("www.youtube.com", "youtube.com"), true);
  assert.equal(focusDomainMatches("m.youtube.com", "youtube.com"), true);
  assert.equal(focusDomainMatches("music.m.youtube.com", "youtube.com"), true);
  assert.equal(focusDomainMatches("YOUTUBE.COM.", "youtube.com"), true);
});

test("does not match lookalike or spoofed hosts", () => {
  for (const spoof of [
    "notyoutube.com",
    "youtube.com.evil.example",
    "youtube.co",
    "youtube.com-evil.example",
    "evil.example/youtube.com",
    "youtube.com@evil.example",
    "youtube.com:443",
    "xn--youtube-.com",
    "",
    " "
  ]) {
    assert.equal(focusDomainMatches(spoof, "youtube.com"), false, `${spoof} must not match`);
  }
  assert.equal(focusDomainMatches("youtube.com", ""), false);
  assert.equal(focusDomainMatches("example.com", "news.example.com"), false);
});

test("returns the first matching rule and ignores unmatched hosts", () => {
  assert.equal(matchingFocusDomain("old.reddit.com", ["news.example", "reddit.com"]), "reddit.com");
  assert.equal(matchingFocusDomain("docs.example.com", ["reddit.com"]), undefined);
});

test("deduplicates and sorts rule lists while dropping invalid entries", () => {
  assert.deepEqual(
    normalizeFocusDomainList(["www.YouTube.com", "youtube.com", "reddit.com", "localhost", "javascript:x"]),
    ["reddit.com", "youtube.com"]
  );
});

test("normalizes observed hosts without accepting URL syntax", () => {
  assert.equal(normalizeObservedHost("WWW.Example.COM."), "example.com");
  assert.equal(normalizeObservedHost("example.com/path"), undefined);
  assert.equal(normalizeObservedHost("user@example.com"), undefined);
  assert.equal(normalizeObservedHost(""), undefined);
});
