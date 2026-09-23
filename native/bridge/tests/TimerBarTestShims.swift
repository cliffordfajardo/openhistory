import AppKit

struct FocusOverlayAppearance {
    let reduceMotion: Bool

    @MainActor static var forcedReduceMotion = false

    @MainActor static var current: FocusOverlayAppearance {
        FocusOverlayAppearance(
            reduceMotion: forcedReduceMotion || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        )
    }
}
