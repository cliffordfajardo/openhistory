import AppKit

// Compile the production FocusGrayscale.swift without the rest of the native bridge.
final class FocusOverlayPanel: NSPanel {
    convenience init(clickThrough: Bool, levelOffset: Int) {
        self.init(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: true)
        ignoresMouseEvents = clickThrough
    }
}

struct FocusOverlayAppearance {
    let reduceMotion: Bool
    @MainActor static var current: FocusOverlayAppearance { .init(reduceMotion: true) }
}
