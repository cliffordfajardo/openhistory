import Foundation

/// Ephemeral, content-free description of the current foreground context. The collector emits it
/// only while a Focus session asked for observation, sends it over the in-process bridge, and never
/// writes it to the activity JSONL files. A browser observation carries only the sanitized host;
/// every other state is an explicit "unknown" with a reason so stale evidence can never linger.
public struct ForegroundEvidence: Encodable, Equatable, Sendable {
    public enum Kind: String, Encodable, Sendable {
        case browser
        case unknown
    }

    public enum Reason: String, Encodable, Sendable {
        case otherApplication = "other_application"
        case browserAddressUnavailable = "browser_address_unavailable"
        case protectedContext = "protected_context"
        case excludedApplication = "excluded_application"
        case ownProcess = "own_process"
        case noFrontmostApplication = "no_frontmost_application"
        case transientOverlay = "transient_overlay"
        case screenAsleep = "screen_asleep"
        case sessionLocked = "session_locked"
        case accessibilityUntrusted = "accessibility_untrusted"
        case urlCaptureOff = "url_capture_off"
    }

    /// Bridge packets start with this tag. Persisted activity lines always start with "{", so the
    /// two streams cannot be confused by the Node-side parser.
    public static let packetPrefix = "openhistory-foreground-evidence:"

    public let generation: UInt64
    public let sequence: UInt64
    /// Milliseconds since 1970, sampled on the collector's clock.
    public let observedAt: Double
    public let kind: Kind
    public let reason: Reason?
    public let processIdentifier: Int32?
    public let bundleIdentifier: String?
    public let domain: String?

    public init(
        generation: UInt64,
        sequence: UInt64,
        observedAt: Date,
        kind: Kind,
        reason: Reason? = nil,
        processIdentifier: Int32? = nil,
        bundleIdentifier: String? = nil,
        domain: String? = nil
    ) {
        self.generation = generation
        self.sequence = sequence
        self.observedAt = (observedAt.timeIntervalSince1970 * 1_000).rounded()
        self.kind = kind
        self.reason = reason
        self.processIdentifier = processIdentifier
        self.bundleIdentifier = bundleIdentifier
        self.domain = domain
    }

    public func packet() -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return nil }
        return Self.packetPrefix + String(decoding: data, as: UTF8.self)
    }
}

/// Inputs gathered by the collector's existing sampler. Kept separate from AppKit so the decision
/// is unit-testable and fails closed: anything short of a fresh, safe, readable browser address
/// becomes an unknown observation.
public struct ForegroundEvidenceContext: Sendable {
    public let sessionActive: Bool
    public let screenAwake: Bool
    public let accessibilityTrusted: Bool
    public let captureBrowserURLs: Bool
    public let frontmostProcessIdentifier: Int32?
    public let frontmostBundleIdentifier: String?
    public let frontmostIsTransientOverlay: Bool
    public let frontmostIsOwnProcess: Bool
    public let frontmostIsObservable: Bool
    public let isRecognizedBrowser: Bool
    public let browserState: BrowserProtectionObservation?
    public let browserDomain: String?

    public init(
        sessionActive: Bool,
        screenAwake: Bool,
        accessibilityTrusted: Bool,
        captureBrowserURLs: Bool,
        frontmostProcessIdentifier: Int32?,
        frontmostBundleIdentifier: String?,
        frontmostIsTransientOverlay: Bool,
        frontmostIsOwnProcess: Bool,
        frontmostIsObservable: Bool,
        isRecognizedBrowser: Bool,
        browserState: BrowserProtectionObservation?,
        browserDomain: String?
    ) {
        self.sessionActive = sessionActive
        self.screenAwake = screenAwake
        self.accessibilityTrusted = accessibilityTrusted
        self.captureBrowserURLs = captureBrowserURLs
        self.frontmostProcessIdentifier = frontmostProcessIdentifier
        self.frontmostBundleIdentifier = frontmostBundleIdentifier
        self.frontmostIsTransientOverlay = frontmostIsTransientOverlay
        self.frontmostIsOwnProcess = frontmostIsOwnProcess
        self.frontmostIsObservable = frontmostIsObservable
        self.isRecognizedBrowser = isRecognizedBrowser
        self.browserState = browserState
        self.browserDomain = browserDomain
    }
}

public enum ForegroundEvidenceClassifier {
    public struct Decision: Equatable, Sendable {
        public let kind: ForegroundEvidence.Kind
        public let reason: ForegroundEvidence.Reason?
        public let domain: String?
    }

    public static func classify(_ context: ForegroundEvidenceContext) -> Decision {
        func unknown(_ reason: ForegroundEvidence.Reason) -> Decision {
            Decision(kind: .unknown, reason: reason, domain: nil)
        }
        guard context.sessionActive else { return unknown(.sessionLocked) }
        guard context.screenAwake else { return unknown(.screenAsleep) }
        guard context.accessibilityTrusted else { return unknown(.accessibilityUntrusted) }
        guard context.frontmostProcessIdentifier != nil else { return unknown(.noFrontmostApplication) }
        guard !context.frontmostIsOwnProcess else { return unknown(.ownProcess) }
        guard !context.frontmostIsTransientOverlay else { return unknown(.transientOverlay) }
        guard context.frontmostIsObservable else { return unknown(.excludedApplication) }
        guard context.isRecognizedBrowser else { return unknown(.otherApplication) }
        guard context.captureBrowserURLs else { return unknown(.urlCaptureOff) }
        switch context.browserState {
        case .safe?:
            guard let domain = context.browserDomain?.lowercased(), !domain.isEmpty else {
                return unknown(.browserAddressUnavailable)
            }
            return Decision(kind: .browser, reason: nil, domain: domain)
        case .protected?:
            return unknown(.protectedContext)
        case .unavailable?, nil:
            return unknown(.browserAddressUnavailable)
        }
    }
}
