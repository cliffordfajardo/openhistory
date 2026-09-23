import CoreGraphics
import Foundation

/// Where the floating Focus bar sits, in global AppKit coordinates (bottom-left origin, y up).
public enum FocusBarPlacement {
    /// Gap kept below the bar, inside the usable area, so it floats just above the Dock.
    public static let bottomMargin: CGFloat = 16

    /// Bottom centre of the usable area of the display the bar starts on.
    public static func defaultFrame(size: CGSize, in visibleFrame: CGRect) -> CGRect {
        CGRect(
            x: visibleFrame.midX - size.width / 2,
            y: visibleFrame.minY + bottomMargin,
            width: size.width,
            height: size.height
        ).integral
    }

    /**
     The frame to show the bar at: the saved corner pulled fully inside whichever usable area
     holds most of it, or the default position when no saved corner is on a connected display.
     `visibleFrames` are the usable areas (menu bar and Dock already excluded), primary first.
     */
    public static func frame(
        preferredOrigin: CGPoint?,
        size: CGSize,
        visibleFrames: [CGRect]
    ) -> CGRect? {
        guard let primary = visibleFrames.first, size.width > 0, size.height > 0 else { return nil }
        if let preferredOrigin {
            let requested = CGRect(origin: preferredOrigin, size: size)
            if let host = bestVisibleFrame(for: requested, in: visibleFrames) {
                return clamp(requested, into: host).integral
            }
        }
        return defaultFrame(size: size, in: primary)
    }

    /// The usable area holding the largest part of `rect`, or nil when none of it is on screen.
    private static func bestVisibleFrame(for rect: CGRect, in visibleFrames: [CGRect]) -> CGRect? {
        var best: (frame: CGRect, area: CGFloat)?
        for frame in visibleFrames {
            let intersection = frame.intersection(rect)
            let area = intersection.isNull ? 0 : intersection.width * intersection.height
            if area > (best?.area ?? 0) { best = (frame, area) }
        }
        return best?.frame
    }

    private static func clamp(_ rect: CGRect, into frame: CGRect) -> CGRect {
        let width = min(rect.width, frame.width)
        let height = min(rect.height, frame.height)
        return CGRect(
            x: min(max(rect.minX, frame.minX), frame.maxX - width),
            y: min(max(rect.minY, frame.minY), frame.maxY - height),
            width: width,
            height: height
        )
    }
}
