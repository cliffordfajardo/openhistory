import CoreGraphics
import Foundation
import Testing
@testable import ActivityCore

private func candidate(
    _ identifier: UInt32,
    pid: Int32 = 42,
    layer: Int = 0,
    bounds: CGRect,
    alpha: Double = 1,
    onScreen: Bool = true
) -> FocusWindowCandidate {
    FocusWindowCandidate(
        windowIdentifier: identifier,
        processIdentifier: pid,
        layer: layer,
        bounds: bounds,
        alpha: alpha,
        isOnScreen: onScreen
    )
}

private let primary = FocusWindowDisplay(identifier: 1, bounds: CGRect(x: 0, y: 0, width: 1440, height: 900), scale: 2)

@Test func focusedWindowMatchesExactlyOneNormalOnScreenWindowOfItsProcess() {
    let frame = CGRect(x: 100, y: 80, width: 800, height: 600)
    let candidates = [
        candidate(7, bounds: frame),
        candidate(8, pid: 99, bounds: frame),
        candidate(9, layer: 3, bounds: frame),
        candidate(10, bounds: frame, alpha: 0),
        candidate(11, bounds: frame, onScreen: false),
        candidate(12, bounds: CGRect(x: 400, y: 80, width: 800, height: 600))
    ]
    let match = FocusWindowTargeting.matchWindow(frame: frame, processIdentifier: 42, candidates: candidates)
    #expect((try? match.get())?.windowIdentifier == 7)

    let nearlyEqual = CGRect(x: 100.5, y: 79.5, width: 800, height: 600.5)
    #expect((try? FocusWindowTargeting.matchWindow(
        frame: nearlyEqual, processIdentifier: 42, candidates: candidates
    ).get())?.windowIdentifier == 7)
}

@Test func ambiguousMissingOrStaleWindowMatchesAreRejected() {
    let frame = CGRect(x: 100, y: 80, width: 800, height: 600)
    let stacked = [candidate(7, bounds: frame), candidate(8, bounds: frame)]
    #expect(FocusWindowTargeting.matchWindow(frame: frame, processIdentifier: 42, candidates: stacked) ==
        .failure(.unavailable))
    #expect(FocusWindowTargeting.matchWindow(frame: frame, processIdentifier: 42, candidates: []) ==
        .failure(.unavailable))
    let moved = [candidate(7, bounds: frame.offsetBy(dx: 3, dy: 0))]
    #expect(FocusWindowTargeting.matchWindow(frame: frame, processIdentifier: 42, candidates: moved) ==
        .failure(.unavailable))
    #expect(FocusWindowTargeting.matchWindow(frame: .zero, processIdentifier: 42, candidates: [candidate(7, bounds: .zero)]) ==
        .failure(.unavailable))
}

@Test func retinaPlacementCropsDisplayLocalPixelsAndConvertsToAppKit() throws {
    let window = CGRect(x: 100, y: 80, width: 800, height: 600)
    let placement = try FocusWindowTargeting.placement(
        windowBounds: window, displays: [primary], primaryHeight: 900
    ).get()
    #expect(placement.displayIdentifier == 1)
    #expect(placement.sourceRect == window)
    #expect(placement.pixelWidth == 1_600)
    #expect(placement.pixelHeight == 1_200)
    #expect(placement.appKitFrame == CGRect(x: 100, y: 220, width: 800, height: 600))
}

@Test func negativeOriginDisplaysUseDisplayLocalSourceRectsAndGlobalAppKitFrames() throws {
    let left = FocusWindowDisplay(identifier: 2, bounds: CGRect(x: -1920, y: -200, width: 1920, height: 1080), scale: 1)
    let above = FocusWindowDisplay(identifier: 3, bounds: CGRect(x: 0, y: -1117, width: 1728, height: 1117), scale: 2)
    let displays = [primary, left, above]

    let onLeft = try FocusWindowTargeting.placement(
        windowBounds: CGRect(x: -1800, y: -150, width: 600, height: 400), displays: displays, primaryHeight: 900
    ).get()
    #expect(onLeft.displayIdentifier == 2)
    #expect(onLeft.sourceRect == CGRect(x: 120, y: 50, width: 600, height: 400))
    #expect(onLeft.pixelWidth == 600)
    #expect(onLeft.appKitFrame == CGRect(x: -1800, y: 650, width: 600, height: 400))
    #expect(FocusWindowTargeting.quartzRect(fromAppKit: onLeft.appKitFrame, primaryHeight: 900) ==
        CGRect(x: -1800, y: -150, width: 600, height: 400))

    let onAbove = try FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 10, y: -1000, width: 300, height: 200), displays: displays, primaryHeight: 900
    ).get()
    #expect(onAbove.displayIdentifier == 3)
    #expect(onAbove.sourceRect == CGRect(x: 10, y: 117, width: 300, height: 200))
    #expect(onAbove.pixelHeight == 400)
    #expect(onAbove.appKitFrame == CGRect(x: 10, y: 1700, width: 300, height: 200))
}

@Test func windowsPartlyOffEveryDisplayAreClippedAndSpanningWindowsAreRejected() throws {
    let clipped = try FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 1200, y: 700, width: 600, height: 400), displays: [primary], primaryHeight: 900
    ).get()
    #expect(clipped.sourceRect == CGRect(x: 1200, y: 700, width: 240, height: 200))
    #expect(clipped.pixelWidth == 480)
    #expect(clipped.pixelHeight == 400)

    let right = FocusWindowDisplay(identifier: 4, bounds: CGRect(x: 1440, y: 0, width: 1920, height: 1080), scale: 1)
    #expect(FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 1200, y: 100, width: 600, height: 400), displays: [primary, right], primaryHeight: 900
    ) == .failure(.spansDisplays))
    #expect(FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 5000, y: 100, width: 600, height: 400), displays: [primary, right], primaryHeight: 900
    ) == .failure(.unavailable))
    #expect(FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 1439.8, y: 100, width: 600, height: 400), displays: [primary], primaryHeight: 900
    ) == .failure(.unavailable), "a sliver thinner than two pixels is not a target")
}

@Test func fractionalBoundsSnapToTheDisplayPixelGrid() throws {
    let placement = try FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 10.3, y: 20.26, width: 100.4, height: 50.2), displays: [primary], primaryHeight: 900
    ).get()
    #expect(placement.sourceRect == CGRect(x: 10.5, y: 20.5, width: 100, height: 50))
    #expect(placement.pixelWidth == 200)
    #expect(placement.pixelHeight == 100)
}

@Test func siteRulesMatchHostsAndSubdomainsOnly() {
    #expect(FocusWindowTargeting.domainMatches("www.youtube.com", rule: "youtube.com"))
    #expect(FocusWindowTargeting.domainMatches("M.YouTube.com.", rule: "youtube.com"))
    #expect(!FocusWindowTargeting.domainMatches("notyoutube.com", rule: "youtube.com"))
    #expect(!FocusWindowTargeting.domainMatches("youtube.com.example.net", rule: "youtube.com"))
    #expect(!FocusWindowTargeting.domainMatches(nil, rule: "youtube.com"))
    #expect(!FocusWindowTargeting.domainMatches("youtube.com", rule: nil))
}

@Test func followingRetargetsOnlyWithFreshMatchingEvidence() throws {
    let first = try FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 0, y: 0, width: 400, height: 300), displays: [primary], primaryHeight: 900
    ).get()
    let moved = try FocusWindowTargeting.placement(
        windowBounds: CGRect(x: 50, y: 0, width: 400, height: 300), displays: [primary], primaryHeight: 900
    ).get()
    func follow(
        confirmed: Bool,
        evidence: Bool?,
        _ resolved: Result<(windowIdentifier: UInt32, placement: FocusWindowPlacement), FocusWindowTargetFailure>
    ) -> FocusWindowFollowAction {
        FocusWindowTargeting.follow(
            currentWindow: 7, currentPlacement: first, confirmed: confirmed,
            evidenceMatches: evidence, resolved: resolved
        )
    }

    #expect(follow(confirmed: true, evidence: nil, .success((7, first))) == .reveal)
    #expect(follow(confirmed: false, evidence: nil, .success((7, first))) == .await)
    #expect(follow(confirmed: false, evidence: true, .success((7, first))) == .reveal)
    #expect(follow(confirmed: true, evidence: nil, .success((7, moved))) ==
        .restart(windowIdentifier: 7, placement: moved, visible: true))
    #expect(follow(confirmed: false, evidence: nil, .success((7, moved))) ==
        .restart(windowIdentifier: 7, placement: moved, visible: false))
    #expect(follow(confirmed: true, evidence: nil, .success((8, first))) == .await,
            "another window of the same browser needs its own evidence")
    #expect(follow(confirmed: true, evidence: true, .success((8, moved))) ==
        .restart(windowIdentifier: 8, placement: moved, visible: true))
    #expect(follow(confirmed: true, evidence: false, .success((7, first))) == .await,
            "a safe site in the target window hides the gray image")
    #expect(follow(confirmed: true, evidence: false, .failure(.unavailable)) == .await)
    #expect(follow(confirmed: true, evidence: nil, .failure(.unavailable)) == .fail(.unavailable))
    #expect(follow(confirmed: true, evidence: true, .failure(.spansDisplays)) == .fail(.spansDisplays))
}
