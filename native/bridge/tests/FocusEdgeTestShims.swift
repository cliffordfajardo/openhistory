import ActivityCore
import AppKit
import ApplicationServices

// Compile-time replacements: no ScreenCaptureKit or Color Filters code is linked.
enum FocusGrayscaleFailure: String {
    case permissionNeeded, unsupported, captureFailed, noFrame, displayUnavailable
    case windowUnavailable, windowSpansDisplays
}
enum FocusGrayscaleEvent { case active, failed(FocusGrayscaleFailure), foregroundChanged }

final class AccessibilityReader {
    func focusedWindowFrame(processIdentifier: pid_t) -> CGRect? { nil }
}

@MainActor final class FocusGrayscaleController {
    static let shared = FocusGrayscaleController()
    private(set) var starts = 0
    private(set) var stops = 0
    private(set) var isActive = false
    var onEvent: ((FocusGrayscaleEvent) -> Void)?
    func start(screen: NSScreen, displayID: CGDirectDisplayID,
               expectedProcessIdentifier: Int32?, onEvent: @escaping (FocusGrayscaleEvent) -> Void) -> FocusGrayscaleFailure? {
        starts += 1
        isActive = true
        self.onEvent = onEvent
        return nil
    }
    func stop() { stops += 1; isActive = false; onEvent = nil }
    func displayChanged(to screen: NSScreen?) {}
}

@MainActor final class FocusWindowGrayscaleController {
    static let shared = FocusWindowGrayscaleController()
    private(set) var starts = 0
    private(set) var stops = 0
    private(set) var isActive = false
    var onEvent: ((FocusGrayscaleEvent) -> Void)?
    func start(processIdentifier: Int32?, domainRule: String?, preview: Bool,
               onEvent: @escaping (FocusGrayscaleEvent) -> Void) -> FocusGrayscaleFailure? {
        starts += 1
        isActive = true
        self.onEvent = onEvent
        return nil
    }
    func stop() { stops += 1; isActive = false; onEvent = nil }
    func foregroundEvidence(_ evidence: ForegroundEvidence, sampledWindow: AXUIElement?) {}
    func geometryMayHaveChanged() {}
    func applicationActivationChanged() {}
}
