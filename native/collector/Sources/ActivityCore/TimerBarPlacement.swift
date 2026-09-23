import CoreGraphics
import Foundation

/**
 Where the persistent timer bar sits on one display, in that display's AppKit points (bottom-left
 origin, y up). Every value here is a point value read from `NSScreen`; nothing is multiplied by a
 backing scale factor and no menu-bar height is hardcoded.
 */
public enum TimerBarPlacement {
    /// The strip drawn when a display reserves no menu region, so the bar is still visible there.
    public static let edgeStripHeight: CGFloat = 3

    /// What one display reports about itself, sampled fresh each time the bar is placed.
    public struct DisplayGeometry: Equatable, Sendable {
        /// The whole display, including the menu region.
        public let frame: CGRect
        /// The display minus the menu bar and the Dock, as AppKit reports it.
        public let visibleFrame: CGRect
        /// `NSScreen.safeAreaInsets.top`: the notch on displays that have one, otherwise 0.
        public let safeAreaTopInset: CGFloat
        /// Global menu-bar visibility reported by `NSMenu.menuBarVisible()`.
        public let menuBarVisible: Bool
        /// `NSScreen.backingScaleFactor`, used only for layer `contentsScale`, never for geometry.
        public let backingScaleFactor: CGFloat

        public init(
            frame: CGRect,
            visibleFrame: CGRect,
            safeAreaTopInset: CGFloat,
            menuBarVisible: Bool,
            backingScaleFactor: CGFloat
        ) {
            self.frame = frame
            self.visibleFrame = visibleFrame
            self.safeAreaTopInset = safeAreaTopInset
            self.menuBarVisible = menuBarVisible
            self.backingScaleFactor = backingScaleFactor
        }
    }

    /**
     How tall the menu region of this display is. The reserved gap between the top of the display
     and the top of its usable area is the only per-display measure macOS offers; the notch inset
     can enlarge a visible menu region. A hidden menu bar or a display with no reserved region gets
     the thin strip instead.
     */
    public static func menuRegionHeight(for geometry: DisplayGeometry) -> CGFloat {
        guard geometry.frame.height > 0 else { return 0 }
        let reserved = geometry.frame.maxY - geometry.visibleFrame.maxY
        guard geometry.menuBarVisible, reserved.isFinite, reserved > 0 else {
            return min(edgeStripHeight, geometry.frame.height)
        }
        let safeArea = geometry.safeAreaTopInset.isFinite ? max(0, geometry.safeAreaTopInset) : 0
        return min(max(reserved, safeArea, edgeStripHeight), geometry.frame.height)
    }

    /**
     The bar's frame: the full width of the display, anchored to the top of `frame` rather than to
     the usable area, so it covers the menu region instead of sitting below it.
     */
    public static func barFrame(for geometry: DisplayGeometry) -> CGRect? {
        let frame = geometry.frame
        guard frame.width > 0, frame.height > 0,
              frame.minX.isFinite, frame.maxY.isFinite, frame.width.isFinite else { return nil }
        let height = menuRegionHeight(for: geometry)
        guard height > 0 else { return nil }
        return CGRect(x: frame.minX, y: frame.maxY - height, width: frame.width, height: height)
    }

    /// The `contentsScale` a layer on this display needs, so the fill stays crisp on Retina.
    public static func contentsScale(for geometry: DisplayGeometry) -> CGFloat {
        let scale = geometry.backingScaleFactor
        return scale.isFinite && scale >= 1 ? scale : 1
    }

    /// The share of the session still to run, from 1 down to 0, with a zero total treated as spent.
    public static func remainingFraction(remainingSeconds: Double, totalSeconds: Double) -> Double {
        guard totalSeconds.isFinite, totalSeconds > 0, remainingSeconds.isFinite else { return 0 }
        return min(1, max(0, remainingSeconds / totalSeconds))
    }
}
