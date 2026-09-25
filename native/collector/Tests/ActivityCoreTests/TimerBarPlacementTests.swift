import CoreGraphics
import Foundation
import Testing
@testable import ActivityCore

private func builtIn(
    menuBarVisible: Bool = true,
    safeAreaTopInset: CGFloat = 0,
    reservedTop: CGFloat = 25,
    backingScaleFactor: CGFloat = 2
) -> TimerBarPlacement.DisplayGeometry {
    let frame = CGRect(x: 0, y: 0, width: 1_440, height: 900)
    return TimerBarPlacement.DisplayGeometry(
        frame: frame,
        visibleFrame: CGRect(x: 0, y: 70, width: 1_440, height: frame.height - 70 - reservedTop),
        safeAreaTopInset: safeAreaTopInset,

        menuBarVisible: menuBarVisible,
        backingScaleFactor: backingScaleFactor
    )
}

private func external(reservedTop: CGFloat = 25) -> TimerBarPlacement.DisplayGeometry {
    let frame = CGRect(x: -1_920, y: -180, width: 1_920, height: 1_080)
    return TimerBarPlacement.DisplayGeometry(
        frame: frame,
        visibleFrame: CGRect(x: -1_920, y: -180, width: 1_920, height: 1_080 - reservedTop),
        safeAreaTopInset: 0,

        menuBarVisible: true,
        backingScaleFactor: 1
    )
}

@Test func theBarCoversTheReservedMenuRegionAcrossTheWholeDisplay() {
    let frame = TimerBarPlacement.barFrame(for: builtIn())
    #expect(frame == CGRect(x: 0, y: 875, width: 1_440, height: 25))
    #expect(frame!.maxY == builtIn().frame.maxY, "the bar is anchored to the top of the display")
    #expect(frame!.width == builtIn().frame.width, "the bar spans the full display width")
}

@Test func aDisplayWithANegativeOriginStaysInItsOwnFrame() {
    let frame = TimerBarPlacement.barFrame(for: external())
    #expect(frame == CGRect(x: -1_920, y: 875, width: 1_920, height: 25))
}

@Test func everyDisplayIsMeasuredOnItsOwn() {
    let frames = [builtIn(), external(reservedTop: 37)].compactMap(TimerBarPlacement.barFrame(for:))
    #expect(frames.count == 2)
    #expect(frames[0].height == 25)
    #expect(frames[1].height == 37, "a second display with a taller menu region gets a taller bar")
    #expect(frames[1].maxX <= frames[0].minX, "each bar stays on its own display")
}

@Test func aNotchedDisplayUsesItsOwnTallerMenuRegion() {
    let notched = builtIn(safeAreaTopInset: 37, reservedTop: 37)
    #expect(TimerBarPlacement.menuRegionHeight(for: notched) == 37)
    #expect(TimerBarPlacement.barFrame(for: notched)?.height == 37)
}

@Test func aGlobalVisibleMenuDoesNotExpandAnUnreservedDisplay() {
    let notchOnly = builtIn(safeAreaTopInset: 37, reservedTop: 0)
    #expect(TimerBarPlacement.menuRegionHeight(for: notchOnly) == 3)
    let thicknessOnly = builtIn(safeAreaTopInset: 0, reservedTop: 0)
    #expect(TimerBarPlacement.menuRegionHeight(for: thicknessOnly) == 3)
}

@Test func aHiddenMenuBarOrNoReservedRegionFallsBackToTheThinStrip() {
    let hidden = builtIn(menuBarVisible: false)
    #expect(TimerBarPlacement.menuRegionHeight(for: hidden) == TimerBarPlacement.edgeStripHeight)
    #expect(TimerBarPlacement.barFrame(for: hidden) == CGRect(x: 0, y: 897, width: 1_440, height: 3))

    let nothingAnywhere = TimerBarPlacement.DisplayGeometry(
        frame: CGRect(x: 0, y: 0, width: 1_440, height: 900),
        visibleFrame: CGRect(x: 0, y: 0, width: 1_440, height: 900),
        safeAreaTopInset: 0,

        menuBarVisible: true,
        backingScaleFactor: 2
    )
    #expect(TimerBarPlacement.menuRegionHeight(for: nothingAnywhere) == TimerBarPlacement.edgeStripHeight)
}

@Test func placementIgnoresTheBackingScaleFactor() {
    let oneToOne = builtIn(backingScaleFactor: 1)
    let retina = builtIn(backingScaleFactor: 2)
    #expect(TimerBarPlacement.barFrame(for: oneToOne) == TimerBarPlacement.barFrame(for: retina))
    #expect(TimerBarPlacement.contentsScale(for: retina) == 2)
    #expect(TimerBarPlacement.contentsScale(for: oneToOne) == 1)
    #expect(TimerBarPlacement.contentsScale(for: builtIn(backingScaleFactor: 0)) == 1)
    #expect(TimerBarPlacement.contentsScale(for: builtIn(backingScaleFactor: .nan)) == 1)
}

@Test func anUnusableDisplayHasNoBar() {
    let empty = TimerBarPlacement.DisplayGeometry(
        frame: .zero,
        visibleFrame: .zero,
        safeAreaTopInset: 0,

        menuBarVisible: true,
        backingScaleFactor: 2
    )
    #expect(TimerBarPlacement.barFrame(for: empty) == nil)
}

@Test func theRemainingFractionIsClampedAndSurvivesAZeroTotal() {
    #expect(TimerBarPlacement.remainingFraction(remainingSeconds: 300, totalSeconds: 1_500) == 0.2)
    #expect(TimerBarPlacement.remainingFraction(remainingSeconds: 0, totalSeconds: 1_500) == 0)
    #expect(TimerBarPlacement.remainingFraction(remainingSeconds: 1_800, totalSeconds: 1_500) == 1)
    #expect(TimerBarPlacement.remainingFraction(remainingSeconds: -5, totalSeconds: 1_500) == 0)
    #expect(TimerBarPlacement.remainingFraction(remainingSeconds: 10, totalSeconds: 0) == 0)
    #expect(TimerBarPlacement.remainingFraction(remainingSeconds: .nan, totalSeconds: 1_500) == 0)
}
