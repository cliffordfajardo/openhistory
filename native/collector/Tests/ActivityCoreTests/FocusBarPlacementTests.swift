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

private func drag(x: CGFloat = 0, y: CGFloat = 0) -> CGSize {
    CGSize(width: x, height: y)
}

@Test func draggingTheTrailingEdgeMovesOnlyThatEdge() {
    let start = CGRect(x: 200, y: 300, width: 460, height: 54)
    let wider = FocusBarPlacement.resizedFrame(
        start: start, handle: .horizontal(.trailing), delta: drag(x: 300), visibleFrames: [builtIn]
    )
    #expect(wider == CGRect(x: 200, y: 300, width: 760, height: 54))

    let narrower = FocusBarPlacement.resizedFrame(
        start: start, handle: .horizontal(.trailing), delta: drag(x: -1_000), visibleFrames: [builtIn]
    )
    #expect(narrower == CGRect(x: 200, y: 300, width: FocusBarPlacement.minimumWidth, height: 54),
            "a bar never shrinks past the width its controls and goal need")
}

@Test func draggingTheLeadingEdgeHoldsTheRightEdgeStill() {
    let start = CGRect(x: 400, y: 300, width: 460, height: 54)
    let wider = FocusBarPlacement.resizedFrame(
        start: start, handle: .horizontal(.leading), delta: drag(x: -240), visibleFrames: [builtIn]
    )
    #expect(wider == CGRect(x: 160, y: 300, width: 700, height: 54))
    #expect(wider!.maxX == start.maxX)
}

@Test func draggingTheTopEdgeHoldsTheBottomStillAndTheBottomEdgeHoldsTheTop() {
    let start = CGRect(x: 200, y: 300, width: 460, height: 54)
    let taller = FocusBarPlacement.resizedFrame(
        start: start, handle: .vertical(.top), delta: drag(y: 120), visibleFrames: [builtIn]
    )
    #expect(taller == CGRect(x: 200, y: 300, width: 460, height: 174),
            "dragging the top edge up grows the bar upwards, in AppKit's y-up coordinates")
    #expect(taller!.minY == start.minY, "the bottom edge stays exactly where it was")

    let downFromTheBottom = FocusBarPlacement.resizedFrame(
        start: start, handle: .vertical(.bottom), delta: drag(y: -120), visibleFrames: [builtIn]
    )
    #expect(downFromTheBottom == CGRect(x: 200, y: 180, width: 460, height: 174))
    #expect(downFromTheBottom!.maxY == start.maxY, "the top edge stays exactly where it was")

    let squashed = FocusBarPlacement.resizedFrame(
        start: start, handle: .vertical(.top), delta: drag(y: -400), visibleFrames: [builtIn]
    )
    #expect(squashed == CGRect(x: 200, y: 300, width: 460, height: FocusBarPlacement.minimumHeight),
            "a bar never shrinks past the height its controls need")
}

@Test func everyCornerMovesItsOwnTwoEdgesAndLeavesTheOppositeOnesAlone() {
    let start = CGRect(x: 400, y: 300, width: 460, height: 54)
    let delta = drag(x: 100, y: 100)

    let topRight = FocusBarPlacement.resizedFrame(
        start: start, handle: .corner(.trailing, .top), delta: delta, visibleFrames: [builtIn]
    )
    #expect(topRight == CGRect(x: 400, y: 300, width: 560, height: 154))

    let topLeft = FocusBarPlacement.resizedFrame(
        start: start, handle: .corner(.leading, .top), delta: delta, visibleFrames: [builtIn]
    )
    #expect(topLeft == CGRect(x: 500, y: 300, width: 360, height: 154),
            "the left edge follows the pointer while the right and bottom stay put")

    let bottomRight = FocusBarPlacement.resizedFrame(
        start: start, handle: .corner(.trailing, .bottom), delta: delta, visibleFrames: [builtIn]
    )
    #expect(bottomRight == CGRect(x: 400, y: 314, width: 560, height: FocusBarPlacement.minimumHeight),
            "pushing the bottom up past the minimum stops at it, with the top edge still fixed")
    #expect(bottomRight!.maxY == start.maxY)

    let bottomLeft = FocusBarPlacement.resizedFrame(
        start: start, handle: .corner(.leading, .bottom), delta: drag(x: -100, y: -100),
        visibleFrames: [builtIn]
    )
    #expect(bottomLeft == CGRect(x: 300, y: 200, width: 560, height: 154))
    #expect(bottomLeft!.maxX == start.maxX)
    #expect(bottomLeft!.maxY == start.maxY)
}

@Test func aResizeCannotGrowPastTheDisplayTheBarIsOn() {
    let onExternal = CGRect(x: external.minX + 100, y: 1_000, width: 460, height: 54)
    let stretched = FocusBarPlacement.resizedFrame(
        start: onExternal, handle: .horizontal(.trailing), delta: drag(x: 9_000),
        visibleFrames: [builtIn, external]
    )
    #expect(stretched == CGRect(x: onExternal.minX, y: 1_000, width: external.maxX - onExternal.minX, height: 54),
            "the dragged edge stops at the display boundary while the opposite edge stays fixed")

    let raised = FocusBarPlacement.resizedFrame(
        start: onExternal, handle: .vertical(.top), delta: drag(y: 9_000),
        visibleFrames: [builtIn, external]
    )
    #expect(raised == CGRect(x: onExternal.minX, y: 1_000, width: 460, height: external.maxY - onExternal.minY),
            "the top edge stops at the top of the usable area with the bottom still fixed")

    let cornered = FocusBarPlacement.resizedFrame(
        start: onExternal, handle: .corner(.trailing, .top), delta: drag(x: 9_000, y: 9_000),
        visibleFrames: [builtIn, external]
    )
    #expect(cornered == CGRect(
        x: onExternal.minX,
        y: 1_000,
        width: external.maxX - onExternal.minX,
        height: external.maxY - onExternal.minY
    ), "a corner takes both limits from the same starting frame")

    let small = CGRect(x: 0, y: 0, width: 300, height: 30)
    let trimmed = FocusBarPlacement.resizedFrame(
        start: CGRect(x: 0, y: 0, width: 300, height: 30), handle: .corner(.trailing, .top),
        delta: drag(x: 500, y: 500), visibleFrames: [small]
    )
    #expect(trimmed == CGRect(x: 0, y: 0, width: 300, height: 30),
            "a display smaller than the minimum bar still holds the whole bar")
}

@Test func aStartFrameOffItsDisplayIsPulledBackBeforeItIsResized() {
    let offNegatively = CGRect(x: external.minX - 500, y: external.minY - 500, width: 460, height: 54)
    let resized = FocusBarPlacement.resizedFrame(
        start: offNegatively, handle: .vertical(.top), delta: drag(y: 60), visibleFrames: [external]
    )
    #expect(resized == CGRect(x: external.minX, y: external.minY, width: 460, height: 114),
            "the drag grows from the corner the frame is pulled back to, not from where it was")
    #expect(FocusBarPlacement.resizedFrame(
        start: offNegatively, handle: .vertical(.top), delta: drag(y: 60), visibleFrames: []
    ) == nil)
}

@Test func theHandleUnderAPressPrefersCornersAndLeavesTheControlBandAlone() {
    let bounds = CGRect(x: 0, y: 0, width: 460, height: FocusBarPlacement.minimumHeight)
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 230, y: 20), in: bounds) == nil,
            "the middle of the capsule moves the bar")
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 2, y: 20), in: bounds) == .horizontal(.leading))
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 458, y: 20), in: bounds) == .horizontal(.trailing))
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 230, y: 1), in: bounds) == .vertical(.bottom))
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 230, y: 39), in: bounds) == .vertical(.top))
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 1, y: 1), in: bounds) == .corner(.leading, .bottom),
            "a point inside both insets is a corner rather than either edge on its own")
    #expect(FocusBarPlacement.handle(at: CGPoint(x: 459, y: 39), in: bounds) == .corner(.trailing, .top))
    #expect(FocusBarPlacement.handle(at: CGPoint(x: -1, y: 20), in: bounds) == nil)

    let controlCentre = bounds.midY
    for x in [bounds.maxX - 28, bounds.maxX - 70, bounds.maxX - 112, bounds.midX] {
        #expect(FocusBarPlacement.handle(at: CGPoint(x: x, y: controlCentre), in: bounds) == nil,
                "no edge band reaches the centre of a control at the minimum height")
    }
}

@Test func fitFillsTheUsableWidthOfTheDisplayHoldingTheBar() {
    let onExternal = CGRect(x: external.minX + 600, y: 1_000, width: 460, height: 54)
    #expect(FocusBarPlacement.fitFrame(current: onExternal, visibleFrames: [builtIn, external]) ==
        CGRect(x: external.minX, y: 1_000, width: external.width, height: 54),
        "fit keeps the row the bar was on and takes the whole usable width")

    let tall = CGRect(x: external.minX + 600, y: 1_000, width: 460, height: 160)
    #expect(FocusBarPlacement.fitFrame(current: tall, visibleFrames: [builtIn, external])?.height == 160,
            "fit changes the width only; the height the person chose is kept")

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

@Test func resettingTheHeightKeepsTheWidthAndTheBottomLeftCorner() {
    let tall = CGRect(x: 300, y: 200, width: 700, height: 300)
    #expect(FocusBarPlacement.frame(
        preferredOrigin: tall.origin,
        size: CGSize(width: tall.width, height: FocusBarPlacement.defaultHeight),
        visibleFrames: [builtIn]
    ) == CGRect(x: 300, y: 200, width: 700, height: 54))

    let high = CGRect(x: 300, y: builtIn.maxY - 20, width: 700, height: 300)
    #expect(FocusBarPlacement.frame(
        preferredOrigin: high.origin,
        size: CGSize(width: high.width, height: FocusBarPlacement.defaultHeight),
        visibleFrames: [builtIn]
    ) == CGRect(x: 300, y: builtIn.maxY - 54, width: 700, height: 54))
}

@Test func resizingOneAxisDoesNotPersistDisplayClippingOnTheOtherAxis() {
    #expect(FocusBarPlacement.persistedSize(
        after: .vertical(.top), started: CGSize(width: 460, height: 54), rendered: CGSize(width: 300, height: 140),
        requested: CGSize(width: 1200, height: 90)
    ) == CGSize(width: 1200, height: 140))
    #expect(FocusBarPlacement.persistedSize(
        after: .horizontal(.trailing), started: CGSize(width: 460, height: 54), rendered: CGSize(width: 700, height: 30),
        requested: CGSize(width: 460, height: 200)
    ) == CGSize(width: 700, height: 200))
    #expect(FocusBarPlacement.persistedSize(
        after: .vertical(.bottom), started: CGSize(width: 460, height: 54), rendered: CGSize(width: 800, height: 140),
        requested: CGSize(width: 1200, height: 90)
    ) == CGSize(width: 1200, height: 140))
}

@Test func cornerResizePersistsEachAxisOnlyWhenTheDisplayCanFitItsMinimum() {
    let requested = CGSize(width: 1200, height: 90)
    #expect(FocusBarPlacement.persistedSize(
        after: .corner(.leading, .bottom), started: CGSize(width: 460, height: 54), rendered: CGSize(width: 300, height: 30), requested: requested
    ) == requested)
    #expect(FocusBarPlacement.persistedSize(
        after: .corner(.trailing, .top), started: CGSize(width: 460, height: 54), rendered: CGSize(width: 700, height: 120), requested: requested
    ) == CGSize(width: 700, height: 120))
}

@Test func cornerDragPreservesClippedAxisWhenOnlyTheOtherAxisChanges() {
    #expect(FocusBarPlacement.persistedSize(
        after: .corner(.trailing, .top), started: CGSize(width: 800, height: 90),
        rendered: CGSize(width: 800, height: 140), requested: CGSize(width: 1200, height: 90)
    ) == CGSize(width: 1200, height: 140))
    #expect(FocusBarPlacement.persistedSize(
        after: .corner(.leading, .bottom), started: CGSize(width: 460, height: 80),
        rendered: CGSize(width: 700, height: 80), requested: CGSize(width: 460, height: 200)
    ) == CGSize(width: 700, height: 200))
}
