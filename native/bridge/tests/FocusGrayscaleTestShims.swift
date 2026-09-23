import AppKit

// Compile the production FocusGrayscale.swift without the rest of the native bridge.
final class FocusOverlayPanel: NSPanel {
    convenience init(clickThrough: Bool, levelOffset: Int) {
        self.init(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: true)
        ignoresMouseEvents = clickThrough
    }
}

/// The floating Focus bar is excluded from capture the same way the reminder panels are.
final class FocusBarPanel: NSPanel {}

final class TimerBarPanel: NSPanel {}

struct FocusOverlayAppearance {
    let reduceMotion: Bool
    @MainActor static var current: FocusOverlayAppearance { .init(reduceMotion: true) }
}
