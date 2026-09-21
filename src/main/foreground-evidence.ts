import { normalizeObservedHost } from "@shared/focus";
import { z } from "zod";
import { isBrowserEvent, isProtectedActivityEvent, isProtectedAdultWebDomain } from "./privacy-policy";

/** Must match ForegroundEvidence.packetPrefix in native ActivityCore. */
export const FOREGROUND_EVIDENCE_PREFIX = "openhistory-foreground-evidence:";
const MAX_PACKET_CHARACTERS = 4_096;

export const FOREGROUND_UNKNOWN_REASONS = [
  "other_application",
  "browser_address_unavailable",
  "protected_context",
  "excluded_application",
  "own_process",
  "no_frontmost_application",
  "transient_overlay",
  "screen_asleep",
  "session_locked",
  "accessibility_untrusted",
  "url_capture_off",
  "collector_stopped"
] as const;

export type ForegroundUnknownReason = (typeof FOREGROUND_UNKNOWN_REASONS)[number];

export type ForegroundEvidence =
  | {
    kind: "browser";
    generation: number;
    sequence: number;
    observedAt: number;
    processIdentifier: number;
    bundleIdentifier: string;
    domain: string;
  }
  | {
    kind: "unknown";
    generation: number;
    sequence: number;
    observedAt: number;
    reason: ForegroundUnknownReason;
    processIdentifier?: number;
  };

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const packetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("browser"),
    generation: counter.min(1),
    sequence: counter,
    observedAt: z.number().finite().nonnegative(),
    processIdentifier: z.number().int().positive(),
    bundleIdentifier: z.string().min(1).max(500),
    domain: z.string().min(1).max(500)
  }).strict(),
  z.object({
    kind: z.literal("unknown"),
    generation: counter.min(1),
    sequence: counter,
    observedAt: z.number().finite().nonnegative(),
    reason: z.enum(FOREGROUND_UNKNOWN_REASONS).exclude(["collector_stopped"]),
    processIdentifier: z.number().int().positive().optional()
  }).strict()
]);

export function isForegroundEvidencePacket(line: string): boolean {
  return line.startsWith(FOREGROUND_EVIDENCE_PREFIX);
}

/**
 * Validates a native evidence packet and re-applies the TypeScript privacy policy. Anything that
 * fails validation returns undefined (dropped); a browser observation the policy protects is
 * downgraded to an unknown observation without its domain.
 */
export function parseForegroundEvidencePacket(
  line: string,
  privacy: { captureEmailActivity: boolean; captureMessagingActivity: boolean }
): ForegroundEvidence | undefined {
  if (!isForegroundEvidencePacket(line) || line.length > MAX_PACKET_CHARACTERS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(FOREGROUND_EVIDENCE_PREFIX.length));
  } catch {
    return undefined;
  }
  const parsed = packetSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const evidence = parsed.data;
  if (evidence.kind === "unknown") return evidence;

  const domain = normalizeObservedHost(evidence.domain);
  const application = {
    bundleIdentifier: evidence.bundleIdentifier,
    localizedName: null,
    processIdentifier: evidence.processIdentifier
  };
  const protectedEvidence = !isBrowserEvent({ application }) || !domain ||
    isProtectedAdultWebDomain(domain) || isProtectedActivityEvent({
    kind: "url_changed",
    application,
    browser: { url: `https://${domain ?? "invalid.invalid"}/`, domain: domain ?? "" }
  }, privacy);
  if (protectedEvidence) {
    return {
      kind: "unknown",
      generation: evidence.generation,
      sequence: evidence.sequence,
      observedAt: evidence.observedAt,
      reason: "protected_context",
      processIdentifier: evidence.processIdentifier
    };
  }
  return { ...evidence, domain: domain! };
}
