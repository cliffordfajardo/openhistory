import CoreGraphics
import Foundation

/// A display in global Quartz coordinates (top-left origin of the primary display, y down, points).
public struct FocusWindowDisplay: Equatable, Sendable {
    public let identifier: UInt32
    public let bounds: CGRect
    public let scale: CGFloat

    public init(identifier: UInt32, bounds: CGRect, scale: CGFloat) {
        self.identifier = identifier
        self.bounds = bounds
        self.scale = scale
    }
}

/// One on-screen window as reported by the window server, in global Quartz coordinates.
public struct FocusWindowCandidate: Equatable, Sendable {
    public let windowIdentifier: UInt32
    public let processIdentifier: Int32
    public let layer: Int
    public let bounds: CGRect
    public let alpha: Double
    public let isOnScreen: Bool

    public init(
        windowIdentifier: UInt32,
        processIdentifier: Int32,
        layer: Int,
        bounds: CGRect,
        alpha: Double,
        isOnScreen: Bool
    ) {
        self.windowIdentifier = windowIdentifier
        self.processIdentifier = processIdentifier
        self.layer = layer
        self.bounds = bounds
        self.alpha = alpha
        self.isOnScreen = isOnScreen
    }
}

public enum FocusWindowTargetFailure: Error, Equatable, Sendable {
    /// No single verified window: missing, minimized, off screen or ambiguous.
    case unavailable
    /// The window covers more than one display.
    case spansDisplays
}

/// Where a window-only grayscale image is captured from and drawn.
public struct FocusWindowPlacement: Equatable, Sendable {
    public let displayIdentifier: UInt32
    /// Capture rectangle relative to the display's top-left corner, in points, on the pixel grid.
    public let sourceRect: CGRect
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let scale: CGFloat
    /// The same rectangle in global AppKit coordinates (bottom-left origin, y up).
    public let appKitFrame: CGRect
}

/// What a window-only grayscale reminder should do after new geometry or foreground evidence.
public enum FocusWindowFollowAction: Equatable, Sendable {
    /// Show the current image (it may already be showing).
    case reveal
    /// Hide the image until fresh evidence confirms the focused window.
    case await
    /// Capture a new window or rectangle; `visible` is false while confirmation is pending.
    case restart(windowIdentifier: UInt32, placement: FocusWindowPlacement, visible: Bool)
    case fail(FocusWindowTargetFailure)
}

public enum FocusWindowTargeting {
    /// Largest difference between Accessibility and window-server geometry for the same window.
    public static let matchTolerance: CGFloat = 1

    public static func quartzRect(fromAppKit rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    public static func appKitRect(fromQuartz rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// The one normal-layer, visible window of `processIdentifier` whose bounds equal `frame`.
    /// Zero or several matches are rejected rather than guessed.
    public static func matchWindow(
        frame: CGRect,
        processIdentifier: Int32,
        candidates: [FocusWindowCandidate]
    ) -> Result<FocusWindowCandidate, FocusWindowTargetFailure> {
        guard isUsable(frame) else { return .failure(.unavailable) }
        let matches = candidates.filter { candidate in
            candidate.processIdentifier == processIdentifier &&
                candidate.layer == 0 &&
                candidate.isOnScreen &&
                candidate.alpha > 0 &&
                isUsable(candidate.bounds) &&
                approximatelyEqual(candidate.bounds, frame)
        }
        guard matches.count == 1, let match = matches.first else { return .failure(.unavailable) }
        return .success(match)
    }

    /// Crops `windowBounds` to the single display it is on and aligns it to that display's pixels.
    public static func placement(
        windowBounds: CGRect,
        displays: [FocusWindowDisplay],
        primaryHeight: CGFloat
    ) -> Result<FocusWindowPlacement, FocusWindowTargetFailure> {
        guard isUsable(windowBounds), primaryHeight.isFinite, primaryHeight > 0 else {
            return .failure(.unavailable)
        }
        let touching = displays.filter { display in
            let overlap = display.bounds.intersection(windowBounds)
            return !overlap.isNull && overlap.width > 0 && overlap.height > 0
        }
        guard touching.count <= 1 else { return .failure(.spansDisplays) }
        guard let display = touching.first, display.scale.isFinite, display.scale > 0 else {
            return .failure(.unavailable)
        }
        let visible = display.bounds.intersection(windowBounds)
        let scale = display.scale
        let minX = ((visible.minX - display.bounds.minX) * scale).rounded()
        let minY = ((visible.minY - display.bounds.minY) * scale).rounded()
        let maxX = ((visible.maxX - display.bounds.minX) * scale).rounded()
        let maxY = ((visible.maxY - display.bounds.minY) * scale).rounded()
        let pixelWidth = Int(maxX - minX)
        let pixelHeight = Int(maxY - minY)
        guard pixelWidth >= 2, pixelHeight >= 2 else { return .failure(.unavailable) }
        let sourceRect = CGRect(
            x: minX / scale,
            y: minY / scale,
            width: CGFloat(pixelWidth) / scale,
            height: CGFloat(pixelHeight) / scale
        )
        let global = sourceRect.offsetBy(dx: display.bounds.minX, dy: display.bounds.minY)
        return .success(FocusWindowPlacement(
            displayIdentifier: display.identifier,
            sourceRect: sourceRect,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            scale: scale,
            appKitFrame: appKitRect(fromQuartz: global, primaryHeight: primaryHeight)
        ))
    }

    /// True when an observed host is `rule` or one of its subdomains, ignoring one leading "www.".
    public static func domainMatches(_ observed: String?, rule: String?) -> Bool {
        guard let observed, let rule = rule?.lowercased(), !rule.isEmpty else { return false }
        var host = observed.lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        return host == rule || host.hasSuffix("." + rule)
    }

    /// Decides how to follow the target. `evidenceMatches` is nil for geometry-only changes, true
    /// when fresh foreground evidence for this process shows the reminder's site, false otherwise.
    /// Another window is adopted only with matching evidence sampled from it.
    public static func follow(
        currentWindow: UInt32?,
        currentPlacement: FocusWindowPlacement?,
        confirmed: Bool,
        evidenceMatches: Bool?,
        resolved: Result<(windowIdentifier: UInt32, placement: FocusWindowPlacement), FocusWindowTargetFailure>
    ) -> FocusWindowFollowAction {
        if evidenceMatches == false { return .await }
        let target: (windowIdentifier: UInt32, placement: FocusWindowPlacement)
        switch resolved {
        case .failure(let failure): return .fail(failure)
        case .success(let value): target = value
        }
        let visible = confirmed || evidenceMatches == true
        guard target.windowIdentifier == currentWindow else {
            return evidenceMatches == true
                ? .restart(windowIdentifier: target.windowIdentifier, placement: target.placement, visible: true)
                : .await
        }
        guard target.placement == currentPlacement else {
            return .restart(windowIdentifier: target.windowIdentifier, placement: target.placement, visible: visible)
        }
        return visible ? .reveal : .await
    }

    private static func isUsable(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite && rect.minX.isFinite && rect.minY.isFinite &&
            rect.width.isFinite && rect.height.isFinite && rect.width > 0 && rect.height > 0
    }

    private static func approximatelyEqual(_ first: CGRect, _ second: CGRect) -> Bool {
        abs(first.minX - second.minX) <= matchTolerance &&
            abs(first.minY - second.minY) <= matchTolerance &&
            abs(first.maxX - second.maxX) <= matchTolerance &&
            abs(first.maxY - second.maxY) <= matchTolerance
    }
}
