#if canImport(ActivityCore)
import ActivityCore
#endif
import AppKit
import Foundation
import QuartzCore

/**
 What the main process asks the timer bar to be. There is no goal, no intention and no browsing
 data here: the bar only draws how much of the session is left.

 `session` carries exactly one clock — a deadline while the session runs, or a frozen remainder
 while it is paused. `enabled` is the preference; an enabled request with no session keeps the
 panels alive but off screen, so starting the next session does not rebuild them.
 */
struct TimerBarRequest: Decodable {
    let enabled: Bool
    let session: Session?
    /// The chosen `#rrggbb` fill color; absent from apps written before it could be chosen. It sits
    /// outside `session` because it is a preference, not part of the clock.
    let progressColor: String?

    struct Session: Decodable {
        /// Deadline in seconds since the epoch, or null while the session is paused.
        let endsAtEpochSeconds: Double?
        /// The frozen remainder while paused, or null while the deadline decides.
        let pausedRemainingSeconds: Double?
        /// The planned length, including edits; the bar is a share of this.
        let totalSeconds: Double

        var paused: Bool { endsAtEpochSeconds == nil }

        var isValid: Bool {
            totalSeconds.isFinite && totalSeconds >= 1 && totalSeconds <= 9_007_199_254_740 &&
                (endsAtEpochSeconds == nil) != (pausedRemainingSeconds == nil) &&
                (endsAtEpochSeconds.map { $0.isFinite && $0 > 0 && $0 <= 253_402_300_800 } ?? true) &&
                (pausedRemainingSeconds.map { $0.isFinite && $0 >= 0 && $0 <= 9_007_199_254_740 } ?? true)
        }

        var fingerprint: String {
            "\(endsAtEpochSeconds ?? -1)|\(pausedRemainingSeconds ?? -1)|\(totalSeconds)"
        }

        func remainingSeconds(now: Double) -> Double {
            guard let endsAt = endsAtEpochSeconds else { return max(0, pausedRemainingSeconds ?? 0) }
            return max(0, endsAt - now)
        }
    }

    var isValid: Bool {
        (session?.isValid ?? true) && (progressColor.map { FocusProgressColor.parse($0) != nil } ?? true)
    }

    var color: FocusProgressColor { FocusProgressColor.parseOrFallback(progressColor) }
}

enum TimerBarResult: Int32 {
    case applied = 0
    case invalidRequest = 1
    case notMainThread = 2
    case noDisplay = 3
}

private enum TimerBarStyle {
    static let leadingAlpha = 0.20
    static let trailingAlpha = 0.14
    static let maximumAnimationDriftPoints: CGFloat = 6

    static func stops(for color: FocusProgressColor) -> [CGColor] {
        [color.cgColor(alpha: leadingAlpha), color.cgColor(alpha: trailingAlpha)]
    }
}

/**
 A passive strip: it never becomes key or main, never activates the app and never takes a click.
 `isFloatingPanel` resets the window level, so it is set before the exact level asked for.
 */
final class TimerBarPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    convenience init() {
        self.init(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        isFloatingPanel = true
        level = .statusBar
        // `canJoinAllApplications` needs macOS 13; this bridge targets macOS 14. None of these
        // flags is a guarantee that macOS keeps the panel visible over every full-screen app.
        collectionBehavior = [
            .canJoinAllSpaces,
            .canJoinAllApplications,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle
        ]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        isExcludedFromWindowsMenu = true
        isMovableByWindowBackground = false
        animationBehavior = .none
    }
}

final class TimerBarContentView: NSView {
    private let gradient = CAGradientLayer()
    private let fillMask = CALayer()
    private var reduceMotion = false
    private var appliedColor = FocusProgressColor.fallback

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        gradient.colors = TimerBarStyle.stops(for: .fallback)
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        gradient.anchorPoint = .zero
        gradient.position = .zero
        fillMask.anchorPoint = .zero
        fillMask.position = .zero
        fillMask.backgroundColor = CGColor(gray: 1, alpha: 1)
        // Only the explicit shrink animation moves the mask; implicit ones would fight it, and an
        // implicit cross-fade on `colors` would make a recolor look like a change of state.
        let stillActions = ["bounds": NSNull(), "position": NSNull()] as [String: any CAAction]
        fillMask.actions = stillActions
        gradient.actions = ["bounds": NSNull(), "position": NSNull(), "colors": NSNull()]
            as [String: any CAAction]
        gradient.mask = fillMask
        layer?.addSublayer(gradient)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func apply(contentsScale: CGFloat, reduceMotion: Bool) {
        self.reduceMotion = reduceMotion
        layer?.contentsScale = contentsScale
        gradient.contentsScale = contentsScale
        fillMask.contentsScale = contentsScale
    }

    func apply(color: FocusProgressColor) {
        guard appliedColor != color else { return }
        appliedColor = color
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.colors = TimerBarStyle.stops(for: color)
        CATransaction.commit()
    }

    var drawnWidth: CGFloat { (fillMask.presentation() ?? fillMask).bounds.width }

    func layoutFill() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.bounds = CGRect(origin: .zero, size: bounds.size)
        CATransaction.commit()
    }

    func setRemaining(fraction: Double, shrinkOverSeconds: Double?) {
        let full = max(0, bounds.width)
        let width = full * CGFloat(min(1, max(0, fraction)))
        fillMask.removeAnimation(forKey: "shrink")
        guard let seconds = shrinkOverSeconds, seconds > 0, !reduceMotion else {
            setMaskWidth(width)
            return
        }
        setMaskWidth(0)
        let shrink = CABasicAnimation(keyPath: "bounds.size.width")
        shrink.fromValue = width
        shrink.toValue = 0
        shrink.duration = seconds
        shrink.timingFunction = CAMediaTimingFunction(name: .linear)
        fillMask.add(shrink, forKey: "shrink")
    }

    func stopAnimating() {
        guard fillMask.animation(forKey: "shrink") != nil else { return }
        let drawn = drawnWidth
        fillMask.removeAnimation(forKey: "shrink")
        setMaskWidth(drawn)
    }

    private func setMaskWidth(_ width: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fillMask.bounds = CGRect(x: 0, y: 0, width: width, height: max(1, bounds.height))
        CATransaction.commit()
    }
}

@MainActor
final class TimerBarController: NSObject {
    static let shared = TimerBarController()

    private var panels: [CGDirectDisplayID: (panel: TimerBarPanel, content: TimerBarContentView)] = [:]
    private var frames: [CGDirectDisplayID: NSRect] = [:]
    private var request: TimerBarRequest?
    private var observersInstalled = false
    private var appliedClock: String?
    private var appliedAppearance: Bool?

    /// Applies a request without activating the app or making any panel key.
    func update(_ request: TimerBarRequest) -> TimerBarResult {
        guard request.isValid else { return .invalidRequest }
        guard request.enabled else {
            teardown()
            return .applied
        }
        installObserversIfNeeded()
        let clockChanged = request.session?.fingerprint != self.request?.session?.fingerprint
        self.request = request
        let displays = geometry()
        syncPanels(displays)
        guard !panels.isEmpty else { return .noDisplay }
        applyColor()
        guard request.session != nil else {
            hidePanels()
            return .applied
        }
        let appearanceChanged = applyAppearance(displays)
        let geometryChanged = syncGeometry(displays)
        // On screen before the fill is animated, so a panel shown for the first time starts its
        // animation in a committed layer tree rather than one that is not rendering yet.
        for (panel, _) in panels.values where !panel.isVisible {
            panel.orderFrontRegardless()
        }
        draw(restart: clockChanged || appearanceChanged || geometryChanged)
        return .applied
    }

    /// Removes every panel and observer, for a disabled preference, a quit or data deletion.
    func shutdown() {
        teardown()
    }

    private func teardown() {
        if observersInstalled {
            NotificationCenter.default.removeObserver(self)
            NSWorkspace.shared.notificationCenter.removeObserver(self)
            DistributedNotificationCenter.default().removeObserver(self)
            observersInstalled = false
        }
        for (panel, content) in panels.values {
            content.stopAnimating()
            panel.orderOut(nil)
            panel.close()
        }
        panels.removeAll()
        frames.removeAll()
        request = nil
        appliedClock = nil
        appliedAppearance = nil
    }

    private func hidePanels() {
        appliedClock = nil
        for (panel, content) in panels.values {
            content.stopAnimating()
            if panel.isVisible { panel.orderOut(nil) }
        }
    }

    private func geometry() -> [(id: CGDirectDisplayID, geometry: TimerBarPlacement.DisplayGeometry)] {
        let menuBarVisible = NSMenu.menuBarVisible()
        return NSScreen.screens.compactMap { screen in
            guard let number = screen.deviceDescription[
                NSDeviceDescriptionKey("NSScreenNumber")
            ] as? NSNumber else { return nil }
            return (
                id: CGDirectDisplayID(number.uint32Value),
                geometry: TimerBarPlacement.DisplayGeometry(
                    frame: screen.frame,
                    visibleFrame: screen.visibleFrame,
                    safeAreaTopInset: screen.safeAreaInsets.top,
                    menuBarVisible: menuBarVisible,
                    backingScaleFactor: screen.backingScaleFactor
                )
            )
        }
    }

    private func syncPanels(_ connected: [(id: CGDirectDisplayID, geometry: TimerBarPlacement.DisplayGeometry)]) {
        let wanted = Set(connected.map(\.id))
        for (id, entry) in panels where !wanted.contains(id) {
            entry.content.stopAnimating()
            entry.panel.orderOut(nil)
            entry.panel.close()
            panels[id] = nil
            frames[id] = nil
        }
        for display in connected where panels[display.id] == nil {
            let content = TimerBarContentView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
            let panel = TimerBarPanel()
            panel.contentView = content
            panel.setAccessibilityElement(false)
            panels[display.id] = (panel: panel, content: content)
        }
    }

    private func syncGeometry(
        _ displays: [(id: CGDirectDisplayID, geometry: TimerBarPlacement.DisplayGeometry)]
    ) -> Bool {
        var changed = false
        for display in displays {
            guard let entry = panels[display.id],
                  let frame = TimerBarPlacement.barFrame(for: display.geometry),
                  frames[display.id] != frame else { continue }
            entry.panel.setFrame(frame, display: false)
            entry.content.frame = NSRect(origin: .zero, size: frame.size)
            entry.content.layoutFill()
            frames[display.id] = frame
            changed = true
        }
        return changed
    }

    private func applyColor() {
        let color = request?.color ?? .fallback
        for (_, content) in panels.values { content.apply(color: color) }
    }

    private func applyAppearance(
        _ displays: [(id: CGDirectDisplayID, geometry: TimerBarPlacement.DisplayGeometry)]
    ) -> Bool {
        let reduceMotion = FocusOverlayAppearance.current.reduceMotion
        let changed = appliedAppearance != reduceMotion
        appliedAppearance = reduceMotion
        for display in displays {
            panels[display.id]?.content.apply(
                contentsScale: TimerBarPlacement.contentsScale(for: display.geometry),
                reduceMotion: reduceMotion
            )
        }
        return changed
    }

    private func draw(restart: Bool) {
        guard let session = request?.session else { return }
        let remaining = session.remainingSeconds(now: Date().timeIntervalSince1970)
        let fraction = TimerBarPlacement.remainingFraction(
            remainingSeconds: remaining,
            totalSeconds: session.totalSeconds
        )
        let stepping = (appliedAppearance ?? false) && !session.paused
        let clock = session.fingerprint
        guard restart || stepping || appliedClock != clock || hasDrifted(fraction: fraction) else {
            return
        }
        appliedClock = clock
        for (_, content) in panels.values {
            content.setRemaining(
                fraction: fraction,
                shrinkOverSeconds: session.paused ? nil : remaining
            )
        }
    }

    /// Sleep, or an animation the window server stopped advancing, leaves a visible gap.
    private func hasDrifted(fraction: Double) -> Bool {
        for (id, entry) in panels {
            guard let frame = frames[id] else { continue }
            let expected = frame.width * CGFloat(fraction)
            if abs(expected - entry.content.drawnWidth) > TimerBarStyle.maximumAnimationDriftPoints { return true }
        }
        return false
    }

    private func installObserversIfNeeded() {
        guard !observersInstalled else { return }
        observersInstalled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(environmentChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        for name: NSNotification.Name in [
            NSWorkspace.activeSpaceDidChangeNotification,
            NSWorkspace.didWakeNotification,
            NSWorkspace.screensDidWakeNotification,
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.accessibilityDisplayOptionsDidChangeNotification
        ] {
            NSWorkspace.shared.notificationCenter.addObserver(
                self,
                selector: #selector(environmentChanged),
                name: name,
                object: nil
            )
        }
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(environmentChanged),
            name: NSNotification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil
        )
    }

    @objc private func environmentChanged() {
        guard request?.enabled == true else { return }
        let displays = geometry()
        syncPanels(displays)
        applyColor()
        guard request?.session != nil else {
            hidePanels()
            return
        }
        _ = applyAppearance(displays)
        _ = syncGeometry(displays)
        for (panel, _) in panels.values { panel.orderFrontRegardless() }
        draw(restart: true)
    }
}

@_cdecl("openhistory_timer_bar_update")
public func openHistoryTimerBarUpdate(_ requestJSON: UnsafePointer<CChar>?) -> Int32 {
    guard Thread.isMainThread else { return TimerBarResult.notMainThread.rawValue }
    guard let requestJSON,
          let request = try? JSONDecoder().decode(
              TimerBarRequest.self,
              from: Data(String(cString: requestJSON).utf8)
          ) else { return TimerBarResult.invalidRequest.rawValue }
    return MainActor.assumeIsolated { TimerBarController.shared.update(request).rawValue }
}

@_cdecl("openhistory_timer_bar_shutdown")
public func openHistoryTimerBarShutdown() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { TimerBarController.shared.shutdown() }
}
