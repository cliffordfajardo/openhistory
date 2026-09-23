import CoreGraphics
import Foundation

/// Where the floating Focus bar sits, in global AppKit coordinates (bottom-left origin, y up).
public enum FocusBarPlacement {
    /// Gap kept below the bar, inside the usable area, so it floats just above the Dock.
    public static let bottomMargin: CGFloat = 16

    /// The compact width a new bar, and **Reset Width**, starts from.
    public static let defaultWidth: CGFloat = 460
    /// Narrow enough to be out of the way, wide enough to keep the goal and every control legible.
    public static let minimumWidth: CGFloat = 360
    /// A generous ceiling; the usable width of the display the bar is on is the real limit.
    public static let maximumWidth: CGFloat = 20_000

    /// Which edge a resize drag holds on to; the opposite edge stays where it is.
    public enum HorizontalEdge: Equatable {
        case leading
        case trailing
    }

    /// Bottom centre of the usable area of the display the bar starts on, trimmed to fit it.
    public static func defaultFrame(size: CGSize, in visibleFrame: CGRect) -> CGRect {
        let width = min(size.width, visibleFrame.width)
        let height = min(size.height, visibleFrame.height)
        return CGRect(
            x: visibleFrame.midX - width / 2,
            y: min(visibleFrame.minY + bottomMargin, visibleFrame.maxY - height),
            width: width,
            height: height
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

    /**
     The frame a horizontal resize drag has reached: `deltaX` is how far the pointer moved from
     where the drag started, `current` the frame it started from. The edge that is not dragged
     stays put, the width stays between the minimum and the usable width of the bar's display,
     and the result is kept fully on that display.
     */
    public static func resizedFrame(
        current: CGRect,
        edge: HorizontalEdge,
        deltaX: CGFloat,
        visibleFrames: [CGRect]
    ) -> CGRect? {
        guard let host = bestVisibleFrame(for: current, in: visibleFrames) ?? visibleFrames.first else {
            return nil
        }
        let start = clamp(current, into: host)
        let available = edge == .trailing ? host.maxX - start.minX : start.maxX - host.minX
        let requested = edge == .trailing ? start.width + deltaX : start.width - deltaX
        let width = min(clampWidth(requested, in: host), available)
        let x = edge == .trailing ? start.minX : start.maxX - width
        let resized = CGRect(x: x, y: start.minY, width: width, height: start.height)
        return clamp(resized, into: host).integral
    }

    /**
     The whole usable width of the display holding most of the bar, keeping the bar's height and
     the row it is already on. A bar on no connected display has no row worth keeping, so it takes
     the default one just above the Dock instead of the edge it would otherwise be pulled to.
     */
    public static func fitFrame(current: CGRect, visibleFrames: [CGRect]) -> CGRect? {
        let onScreen = bestVisibleFrame(for: current, in: visibleFrames)
        guard let host = onScreen ?? visibleFrames.first else { return nil }
        let fitted = CGRect(
            x: host.minX,
            y: onScreen == nil ? host.minY + bottomMargin : current.minY,
            width: clampWidth(host.width, in: host),
            height: current.height
        )
        return clamp(fitted, into: host).integral
    }

    /// The rectangle clamp handles displays narrower than the minimum supported width.
    public static func clampWidth(_ width: CGFloat, in visibleFrame: CGRect) -> CGFloat {
        let ceiling = max(minimumWidth, min(maximumWidth, visibleFrame.width))
        return min(max(width.isFinite ? width : defaultWidth, minimumWidth), ceiling)
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
