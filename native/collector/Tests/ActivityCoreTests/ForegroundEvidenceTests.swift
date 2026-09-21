import Foundation
import Testing
@testable import ActivityCore

private func context(
    sessionActive: Bool = true,
    screenAwake: Bool = true,
    accessibilityTrusted: Bool = true,
    captureBrowserURLs: Bool = true,
    frontmostProcessIdentifier: Int32? = 42,
    frontmostBundleIdentifier: String? = "com.apple.Safari",
    transientOverlay: Bool = false,
    ownProcess: Bool = false,
    observable: Bool = true,
    recognizedBrowser: Bool = true,
    browserState: BrowserProtectionObservation? = .safe,
    browserDomain: String? = "news.example.com"
) -> ForegroundEvidenceContext {
    ForegroundEvidenceContext(
        sessionActive: sessionActive,
        screenAwake: screenAwake,
        accessibilityTrusted: accessibilityTrusted,
        captureBrowserURLs: captureBrowserURLs,
        frontmostProcessIdentifier: frontmostProcessIdentifier,
        frontmostBundleIdentifier: frontmostBundleIdentifier,
        frontmostIsTransientOverlay: transientOverlay,
        frontmostIsOwnProcess: ownProcess,
        frontmostIsObservable: observable,
        isRecognizedBrowser: recognizedBrowser,
        browserState: browserState,
        browserDomain: browserDomain
    )
}

@Test func safeReadableBrowserAddressBecomesBrowserEvidence() {
    let decision = ForegroundEvidenceClassifier.classify(context(browserDomain: "News.Example.com"))
    #expect(decision.kind == .browser)
    #expect(decision.reason == nil)
    #expect(decision.domain == "news.example.com")
}

@Test func chromeWebAppEvidenceNeedsARecognizedBundleAndSafeReadableURL() {
    let valid = "com.google.Chrome.app." + String(repeating: "a", count: 32)
    let invalid = "com.google.Chrome.app." + String(repeating: "a", count: 31)
    let safe = ForegroundEvidenceClassifier.classify(context(
        frontmostBundleIdentifier: valid,
        recognizedBrowser: SemanticProtectionPolicy.isBrowserApplication(bundleIdentifier: valid),
        browserState: .safe,
        browserDomain: "youtube.com"
    ))
    #expect(safe.kind == .browser)
    #expect(safe.domain == "youtube.com")

    let malformed = ForegroundEvidenceClassifier.classify(context(
        frontmostBundleIdentifier: invalid,
        recognizedBrowser: SemanticProtectionPolicy.isBrowserApplication(bundleIdentifier: invalid)
    ))
    #expect(malformed.kind == .unknown)
    #expect(malformed.reason == .otherApplication)

    for state in [BrowserProtectionObservation.unavailable, .protected] {
        let unknown = ForegroundEvidenceClassifier.classify(context(
            frontmostBundleIdentifier: valid,
            recognizedBrowser: SemanticProtectionPolicy.isBrowserApplication(bundleIdentifier: valid),
            browserState: state,
            browserDomain: "youtube.com"
        ))
        #expect(unknown.kind == .unknown)
        #expect(unknown.domain == nil)
    }
}

@Test func everyUnsafeOrUnreadableForegroundFailsClosed() {
    let cases: [(ForegroundEvidenceContext, ForegroundEvidence.Reason)] = [
        (context(sessionActive: false), .sessionLocked),
        (context(screenAwake: false), .screenAsleep),
        (context(accessibilityTrusted: false), .accessibilityUntrusted),
        (context(frontmostProcessIdentifier: nil), .noFrontmostApplication),
        (context(ownProcess: true), .ownProcess),
        (context(transientOverlay: true), .transientOverlay),
        (context(observable: false), .excludedApplication),
        (context(recognizedBrowser: false), .otherApplication),
        (context(captureBrowserURLs: false), .urlCaptureOff),
        (context(browserState: .protected), .protectedContext),
        (context(browserState: .unavailable), .browserAddressUnavailable),
        (context(browserState: nil), .browserAddressUnavailable),
        (context(browserDomain: nil), .browserAddressUnavailable),
        (context(browserDomain: ""), .browserAddressUnavailable)
    ]
    for (input, reason) in cases {
        let decision = ForegroundEvidenceClassifier.classify(input)
        #expect(decision.kind == .unknown)
        #expect(decision.reason == reason)
        #expect(decision.domain == nil)
    }
}

@Test func protectedContextNeverCarriesADomain() {
    let decision = ForegroundEvidenceClassifier.classify(
        context(browserState: .protected, browserDomain: "private.example.com")
    )
    #expect(decision.domain == nil)
}

@Test func evidencePacketIsTaggedAndDistinctFromPersistedEvents() throws {
    let evidence = ForegroundEvidence(
        generation: 7,
        sequence: 3,
        observedAt: Date(timeIntervalSince1970: 1_800_000_000),
        kind: .browser,
        processIdentifier: 42,
        bundleIdentifier: "com.google.Chrome",
        domain: "video.example.com"
    )
    let packet = try #require(evidence.packet())
    #expect(packet.hasPrefix(ForegroundEvidence.packetPrefix))
    #expect(!packet.hasPrefix("{"))
    let json = String(packet.dropFirst(ForegroundEvidence.packetPrefix.count))
    let object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    #expect(object["generation"] as? Int == 7)
    #expect(object["sequence"] as? Int == 3)
    #expect(object["observedAt"] as? Double == 1_800_000_000_000)
    #expect(object["kind"] as? String == "browser")
    #expect(object["domain"] as? String == "video.example.com")
    #expect(object["url"] == nil)
    #expect(object["windowTitle"] == nil)
}

@Test func unknownEvidenceOmitsBrowserIdentity() throws {
    let evidence = ForegroundEvidence(
        generation: 1,
        sequence: 1,
        observedAt: Date(timeIntervalSince1970: 0),
        kind: .unknown,
        reason: .protectedContext,
        processIdentifier: 42
    )
    let packet = try #require(evidence.packet())
    let json = String(packet.dropFirst(ForegroundEvidence.packetPrefix.count))
    let object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    #expect(object["reason"] as? String == "protected_context")
    #expect(object["domain"] == nil)
    #expect(object["bundleIdentifier"] == nil)
}
