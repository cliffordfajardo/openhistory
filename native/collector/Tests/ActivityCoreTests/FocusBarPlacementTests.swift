import CoreGraphics
import Foundation
import Testing
@testable import ActivityCore

private let barSize = CGSize(width: 460, height: 54)
/// A built-in display with the menu bar and Dock already excluded.
private let builtIn = CGRect(x: 0, y: 70, width: 1_440, height: 795)
/// A second display to the left of and above the primary one.
private let external = CGRect(x: -1_920, y: 900, width: 1_920, height: 1_080)

@Test func defaultPlacementSitsBottomCentreAboveTheDock() {
    let frame = FocusBarPlacement.frame(preferredOrigin: nil, size: barSize, visibleFrames: [builtIn])
    #expect(frame == CGRect(x: 490, y: 86, width: 460, height: 54))
    #expect(frame!.minY > builtIn.minY, "the bar floats inside the usable area, not on its edge")
    #expect(frame!.maxY < builtIn.maxY, "the bar never reaches the top, where the reminder card shows")
}

@Test func savedPositionIsKeptWhenItIsFullyOnADisplay() {
    let origin = CGPoint(x: 120, y: 300)
    #expect(FocusBarPlacement.frame(preferredOrigin: origin, size: barSize, visibleFrames: [builtIn]) ==
        CGRect(origin: origin, size: barSize))
    let onSecond = CGPoint(x: -1_800, y: 1_000)
    #expect(FocusBarPlacement.frame(preferredOrigin: onSecond, size: barSize, visibleFrames: [builtIn, external]) ==
        CGRect(origin: onSecond, size: barSize))
}

@Test func aPartlyOffscreenPositionIsPulledBackOntoItsDisplay() {
    let hangingRight = CGPoint(x: builtIn.maxX - 40, y: 300)
    let clampedRight = FocusBarPlacement.frame(
        preferredOrigin: hangingRight, size: barSize, visibleFrames: [builtIn]
    )
    #expect(clampedRight == CGRect(x: builtIn.maxX - barSize.width, y: 300, width: 460, height: 54))

    let belowDock = CGPoint(x: 200, y: builtIn.minY - 50)
    #expect(FocusBarPlacement.frame(preferredOrigin: belowDock, size: barSize, visibleFrames: [builtIn]) ==
        CGRect(x: 200, y: builtIn.minY, width: 460, height: 54))
}

@Test func aPositionOnADisconnectedDisplayFallsBackToTheDefault() {
    let onGoneDisplay = CGPoint(x: -1_800, y: 1_000)
    #expect(FocusBarPlacement.frame(preferredOrigin: onGoneDisplay, size: barSize, visibleFrames: [builtIn]) ==
        FocusBarPlacement.defaultFrame(size: barSize, in: builtIn))
    let justOutside = CGPoint(x: builtIn.maxX, y: builtIn.maxY)
    #expect(FocusBarPlacement.frame(preferredOrigin: justOutside, size: barSize, visibleFrames: [builtIn]) ==
        FocusBarPlacement.defaultFrame(size: barSize, in: builtIn))
}

@Test func aPositionStraddlingTwoDisplaysLandsOnTheOneHoldingMostOfIt() {
    let mostlyExternal = CGPoint(x: external.maxX - 400, y: 1_000)
    let frame = FocusBarPlacement.frame(
        preferredOrigin: mostlyExternal, size: barSize, visibleFrames: [builtIn, external]
    )
    #expect(frame == CGRect(x: external.maxX - barSize.width, y: 1_000, width: 460, height: 54))
}

@Test func placementNeedsADisplayAndASize() {
    #expect(FocusBarPlacement.frame(preferredOrigin: nil, size: barSize, visibleFrames: []) == nil)
    #expect(FocusBarPlacement.frame(preferredOrigin: nil, size: .zero, visibleFrames: [builtIn]) == nil)
}

@Test func aBarWiderThanTheDisplayIsTrimmedToFitInsteadOfHangingOff() {
    let narrow = CGRect(x: 0, y: 0, width: 300, height: 200)
    let frame = FocusBarPlacement.frame(
        preferredOrigin: CGPoint(x: 100, y: 100), size: barSize, visibleFrames: [narrow]
    )
    #expect(frame == CGRect(x: 0, y: 100, width: 300, height: 54))

    let unplaced = FocusBarPlacement.frame(preferredOrigin: nil, size: barSize, visibleFrames: [narrow])
    #expect(unplaced == CGRect(x: 0, y: 16, width: 300, height: 54),
            "a bar with no saved corner is trimmed too, instead of hanging off the default position")
}

@Test func draggingTheTrailingEdgeMovesOnlyThatEdge() {
    let current = CGRect(x: 200, y: 300, width: 460, height: 54)
    let wider = FocusBarPlacement.resizedFrame(
        current: current, edge: .trailing, deltaX: 300, visibleFrames: [builtIn]
    )
    #expect(wider == CGRect(x: 200, y: 300, width: 760, height: 54))

    let narrower = FocusBarPlacement.resizedFrame(
        current: current, edge: .trailing, deltaX: -1_000, visibleFrames: [builtIn]
    )
    #expect(narrower == CGRect(x: 200, y: 300, width: FocusBarPlacement.minimumWidth, height: 54),
            "a bar never shrinks past the width its controls and goal need")
}

@Test func draggingTheLeadingEdgeHoldsTheRightEdgeStill() {
    let current = CGRect(x: 400, y: 300, width: 460, height: 54)
    let wider = FocusBarPlacement.resizedFrame(
        current: current, edge: .leading, deltaX: -240, visibleFrames: [builtIn]
    )
    #expect(wider == CGRect(x: 160, y: 300, width: 700, height: 54))
    #expect(wider!.maxX == current.maxX)
}

@Test func aResizeCannotGrowPastTheDisplayTheBarIsOn() {
    let onExternal = CGRect(x: external.minX + 100, y: 1_000, width: 460, height: 54)
    let stretched = FocusBarPlacement.resizedFrame(
        current: onExternal, edge: .trailing, deltaX: 9_000, visibleFrames: [builtIn, external]
    )
    #expect(stretched == CGRect(x: onExternal.minX, y: 1_000, width: external.maxX - onExternal.minX, height: 54),
            "the dragged edge stops at the display boundary while the opposite edge stays fixed")

    let small = CGRect(x: 0, y: 0, width: 300, height: 400)
    let trimmed = FocusBarPlacement.resizedFrame(
        current: CGRect(x: 0, y: 100, width: 300, height: 54), edge: .trailing, deltaX: 500, visibleFrames: [small]
    )
    #expect(trimmed == CGRect(x: 0, y: 100, width: 300, height: 54),
            "a display narrower than the minimum width still holds the bar")
}

@Test func fitFillsTheUsableWidthOfTheDisplayHoldingTheBar() {
    let onExternal = CGRect(x: external.minX + 600, y: 1_000, width: 460, height: 54)
    #expect(FocusBarPlacement.fitFrame(current: onExternal, visibleFrames: [builtIn, external]) ==
        CGRect(x: external.minX, y: 1_000, width: external.width, height: 54),
        "fit keeps the row the bar was on and takes the whole usable width")

    let onGoneDisplay = CGRect(x: -5_000, y: 4_000, width: 460, height: 54)
    #expect(FocusBarPlacement.fitFrame(current: onGoneDisplay, visibleFrames: [builtIn]) ==
        CGRect(
            x: builtIn.minX,
            y: builtIn.minY + FocusBarPlacement.bottomMargin,
            width: builtIn.width,
            height: 54
        ),
        "a bar on a display that is gone fits the primary one, above its Dock")
    #expect(FocusBarPlacement.fitFrame(current: onExternal, visibleFrames: []) == nil)
}
