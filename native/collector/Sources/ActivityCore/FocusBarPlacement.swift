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

    /// The compact height a new bar, and **Reset Height**, starts from.
    public static let defaultHeight: CGFloat = 54
    /// Short enough to be out of the way, tall enough for the 28-point controls and their margin.
    public static let minimumHeight: CGFloat = 40
    /// A generous ceiling; the usable height of the display the bar is on is the real limit.
    public static let maximumHeight: CGFloat = 20_000

    /// How far in from a vertical edge a press resizes instead of moving the bar.
    public static let horizontalHandleInset: CGFloat = 8
    /// Shorter than the horizontal inset so the short bar keeps a usable band for its controls.
    public static let verticalHandleInset: CGFloat = 6

    /// Which side edge a resize drag holds on to; the opposite edge stays where it is.
    public enum HorizontalEdge: Equatable {
        case leading
        case trailing
    }

    /// Which top or bottom edge a resize drag holds on to, in AppKit coordinates (y up).
    public enum VerticalEdge: Equatable {
        case bottom
        case top
    }

    /**
     What a resize drag is holding: one side edge, one top or bottom edge, or a corner that moves
     both at once. There is no case for "neither", so a drag can never be started without an edge,
     and no case that names two edges on the same axis.
     */
    public enum ResizeHandle: Equatable {
        case horizontal(HorizontalEdge)
        case vertical(VerticalEdge)
        case corner(HorizontalEdge, VerticalEdge)

        public var horizontal: HorizontalEdge? {
            switch self {
            case .horizontal(let edge), .corner(let edge, _): return edge
            case .vertical: return nil
            }
        }

        public var vertical: VerticalEdge? {
            switch self {
            case .vertical(let edge), .corner(_, let edge): return edge
            case .horizontal: return nil
            }
        }
    }

    /**
     Which handle a press inside the capsule lands on, or nil for the band that moves the bar.
     `point` and `bounds` are in the bar's own coordinates with y up. A point inside both insets is
     a corner, so the corners win over the edges they are part of.
     */
    public static func handle(at point: CGPoint, in bounds: CGRect) -> ResizeHandle? {
        guard bounds.contains(point) else { return nil }
        let horizontal: HorizontalEdge? = point.x <= bounds.minX + horizontalHandleInset ? .leading
            : point.x >= bounds.maxX - horizontalHandleInset ? .trailing
            : nil
        let vertical: VerticalEdge? = point.y <= bounds.minY + verticalHandleInset ? .bottom
            : point.y >= bounds.maxY - verticalHandleInset ? .top
            : nil
        switch (horizontal, vertical) {
        case (.some(let side), .some(let end)): return .corner(side, end)
        case (.some(let side), .none): return .horizontal(side)
        case (.none, .some(let end)): return .vertical(end)
        case (.none, .none): return nil
        }
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
     The frame a resize drag has reached: `delta` is how far the pointer moved on screen since the
     drag started and `start` the frame it started from, so every step of one drag is measured from
     the same immutable rectangle rather than from the frame the previous step left behind. Only
     the edges the handle names move; the opposite ones stay exactly where they were. Each axis is
     kept between its minimum and the usable extent of the bar's display, and a corner applies both
     limits from that same starting frame.
     */
    public static func resizedFrame(
        start: CGRect,
        handle: ResizeHandle,
        delta: CGSize,
        visibleFrames: [CGRect]
    ) -> CGRect? {
        guard let host = bestVisibleFrame(for: start, in: visibleFrames) ?? visibleFrames.first else {
            return nil
        }
        let anchored = clamp(start, into: host)
        var resized = anchored
        if let edge = handle.horizontal {
            let available = edge == .trailing ? host.maxX - anchored.minX : anchored.maxX - host.minX
            let requested = edge == .trailing ? anchored.width + delta.width : anchored.width - delta.width
            let width = min(clampWidth(requested, in: host), available)
            resized.size.width = width
            resized.origin.x = edge == .trailing ? anchored.minX : anchored.maxX - width
        }
        if let edge = handle.vertical {
            let available = edge == .top ? host.maxY - anchored.minY : anchored.maxY - host.minY
            let requested = edge == .top ? anchored.height + delta.height : anchored.height - delta.height
            let height = min(clampHeight(requested, in: host), available)
            resized.size.height = height
            resized.origin.y = edge == .top ? anchored.minY : anchored.maxY - height
        }
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

    public static func persistedSize(
        after handle: ResizeHandle,
        started: CGSize,
        rendered: CGSize,
        requested: CGSize
    ) -> CGSize {
        CGSize(
            width: handle.horizontal != nil && rendered.width != started.width && rendered.width >= minimumWidth ? rendered.width : requested.width,
            height: handle.vertical != nil && rendered.height != started.height && rendered.height >= minimumHeight ? rendered.height : requested.height
        )
    }

    /// The rectangle clamp handles displays narrower than the minimum supported width.
    public static func clampWidth(_ width: CGFloat, in visibleFrame: CGRect) -> CGFloat {
        let ceiling = max(minimumWidth, min(maximumWidth, visibleFrame.width))
        return min(max(width.isFinite ? width : defaultWidth, minimumWidth), ceiling)
    }

    /// The rectangle clamp handles displays shorter than the minimum supported height.
    public static func clampHeight(_ height: CGFloat, in visibleFrame: CGRect) -> CGFloat {
        let ceiling = max(minimumHeight, min(maximumHeight, visibleFrame.height))
        return min(max(height.isFinite ? height : defaultHeight, minimumHeight), ceiling)
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
