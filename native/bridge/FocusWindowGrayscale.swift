import ActivityCore
import AppKit
@preconcurrency import ApplicationServices
import Foundation

private func focusWindowAccessibilityCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ context: UnsafeMutableRawPointer?
) {
    let name = notification as String
    MainActor.assumeIsolated {
        FocusWindowGrayscaleController.shared.accessibilityNotification(name, observer: observer)
    }
}

@MainActor
final class FocusWindowGrayscaleController {
    static let shared = FocusWindowGrayscaleController()

    private struct Resolved {
        let windowIdentifier: CGWindowID
        let placement: FocusWindowPlacement
        let accessibilityWindow: AXUIElement?
    }

    @MainActor
    private final class Session {
        let generation: UInt64
        let preview: Bool
        let processIdentifier: pid_t
        let domainRule: String?
        let previewWindow: NSWindow?
        let onEvent: @MainActor (FocusGrayscaleEvent) -> Void
        var windowIdentifier: CGWindowID
        var placement: FocusWindowPlacement
        var confirmed: Bool
        var observer: AXObserver?
        var notificationTokens: [NSObjectProtocol] = []
        var settle: Task<Void, Never>?
        var confirmation: Task<Void, Never>?

        init(
            generation: UInt64,
            preview: Bool,
            processIdentifier: pid_t,
            domainRule: String?,
            previewWindow: NSWindow?,
            resolved: Resolved,
            onEvent: @escaping @MainActor (FocusGrayscaleEvent) -> Void
        ) {
            self.generation = generation
            self.preview = preview
            self.processIdentifier = processIdentifier
            self.domainRule = domainRule
            self.previewWindow = previewWindow
            self.onEvent = onEvent
            windowIdentifier = resolved.windowIdentifier
            placement = resolved.placement
            confirmed = preview
        }
    }

    private let accessibility = AccessibilityReader()
    private var generation: UInt64 = 0
    private var session: Session?

    var isActive: Bool { session != nil }

    func start(
        processIdentifier: pid_t?,
        domainRule: String?,
        preview: Bool,
        onEvent: @escaping @MainActor (FocusGrayscaleEvent) -> Void
    ) -> FocusGrayscaleFailure? {
        stop()
        guard CGPreflightScreenCaptureAccess() else { return .permissionNeeded }
        let previewWindow = preview ? Self.previewWindow() : nil
        let target: pid_t
        if preview {
            target = ProcessInfo.processInfo.processIdentifier
        } else {
            guard let processIdentifier, processIdentifier > 0, domainRule?.isEmpty == false else {
                return .windowUnavailable
            }
            target = processIdentifier
        }
        let resolved: Resolved
        switch preview ? resolvePreview(previewWindow) : resolveFocusedWindow(of: target) {
        case .success(let value): resolved = value
        case .failure(let failure): return Self.failure(failure)
        }

        generation &+= 1
        let session = Session(
            generation: generation,
            preview: preview,
            processIdentifier: target,
            domainRule: domainRule,
            previewWindow: previewWindow,
            resolved: resolved,
            onEvent: onEvent
        )
        self.session = session
        if let failure = beginCapture(session, visible: session.confirmed) {
            self.session = nil
            generation &+= 1
            return failure
        }
        if preview {
            observePreviewWindow(session)
        } else {
            observe(session, window: resolved.accessibilityWindow)
            awaitConfirmation(session)
        }
        return nil
    }

    func stop() {
        guard let session else { return }
        self.session = nil
        generation &+= 1
        session.settle?.cancel()
        session.confirmation?.cancel()
        removeAccessibilityObserver(session)
        let center = NotificationCenter.default
        for token in session.notificationTokens { center.removeObserver(token) }
        session.notificationTokens.removeAll()
        FocusGrayscaleController.shared.stop()
    }

    /// `sampledWindow` is the AX window used to read this evidence's domain.
    func foregroundEvidence(_ evidence: ForegroundEvidence, sampledWindow: AXUIElement?) {
        guard let session, !session.preview, evidence.kind == .browser,
              evidence.processIdentifier == session.processIdentifier else { return }
        let matches = FocusWindowTargeting.domainMatches(evidence.domain, rule: session.domainRule)
        let resolved = resolveFocusedWindow(of: session.processIdentifier)
        if matches {
            guard case .success(let target) = resolved,
                  let sampledWindow, let targetWindow = target.accessibilityWindow,
                  CFEqual(sampledWindow, targetWindow) else {
                FocusGrayscaleController.shared.setSuppressed(true)
                session.confirmed = false
                awaitConfirmation(session)
                return
            }
        }
        apply(session, evidenceMatches: matches, resolved: resolved)
    }

    func geometryMayHaveChanged() {
        guard let session else { return }
        FocusGrayscaleController.shared.setSuppressed(true)
        scheduleSettle(session)
    }

    func applicationActivationChanged() {
        guard let session, session.preview else { return }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == session.processIdentifier {
            scheduleSettle(session)
        } else {
            session.settle?.cancel()
            FocusGrayscaleController.shared.setSuppressed(true)
        }
    }

    fileprivate func accessibilityNotification(_ name: String, observer: AXObserver) {
        guard let session, let current = session.observer, CFEqual(current, observer) else { return }
        FocusGrayscaleController.shared.setSuppressed(true)
        switch name {
        case kAXMovedNotification, kAXResizedNotification:
            scheduleSettle(session)
        default:
            session.settle?.cancel()
            session.confirmed = false
            awaitConfirmation(session)
        }
    }

    private func current(_ generation: UInt64) -> Session? {
        guard let session, session.generation == generation, self.generation == generation else { return nil }
        return session
    }

    private func scheduleSettle(_ session: Session) {
        session.settle?.cancel()
        let generation = session.generation
        session.settle = Task { @MainActor in
            try? await Task.sleep(for: FocusGrayscaleTiming.windowSettleDelay)
            guard !Task.isCancelled else { return }
            FocusWindowGrayscaleController.shared.settled(generation)
        }
    }

    private func settled(_ generation: UInt64) {
        guard let session = current(generation) else { return }
        if session.preview,
           NSWorkspace.shared.frontmostApplication?.processIdentifier != session.processIdentifier {
            return
        }
        apply(session, evidenceMatches: nil)
    }

    private func apply(
        _ session: Session,
        evidenceMatches: Bool?,
        resolved suppliedResolution: Result<Resolved, FocusWindowTargetFailure>? = nil
    ) {
        let resolved = suppliedResolution ?? (session.preview
            ? resolvePreview(session.previewWindow)
            : resolveFocusedWindow(of: session.processIdentifier))
        let action = FocusWindowTargeting.follow(
            currentWindow: session.windowIdentifier,
            currentPlacement: session.placement,
            confirmed: session.confirmed,
            evidenceMatches: evidenceMatches,
            resolved: resolved.map { (windowIdentifier: $0.windowIdentifier, placement: $0.placement) }
        )
        switch action {
        case .reveal:
            session.confirmed = true
            session.confirmation?.cancel()
            FocusGrayscaleController.shared.setSuppressed(false)
        case .await:
            FocusGrayscaleController.shared.setSuppressed(true)
            session.confirmed = false
            awaitConfirmation(session)
        case let .restart(windowIdentifier, placement, visible):
            FocusGrayscaleController.shared.setSuppressed(true)
            let windowChanged = windowIdentifier != session.windowIdentifier
            session.windowIdentifier = windowIdentifier
            session.placement = placement
            session.confirmed = visible
            if let failure = beginCapture(session, visible: visible) {
                fail(session, failure)
                return
            }
            if windowChanged, !session.preview, case .success(let value) = resolved {
                observe(session, window: value.accessibilityWindow)
            }
            if visible {
                session.confirmation?.cancel()
            } else {
                awaitConfirmation(session)
            }
        case .fail(let failure):
            fail(session, Self.failure(failure))
        }
    }

    private func awaitConfirmation(_ session: Session) {
        guard session.confirmation == nil || session.confirmation?.isCancelled == true else { return }
        let generation = session.generation
        session.confirmation = Task { @MainActor in
            try? await Task.sleep(for: FocusGrayscaleTiming.windowConfirmationTimeout)
            guard !Task.isCancelled else { return }
            FocusWindowGrayscaleController.shared.confirmationTimedOut(generation)
        }
    }

    private func confirmationTimedOut(_ generation: UInt64) {
        guard let session = current(generation) else { return }
        session.confirmation = nil
        guard !session.confirmed else { return }
        fail(session, .windowUnavailable)
    }

    private func beginCapture(_ session: Session, visible: Bool) -> FocusGrayscaleFailure? {
        let placement = session.placement
        guard let screen = NSScreen.screens.first(where: { Self.displayIdentifier($0) == placement.displayIdentifier }) else {
            return .windowUnavailable
        }
        let generation = session.generation
        return FocusGrayscaleController.shared.start(
            screen: screen,
            displayID: placement.displayIdentifier,
            expectedProcessIdentifier: session.preview ? nil : session.processIdentifier,
            region: FocusGrayscaleRegion(
                sourceRect: placement.sourceRect,
                panelFrame: placement.appKitFrame,
                pixelWidth: placement.pixelWidth,
                pixelHeight: placement.pixelHeight
            ),
            suppressed: !visible,
            onEvent: { event in
                FocusWindowGrayscaleController.shared.grayscaleEvent(event, generation: generation)
            }
        )
    }

    private func grayscaleEvent(_ event: FocusGrayscaleEvent, generation: UInt64) {
        guard let session = current(generation) else { return }
        if case .failed = event { stop() }
        session.onEvent(event)
    }

    private func fail(_ session: Session, _ failure: FocusGrayscaleFailure) {
        guard current(session.generation) === session else { return }
        stop()
        session.onEvent(.failed(failure))
    }

    private func resolveFocusedWindow(of processIdentifier: pid_t) -> Result<Resolved, FocusWindowTargetFailure> {
        guard AXIsProcessTrusted(),
              let window = accessibility.focusedWindow(processIdentifier: processIdentifier),
              (Self.booleanAttribute(window, kAXMinimizedAttribute) ?? false) == false,
              let frame = Self.frame(of: window) else { return .failure(.unavailable) }
        return resolve(frame: frame, processIdentifier: processIdentifier, accessibilityWindow: window)
    }

    private func resolvePreview(_ window: NSWindow?) -> Result<Resolved, FocusWindowTargetFailure> {
        guard let window, window.isVisible, !window.isMiniaturized, window.isOnActiveSpace,
              window.windowNumber > 0,
              let primary = NSScreen.screens.first else { return .failure(.unavailable) }
        let frame = FocusWindowTargeting.quartzRect(fromAppKit: window.frame, primaryHeight: primary.frame.height)
        let resolved = resolve(
            frame: frame,
            processIdentifier: ProcessInfo.processInfo.processIdentifier,
            accessibilityWindow: nil
        )
        if case .success(let value) = resolved, value.windowIdentifier != CGWindowID(window.windowNumber) {
            return .failure(.unavailable)
        }
        return resolved
    }

    private func resolve(
        frame: CGRect,
        processIdentifier: pid_t,
        accessibilityWindow: AXUIElement?
    ) -> Result<Resolved, FocusWindowTargetFailure> {
        guard let primary = NSScreen.screens.first else { return .failure(.unavailable) }
        let match = FocusWindowTargeting.matchWindow(
            frame: frame,
            processIdentifier: processIdentifier,
            candidates: Self.windowCandidates()
        )
        let candidate: FocusWindowCandidate
        switch match {
        case .success(let value): candidate = value
        case .failure(let failure): return .failure(failure)
        }
        let primaryHeight = primary.frame.height
        let displays = NSScreen.screens.compactMap { screen -> FocusWindowDisplay? in
            guard let identifier = Self.displayIdentifier(screen) else { return nil }
            return FocusWindowDisplay(
                identifier: identifier,
                bounds: FocusWindowTargeting.quartzRect(fromAppKit: screen.frame, primaryHeight: primaryHeight),
                scale: screen.backingScaleFactor
            )
        }
        return FocusWindowTargeting.placement(
            windowBounds: candidate.bounds,
            displays: displays,
            primaryHeight: primaryHeight
        ).map { placement in
            Resolved(
                windowIdentifier: candidate.windowIdentifier,
                placement: placement,
                accessibilityWindow: accessibilityWindow
            )
        }
    }

    private static func previewWindow() -> NSWindow? {
        [NSApp.keyWindow, NSApp.mainWindow].compactMap { $0 }.first {
            !($0 is FocusOverlayPanel) && !($0 is NSPanel) && $0.isVisible
        }
    }

    private static func windowCandidates() -> [FocusWindowCandidate] {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return [] }
        return windows.compactMap { window in
            guard let number = window[kCGWindowNumber as String] as? NSNumber,
                  let owner = window[kCGWindowOwnerPID as String] as? NSNumber,
                  let layer = window[kCGWindowLayer as String] as? NSNumber,
                  let boundsValue = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsValue as CFDictionary) else { return nil }
            return FocusWindowCandidate(
                windowIdentifier: number.uint32Value,
                processIdentifier: owner.int32Value,
                layer: layer.intValue,
                bounds: bounds,
                alpha: (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                isOnScreen: (window[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
            )
        }
    }

    private static func frame(of window: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue, let sizeValue,
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(positionValue, to: AXValue.self), .cgPoint, &position),
              AXValueGetValue(unsafeDowncast(sizeValue, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: position, size: size)
    }

    private static func booleanAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return (value as? NSNumber)?.boolValue
    }

    private static func displayIdentifier(_ screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private static func failure(_ failure: FocusWindowTargetFailure) -> FocusGrayscaleFailure {
        switch failure {
        case .unavailable: .windowUnavailable
        case .spansDisplays: .windowSpansDisplays
        }
    }

    private func observe(_ session: Session, window: AXUIElement?) {
        removeAccessibilityObserver(session)
        guard let window else { return }
        var created: AXObserver?
        guard AXObserverCreate(session.processIdentifier, focusWindowAccessibilityCallback, &created) == .success,
              let observer = created else { return }
        for name in [
            kAXMovedNotification,
            kAXResizedNotification,
            kAXWindowMiniaturizedNotification,
            kAXUIElementDestroyedNotification
        ] {
            _ = AXObserverAddNotification(observer, window, name as CFString, nil)
        }
        _ = AXObserverAddNotification(
            observer,
            AXUIElementCreateApplication(session.processIdentifier),
            kAXFocusedWindowChangedNotification as CFString,
            nil
        )
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        session.observer = observer
    }

    private func removeAccessibilityObserver(_ session: Session) {
        guard let observer = session.observer else { return }
        session.observer = nil
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    }

    private func observePreviewWindow(_ session: Session) {
        guard let window = session.previewWindow else { return }
        let center = NotificationCenter.default
        let generation = session.generation
        let names: [Notification.Name] = [
            NSWindow.didMoveNotification,
            NSWindow.didResizeNotification,
            NSWindow.didChangeScreenNotification,
            NSWindow.didMiniaturizeNotification,
            NSWindow.willCloseNotification
        ]
        session.notificationTokens = names.map { name in
            center.addObserver(forName: name, object: window, queue: .main) { _ in
                MainActor.assumeIsolated {
                    guard let session = FocusWindowGrayscaleController.shared.current(generation) else { return }
                    FocusGrayscaleController.shared.setSuppressed(true)
                    FocusWindowGrayscaleController.shared.scheduleSettle(session)
                }
            }
        }
    }
}
