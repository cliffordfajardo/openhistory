import ActivityCore
import AppKit
import Foundation
import QuartzCore

struct FocusBarSnapshot: Decodable {
    let sessionId: String
    let goalTitle: String
    let intention: String
    let endsAtEpochSeconds: Double?
    let pausedRemainingSeconds: Double?
    let totalSeconds: Double
    let snoozed: Bool
    let position: Position?
    /// Saved width; absent from bridges written before the bar could be resized.
    let width: Double?
    /// The chosen `#rrggbb` fill color; absent from apps written before it could be chosen.
    let progressColor: String?

    struct Position: Decodable {
        let x: Double
        let y: Double
    }

    var paused: Bool { endsAtEpochSeconds == nil }

    var progress: FocusProgressColor { FocusProgressColor.parseOrFallback(progressColor) }

    var clockFingerprint: String {
        "\(sessionId)|\(endsAtEpochSeconds ?? -1)|\(pausedRemainingSeconds ?? -1)|\(totalSeconds)"
    }

    var barWidth: CGFloat {
        let requested = CGFloat(width ?? Double(FocusBarPlacement.defaultWidth))
        return min(max(requested, FocusBarPlacement.minimumWidth), FocusBarPlacement.maximumWidth)
    }

    /// The same safe-integer millisecond bound the timer bar uses: a session that was extended
    /// past a day is still a session the app can legally hold, so the bar draws it rather than
    /// refusing it.
    private static let maximumSeconds: Double = 9_007_199_254_740

    var isValid: Bool {
        guard progressColor.map({ FocusProgressColor.parse($0) != nil }) ?? true else { return false }
        return !sessionId.isEmpty && sessionId.count <= 100 &&
            goalTitle.count <= 300 && intention.count <= 600 &&
            totalSeconds >= 1 && totalSeconds <= Self.maximumSeconds &&
            (endsAtEpochSeconds == nil) != (pausedRemainingSeconds == nil) &&
            (endsAtEpochSeconds.map { $0 > 0 && $0.isFinite } ?? true) &&
            (pausedRemainingSeconds.map { $0 >= 0 && $0 <= Self.maximumSeconds } ?? true) &&
            (position.map { $0.x.isFinite && $0.y.isFinite && abs($0.x) <= 200_000 && abs($0.y) <= 200_000 } ?? true) &&
            (width.map {
                $0.isFinite && $0 >= Double(FocusBarPlacement.minimumWidth) &&
                    $0 <= Double(FocusBarPlacement.maximumWidth)
            } ?? true)
    }
}

enum FocusBarResult: Int32 {
    case shown = 0
    case invalidRequest = 1
    case notMainThread = 2
    case noDisplay = 3
}

private enum FocusBarStyle {
    static let height: CGFloat = 54
    static let defaultSize = NSSize(width: FocusBarPlacement.defaultWidth, height: height)
    static let cornerRadius: CGFloat = 14
    static let padding: CGFloat = 14
    static let controlSize: CGFloat = 28
    static let controlGap: CGFloat = 4
    static let countdownWidth: CGFloat = 66
    static let revealDuration: TimeInterval = 0.12
    /// How far in from a vertical edge a press starts a resize instead of a move.
    static let resizeEdge: CGFloat = 8
    static let gripSize = NSSize(width: 2, height: 16)
    /// How far the fill may sit from the anchored clock before it is corrected, in points.
    static let progressDrift: CGFloat = 4
    static let running = CGColor(srgbRed: 0.36, green: 0.62, blue: 0.45, alpha: 1)
    static let paused = CGColor(srgbRed: 0.62, green: 0.58, blue: 0.44, alpha: 1)
    static let fillAlpha = 0.24
}

func focusBarCountdownText(_ seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded(.up)))
    let hours = total / 3_600
    let minutes = (total % 3_600) / 60
    let remainder = total % 60
    if hours > 0 {
        return String(format: "%d:%02d:%02d", hours, minutes, remainder)
    }
    return String(format: "%d:%02d", minutes, remainder)
}

func focusBarSpokenTime(_ seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded(.up)))
    let minutes = total / 60
    let remainder = total % 60
    if minutes == 0 { return "\(remainder) seconds remaining" }
    return "\(minutes) minutes \(remainder) seconds remaining"
}

/**
 A separate panel from `FocusOverlayPanel`: it accepts keyboard focus when that is asked for,
 while the reminder panels never do. Showing it normally uses `orderFrontRegardless`, which
 leaves the app unactivated and the panel not key.
 */
final class FocusBarPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    convenience init() {
        self.init(
            contentRect: NSRect(origin: .zero, size: FocusBarStyle.defaultSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        // isFloatingPanel resets the level, so it must be set before the level.
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 3)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        isExcludedFromWindowsMenu = true
        isMovableByWindowBackground = false
        animationBehavior = .none
        // The resize cursor and the edge grip follow the pointer, which needs moved events.
        acceptsMouseMovedEvents = true
    }

    override func cancelOperation(_ sender: Any?) {
        MainActor.assumeIsolated { FocusBarController.shared.escape() }
    }
}

enum FocusBarGlyph {
    case pause
    case play
    case complete
    case more

    func path(in bounds: NSRect) -> NSBezierPath {
        let path = NSBezierPath()
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        switch self {
        case .pause:
            for offset in [-3.0, 2.0] as [CGFloat] {
                path.appendRoundedRect(
                    NSRect(x: center.x + offset, y: center.y - 5, width: 2, height: 10),
                    xRadius: 1,
                    yRadius: 1
                )
            }
        case .play:
            path.move(to: NSPoint(x: center.x - 3.5, y: center.y - 5))
            path.line(to: NSPoint(x: center.x + 4.5, y: center.y))
            path.line(to: NSPoint(x: center.x - 3.5, y: center.y + 5))
            path.close()
        case .complete:
            path.move(to: NSPoint(x: center.x - 5, y: center.y + 0.5))
            path.line(to: NSPoint(x: center.x - 1.5, y: center.y - 3.5))
            path.line(to: NSPoint(x: center.x + 5, y: center.y + 4))
        case .more:
            for offset in [-5.0, 0.0, 5.0] as [CGFloat] {
                path.appendOval(in: NSRect(x: center.x + offset - 1.1, y: center.y - 1.1, width: 2.2, height: 2.2))
            }
        }
        return path
    }

    var stroked: Bool { self == .complete }
}

final class FocusBarButton: NSView {
    private let action: () -> Void
    private var pressed = false { didSet { needsDisplay = true } }
    var highContrast = false { didSet { needsDisplay = true } }
    var glyph: FocusBarGlyph { didSet { if oldValue != glyph { needsDisplay = true } } }

    init(glyph: FocusBarGlyph, label: String, action: @escaping () -> Void) {
        self.glyph = glyph
        self.action = action
        super.init(frame: .zero)
        wantsLayer = true
        focusRingType = .exterior
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(label)
        toolTip = label
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { !isHiddenOrHasHiddenAncestor }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var canBecomeKeyView: Bool { !isHiddenOrHasHiddenAncestor }

    override func accessibilityPerformPress() -> Bool {
        action()
        return true
    }

    override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return true
    }

    override func resignFirstResponder() -> Bool {
        needsDisplay = true
        return true
    }

    override func mouseDown(with event: NSEvent) { pressed = true }

    override func mouseDragged(with event: NSEvent) {
        pressed = bounds.contains(convert(event.locationInWindow, from: nil))
    }

    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        if inside { action() }
    }

    override func keyDown(with event: NSEvent) {
        let characters = event.charactersIgnoringModifiers ?? ""
        if characters == " " || characters == "\r" {
            action()
            return
        }
        super.keyDown(with: event)
    }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7).fill()
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7)
        let background = highContrast
            ? NSColor.white.withAlphaComponent(pressed ? 0.85 : 0.2)
            : NSColor.white.withAlphaComponent(pressed ? 0.26 : 0.1)
        background.setFill()
        path.fill()
        if highContrast {
            NSColor.white.setStroke()
            path.lineWidth = 1.5
            path.stroke()
        }
        let tint = highContrast && pressed
            ? NSColor.black
            : NSColor.white.withAlphaComponent(highContrast ? 1 : 0.92)
        let symbol = glyph.path(in: bounds)
        if glyph.stroked {
            tint.setStroke()
            symbol.lineWidth = 1.8
            symbol.lineCapStyle = .round
            symbol.lineJoinStyle = .round
            symbol.stroke()
        } else {
            tint.setFill()
            symbol.fill()
        }
    }
}

private final class FocusBarDecoration: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private final class FocusBarBlur: NSVisualEffectView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private final class FocusBarLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class FocusBarContentView: NSView {
    private let blur = FocusBarBlur()
    private let solid = FocusBarDecoration()
    private let dot = FocusBarDecoration()
    private let progress = FocusBarDecoration()
    private let fill = CALayer()
    private let leadingGrip = FocusBarDecoration()
    private let trailingGrip = FocusBarDecoration()
    private var fillColor = FocusProgressColor.fallback
    private var hoveredEdge: FocusBarPlacement.HorizontalEdge?
    private var activeResize: (edge: FocusBarPlacement.HorizontalEdge, startX: CGFloat)?
    private let goalLabel = FocusBarLabel(labelWithString: "")
    private let countdownLabel = FocusBarLabel(labelWithString: "")
    let primaryButton: FocusBarButton
    let completeButton: FocusBarButton
    let overflowButton: FocusBarButton
    private var trackingArea: NSTrackingArea?
    private var revealed = false
    private var appearanceOptions = FocusOverlayAppearance(
        reduceMotion: false,
        reduceTransparency: false,
        increaseContrast: false
    )

    init(
        onPrimary: @escaping () -> Void,
        onComplete: @escaping () -> Void,
        onOverflow: @escaping () -> Void
    ) {
        primaryButton = FocusBarButton(glyph: .pause, label: "Pause focus session", action: onPrimary)
        completeButton = FocusBarButton(glyph: .complete, label: "Complete focus session", action: onComplete)
        overflowButton = FocusBarButton(glyph: .more, label: "More focus session options", action: onOverflow)
        super.init(frame: NSRect(origin: .zero, size: FocusBarStyle.defaultSize))
        wantsLayer = true
        layer?.cornerRadius = FocusBarStyle.cornerRadius
        layer?.masksToBounds = true

        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.appearance = NSAppearance(named: .darkAqua)
        blur.autoresizingMask = [.width, .height]
        addSubview(blur)

        solid.wantsLayer = true
        solid.autoresizingMask = [.width, .height]
        addSubview(solid)

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = FocusBarStyle.running
        dot.setAccessibilityElement(false)
        addSubview(dot)

        progress.wantsLayer = true
        progress.autoresizingMask = [.width, .height]
        progress.layer?.masksToBounds = true
        progress.setAccessibilityElement(false)
        fill.anchorPoint = .zero
        fill.position = .zero
        fill.backgroundColor = FocusProgressColor.fallback.cgColor(alpha: FocusBarStyle.fillAlpha)
        // Only the explicit fill animation moves this layer; implicit ones would fight it.
        fill.actions = [
            "bounds": NSNull(),
            "position": NSNull(),
            "backgroundColor": NSNull()
        ] as [String: any CAAction]
        progress.layer?.addSublayer(fill)
        addSubview(progress)

        for grip in [leadingGrip, trailingGrip] {
            grip.wantsLayer = true
            grip.layer?.cornerRadius = FocusBarStyle.gripSize.width / 2
            grip.layer?.backgroundColor = CGColor(gray: 1, alpha: 0.45)
            grip.isHidden = true
            grip.setAccessibilityElement(false)
            addSubview(grip)
        }

        goalLabel.textColor = NSColor.white.withAlphaComponent(0.94)
        goalLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
        goalLabel.lineBreakMode = .byTruncatingTail
        goalLabel.maximumNumberOfLines = 1
        addSubview(goalLabel)

        countdownLabel.textColor = NSColor.white.withAlphaComponent(0.94)
        countdownLabel.font = .monospacedDigitSystemFont(ofSize: 14, weight: .medium)
        countdownLabel.alignment = .right
        addSubview(countdownLabel)

        for button in [primaryButton, completeButton, overflowButton] {
            button.isHidden = true
            addSubview(button)
        }
        primaryButton.nextKeyView = completeButton
        completeButton.nextKeyView = overflowButton
        overflowButton.nextKeyView = primaryButton

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { nil }

    /**
     A press near a vertical edge resizes; anywhere else drags the whole bar. The panel is
     borderless, so the edges are handled here rather than by AppKit's own resize corners.
     `performDrag(with:)` runs the move to its end, so the drag handlers below only ever see a
     resize.
     */
    override func mouseDown(with event: NSEvent) {
        if let window, let edge = resizeEdge(at: convert(event.locationInWindow, from: nil)) {
            activeResize = (edge: edge, startX: window.convertPoint(toScreen: event.locationInWindow).x)
            MainActor.assumeIsolated { FocusBarController.shared.beginResize() }
            return
        }
        let before = window?.frame
        window?.performDrag(with: event)
        guard let before, window?.frame != before else { return }
        MainActor.assumeIsolated { FocusBarController.shared.dragFinished() }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let resize = activeResize, let window else { return }
        let deltaX = window.convertPoint(toScreen: event.locationInWindow).x - resize.startX
        MainActor.assumeIsolated { FocusBarController.shared.resize(edge: resize.edge, deltaX: deltaX) }
    }

    override func mouseUp(with event: NSEvent) {
        guard activeResize != nil else { return }
        activeResize = nil
        MainActor.assumeIsolated { FocusBarController.shared.finishResize() }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .mouseMoved, .cursorUpdate, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        setRevealed(true)
        updateHover(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseMoved(with event: NSEvent) {
        updateHover(at: convert(event.locationInWindow, from: nil))
    }

    override func cursorUpdate(with event: NSEvent) {
        if hoveredEdge == nil {
            super.cursorUpdate(with: event)
            return
        }
        NSCursor.resizeLeftRight.set()
    }

    override func mouseExited(with event: NSEvent) {
        updateHover(at: nil)
        guard window?.isKeyWindow != true else { return }
        setRevealed(false)
    }

    private func resizeEdge(at point: NSPoint) -> FocusBarPlacement.HorizontalEdge? {
        guard bounds.contains(point) else { return nil }
        if point.x <= bounds.minX + FocusBarStyle.resizeEdge { return .leading }
        if point.x >= bounds.maxX - FocusBarStyle.resizeEdge { return .trailing }
        return nil
    }

    private func updateHover(at point: NSPoint?) {
        let edge = activeResize?.edge ?? point.flatMap { resizeEdge(at: $0) }
        if edge != nil {
            NSCursor.resizeLeftRight.set()
        } else if hoveredEdge != nil {
            NSCursor.arrow.set()
        }
        guard edge != hoveredEdge else { return }
        hoveredEdge = edge
        leadingGrip.isHidden = edge != .leading
        trailingGrip.isHidden = edge != .trailing
    }

    func setRevealed(_ visible: Bool) {
        guard revealed != visible else { return }
        revealed = visible
        let buttons = [primaryButton, completeButton, overflowButton]
        if visible {
            for button in buttons {
                button.alphaValue = appearanceOptions.reduceMotion ? 1 : 0
                button.isHidden = false
            }
            guard !appearanceOptions.reduceMotion else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = FocusBarStyle.revealDuration
                for button in buttons { button.animator().alphaValue = 1 }
            }
        } else {
            for button in buttons {
                button.alphaValue = 1
                button.isHidden = true
            }
        }
    }

    func apply(_ options: FocusOverlayAppearance) {
        appearanceOptions = options
        let opaque = options.reduceTransparency || options.increaseContrast
        blur.isHidden = opaque
        solid.layer?.backgroundColor = opaque
            ? CGColor(gray: 0.07, alpha: 1)
            : CGColor(gray: 0.06, alpha: 0.5)
        layer?.borderWidth = options.increaseContrast ? 2 : 1
        layer?.borderColor = options.increaseContrast
            ? CGColor(gray: 1, alpha: 0.9)
            : CGColor(gray: 1, alpha: 0.14)
        goalLabel.font = .systemFont(ofSize: 12.5, weight: options.increaseContrast ? .semibold : .medium)
        goalLabel.textColor = NSColor.white.withAlphaComponent(options.increaseContrast ? 1 : 0.94)
        countdownLabel.textColor = NSColor.white.withAlphaComponent(options.increaseContrast ? 1 : 0.94)
        for button in [primaryButton, completeButton, overflowButton] {
            button.highContrast = options.increaseContrast
        }
    }

    func configure(_ snapshot: FocusBarSnapshot) {
        goalLabel.stringValue = snapshot.goalTitle.isEmpty ? "Focus session" : snapshot.goalTitle
        goalLabel.toolTip = snapshot.intention.isEmpty
            ? snapshot.goalTitle
            : "\(snapshot.goalTitle) — \(snapshot.intention)"
        goalLabel.setAccessibilityLabel(goalLabel.toolTip)
        primaryButton.glyph = snapshot.paused ? .play : .pause
        primaryButton.setAccessibilityLabel(snapshot.paused ? "Resume focus session" : "Pause focus session")
        primaryButton.toolTip = snapshot.paused ? "Resume focus session" : "Pause focus session"
        dot.layer?.backgroundColor = snapshot.paused ? FocusBarStyle.paused : FocusBarStyle.running
        setFillColor(snapshot.progress)
        needsLayout = true
    }

    /**
     Recolors the fill in place. The width animation, if one is running, keeps running: only the
     layer's color changes, inside a transaction with implicit actions off so nothing fades or
     restarts. A paused session keeps the chosen color too; the indicator dot says it is paused.
     */
    private func setFillColor(_ color: FocusProgressColor) {
        guard fillColor != color else { return }
        fillColor = color
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fill.backgroundColor = color.cgColor(alpha: FocusBarStyle.fillAlpha)
        CATransaction.commit()
    }

    /**
     Grows the elapsed fill to the end of the bar over `animateOverSeconds`, the time the anchored
     deadline says is left. One linear animation covers the whole remaining session, so the
     ordinary countdown ticks leave the animation running. A paused session,
     an expired one and Reduce Motion get the exact value with no animation at all.
     */
    func setProgress(fraction: Double, animateOverSeconds: Double?) {
        let full = max(1, bounds.width)
        let elapsed = full * CGFloat(max(0, min(1, fraction)))
        fill.removeAnimation(forKey: "fill")
        guard let seconds = animateOverSeconds, seconds > 0, !appearanceOptions.reduceMotion else {
            setFillWidth(elapsed)
            return
        }
        setFillWidth(full)
        let growth = CABasicAnimation(keyPath: "bounds.size.width")
        growth.fromValue = elapsed
        growth.toValue = full
        growth.duration = seconds
        growth.timingFunction = CAMediaTimingFunction(name: .linear)
        fill.add(growth, forKey: "fill")
    }

    /// Leaves the fill where it is drawn and stops animating it, for a hidden or torn-down bar.
    func stopProgressAnimation() {
        guard fill.animation(forKey: "fill") != nil else { return }
        let drawn = (fill.presentation() ?? fill).bounds.width
        fill.removeAnimation(forKey: "fill")
        setFillWidth(drawn)
    }

    /// How wide the fill is on screen right now, for the once-a-second drift check.
    var drawnProgressWidth: CGFloat { (fill.presentation() ?? fill).bounds.width }

    var motionReduced: Bool { appearanceOptions.reduceMotion }

    private func setFillWidth(_ width: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fill.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        CATransaction.commit()
    }

    func paint(remainingSeconds: Double, paused: Bool, snoozed: Bool) {
        countdownLabel.stringValue = focusBarCountdownText(remainingSeconds)
        let spoken = focusBarSpokenTime(remainingSeconds)
        countdownLabel.setAccessibilityLabel(paused ? "Paused, \(spoken)" : spoken)
        var description = "Focus session. \(goalLabel.toolTip ?? goalLabel.stringValue). \(spoken)."
        if paused { description += " Paused." }
        if snoozed { description += " Reminders snoozed." }
        setAccessibilityLabel(description)
    }

    override func layout() {
        super.layout()
        blur.frame = bounds
        solid.frame = bounds
        // The fill itself is never laid out here: only `setProgress` moves it, so a layout pass
        // during a resize or a reveal cannot restart the running animation.
        progress.frame = bounds
        let grip = FocusBarStyle.gripSize
        let gripY = bounds.midY - grip.height / 2
        leadingGrip.frame = NSRect(x: bounds.minX + 4, y: gripY, width: grip.width, height: grip.height)
        trailingGrip.frame = NSRect(
            x: bounds.maxX - 4 - grip.width,
            y: gripY,
            width: grip.width,
            height: grip.height
        )
        let padding = FocusBarStyle.padding
        let control = FocusBarStyle.controlSize
        let gap = FocusBarStyle.controlGap
        let controlY = bounds.midY - control / 2
        overflowButton.frame = NSRect(x: bounds.maxX - padding - control, y: controlY, width: control, height: control)
        completeButton.frame = NSRect(x: overflowButton.frame.minX - gap - control, y: controlY, width: control, height: control)
        primaryButton.frame = NSRect(x: completeButton.frame.minX - gap - control, y: controlY, width: control, height: control)
        countdownLabel.frame = NSRect(
            x: primaryButton.frame.minX - 10 - FocusBarStyle.countdownWidth,
            y: bounds.midY - 10,
            width: FocusBarStyle.countdownWidth,
            height: 20
        )
        dot.frame = NSRect(x: padding, y: bounds.midY - 4, width: 8, height: 8)
        let textX = padding + 8 + 10
        goalLabel.frame = NSRect(
            x: textX,
            y: bounds.midY - 9,
            width: max(60, countdownLabel.frame.minX - 10 - textX),
            height: 18
        )
    }
}

@MainActor
final class FocusBarController: NSObject {
    static let shared = FocusBarController()

    private var panel: FocusBarPanel?
    private var contentView: FocusBarContentView?
    private var snapshot: FocusBarSnapshot?
    private var paintTimer: Timer?
    private var observersInstalled = false
    private var actionCallback: OpenHistoryFocusActionCallback?
    private var actionContext: UnsafeMutableRawPointer?
    private var barFrame: NSRect = .zero
    private var resizeStartFrame: NSRect = .zero
    private var recentBarUntil = Date.distantPast
    private var menuTracking = false
    private var menuCaptureUntil = Date.distantPast

    func setActionCallback(_ callback: OpenHistoryFocusActionCallback?, context: UnsafeMutableRawPointer?) {
        actionCallback = callback
        actionContext = context
    }

    /// Shows or refreshes the bar without activating the app or making the panel key.
    func update(_ snapshot: FocusBarSnapshot) -> FocusBarResult {
        guard snapshot.isValid else { return .invalidRequest }
        guard let frame = placement(for: snapshot) else { return .noDisplay }
        installObserversIfNeeded()
        let (panel, content) = ensurePanel()
        let clockChanged = self.snapshot?.clockFingerprint != snapshot.clockFingerprint
        let motionBefore = content.motionReduced
        var restart = !panel.isVisible
        self.snapshot = snapshot
        content.apply(FocusOverlayAppearance.current)
        content.configure(snapshot)
        if !panel.isVisible || !frame.equalTo(barFrame) {
            panel.setFrame(frame, display: false)
            content.frame = NSRect(origin: .zero, size: frame.size)
            barFrame = frame
            restart = true
        }
        paint()
        if restart || clockChanged || content.motionReduced != motionBefore { applyProgress() }
        panel.orderFrontRegardless()
        syncPaintTimer()
        return .shown
    }

    func hide() {
        stopPaintTimer()
        recentBarUntil = Date().addingTimeInterval(1)
        snapshot = nil
        resizeStartFrame = .zero
        guard let panel else { return }
        contentView?.stopProgressAnimation()
        contentView?.setRevealed(false)
        panel.orderOut(nil)
    }

    func focusBar() {
        guard let panel, panel.isVisible, let content = contentView else { return }
        content.setRevealed(true)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(content.primaryButton)
    }

    func escape() {
        guard let panel, let content = contentView else { return }
        panel.makeFirstResponder(nil)
        panel.resignKey()
        content.setRevealed(false)
        panel.orderFrontRegardless()
        NSApp.deactivate()
    }

    /// Pointer capture asks this before recording a click, so bar clicks are never attributed to
    /// the app underneath. `point` uses global top-left-origin coordinates.
    func containsPoint(_ point: CGPoint) -> Bool {
        let now = Date()
        if menuTracking || now < menuCaptureUntil { return true }
        guard (panel?.isVisible == true || now < recentBarUntil),
              let primary = NSScreen.screens.first else { return false }
        return barFrame.contains(NSPoint(x: point.x, y: primary.frame.height - point.y))
    }

    func shutdown() {
        hide()
        if observersInstalled {
            NotificationCenter.default.removeObserver(self)
            NSWorkspace.shared.notificationCenter.removeObserver(self)
            observersInstalled = false
        }
        panel?.close()
        panel = nil
        contentView = nil
        actionCallback = nil
        actionContext = nil
    }

    fileprivate func dragFinished() {
        guard let panel, let snapshot else { return }
        barFrame = panel.frame
        send(["action": "moved", "sessionId": snapshot.sessionId, "x": barFrame.minX, "y": barFrame.minY])
    }

    fileprivate func beginResize() {
        guard let panel else { return }
        resizeStartFrame = panel.frame
    }

    fileprivate func resize(edge: FocusBarPlacement.HorizontalEdge, deltaX: CGFloat) {
        guard resizeStartFrame != .zero else { return }
        guard let frame = FocusBarPlacement.resizedFrame(
            current: resizeStartFrame,
            edge: edge,
            deltaX: deltaX,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        ) else { return }
        applyFrame(frame)
    }

    fileprivate func finishResize() {
        let started = resizeStartFrame
        resizeStartFrame = .zero
        guard started != .zero, let panel, panel.frame != started else { return }
        reportGeometry()
    }

    @discardableResult
    private func applyFrame(_ frame: NSRect) -> Bool {
        guard let panel, let contentView, !frame.equalTo(panel.frame) else { return false }
        panel.setFrame(frame, display: true)
        contentView.frame = NSRect(origin: .zero, size: frame.size)
        barFrame = frame
        applyProgress()
        return true
    }

    private func reportGeometry() {
        guard let snapshot else { return }
        send([
            "action": "resized",
            "sessionId": snapshot.sessionId,
            "x": barFrame.minX,
            "y": barFrame.minY,
            "width": barFrame.width
        ])
    }

    private func report(_ action: String) {
        guard let snapshot else { return }
        send(["action": action, "sessionId": snapshot.sessionId])
    }

    private func send(_ payload: [String: Any]) {
        guard let callback = actionCallback else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        String(decoding: data, as: UTF8.self).withCString { callback($0, actionContext) }
    }

    private func showOverflowMenu() {
        guard let view = contentView?.overflowButton else { return }
        let menu = NSMenu()
        menu.addItem(withTitle: "Edit Session…", action: #selector(editSession), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Fit Display Width", action: #selector(fitDisplayWidth), keyEquivalent: "")
        menu.addItem(withTitle: "Reset Width", action: #selector(resetWidth), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Move to Menu Bar", action: #selector(moveToMenuBar), keyEquivalent: "")
        for item in menu.items { item.target = self }
        menuTracking = true
        defer {
            menuTracking = false
            menuCaptureUntil = Date().addingTimeInterval(1)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: view.bounds.maxY + 6), in: view)
    }

    @objc private func editSession() { report("edit") }

    @objc private func moveToMenuBar() { report("move_to_menu_bar") }

    @objc private func fitDisplayWidth() {
        guard let panel else { return }
        guard let frame = FocusBarPlacement.fitFrame(
            current: panel.frame,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        ) else { return }
        if applyFrame(frame) { reportGeometry() }
    }

    @objc private func resetWidth() {
        guard let panel else { return }
        let current = panel.frame
        let size = NSSize(width: FocusBarPlacement.defaultWidth, height: current.height)
        guard let frame = FocusBarPlacement.frame(
            preferredOrigin: NSPoint(x: current.midX - size.width / 2, y: current.minY),
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        ) else { return }
        if applyFrame(frame) { reportGeometry() }
    }

    private func togglePause() {
        report(snapshot?.paused == true ? "resume" : "pause")
    }

    private func ensurePanel() -> (FocusBarPanel, FocusBarContentView) {
        if let panel, let contentView { return (panel, contentView) }
        let content = FocusBarContentView(
            onPrimary: { MainActor.assumeIsolated { FocusBarController.shared.togglePause() } },
            onComplete: { MainActor.assumeIsolated { FocusBarController.shared.report("complete") } },
            onOverflow: { MainActor.assumeIsolated { FocusBarController.shared.showOverflowMenu() } }
        )
        let panel = FocusBarPanel()
        panel.contentView = content
        panel.setAccessibilityTitle("Focus session bar")
        panel.autorecalculatesKeyViewLoop = false
        panel.initialFirstResponder = content.primaryButton
        self.panel = panel
        contentView = content
        return (panel, content)
    }

    private func placement(for snapshot: FocusBarSnapshot) -> NSRect? {
        let visibleFrames = NSScreen.screens.map(\.visibleFrame)
        let preferred = snapshot.position.map { NSPoint(x: $0.x, y: $0.y) }
        let size = NSSize(width: snapshot.barWidth, height: FocusBarStyle.height)
        if panel?.isVisible == true, barFrame != .zero,
           let kept = FocusBarPlacement.frame(
               preferredOrigin: barFrame.origin,
               size: size,
               visibleFrames: visibleFrames
           ) {
            return kept
        }
        return FocusBarPlacement.frame(
            preferredOrigin: preferred,
            size: size,
            visibleFrames: visibleFrames
        )
    }

    private func remainingSeconds() -> Double {
        guard let snapshot else { return 0 }
        guard let endsAt = snapshot.endsAtEpochSeconds else {
            return max(0, snapshot.pausedRemainingSeconds ?? 0)
        }
        return max(0, endsAt - Date().timeIntervalSince1970)
    }

    private func paint() {
        guard let snapshot, let contentView else { return }
        contentView.paint(
            remainingSeconds: remainingSeconds(),
            paused: snapshot.paused,
            snoozed: snapshot.snoozed
        )
    }

    private func elapsedFraction() -> Double {
        guard let snapshot else { return 0 }
        let total = max(1, snapshot.totalSeconds)
        return max(0, min(1, (total - remainingSeconds()) / total))
    }

    /**
     Hands the fill the fraction it is at and, while the clock runs, the seconds it has left to
     reach the end. Session, appearance and width changes restart it; the paint tick also resyncs
     under Reduce Motion or after clock drift.
     */
    private func applyProgress() {
        guard let snapshot, let contentView else { return }
        contentView.setProgress(
            fraction: elapsedFraction(),
            animateOverSeconds: snapshot.paused ? nil : remainingSeconds()
        )
    }

    private func syncPaintTimer() {
        let counting = snapshot?.paused == false && panel?.isVisible == true
        guard counting else {
            stopPaintTimer()
            return
        }
        guard paintTimer == nil else { return }
        let timer = Timer(timeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated { FocusBarController.shared.paintTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        paintTimer = timer
    }

    private func paintTick() {
        guard snapshot?.paused == false, panel?.isVisible == true else {
            stopPaintTimer()
            return
        }
        paint()
        resyncProgressIfDrifted()
    }

    /**
     Under Reduce Motion the fill is not animated at all, so the countdown's own tick steps it.
     Otherwise sleep, or an animation the window server stopped advancing, can leave the fill
     behind the anchored clock: only a visible gap is corrected, so an ordinary tick never restarts
     the animation.
     */
    private func resyncProgressIfDrifted() {
        guard let contentView else { return }
        if contentView.motionReduced {
            applyProgress()
            return
        }
        let expected = contentView.bounds.width * CGFloat(elapsedFraction())
        guard abs(expected - contentView.drawnProgressWidth) > FocusBarStyle.progressDrift else { return }
        applyProgress()
    }

    private func stopPaintTimer() {
        paintTimer?.invalidate()
        paintTimer = nil
    }

    private func installObserversIfNeeded() {
        guard !observersInstalled else { return }
        observersInstalled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(panelKeyChanged),
            name: NSWindow.didBecomeKeyNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(panelKeyChanged),
            name: NSWindow.didResignKeyNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(accessibilityOptionsChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil
        )
    }

    /**
     A display change only trims the bar onto what is left; the saved width is not rewritten, so a
     bar can use its saved width again on a display large enough to hold it.
     */
    @objc private func screenParametersChanged() {
        guard let panel, panel.isVisible else { return }
        let size = snapshot.map { NSSize(width: $0.barWidth, height: FocusBarStyle.height) }
            ?? barFrame.size
        guard let frame = FocusBarPlacement.frame(
            preferredOrigin: barFrame.origin,
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        ) else { return }
        applyFrame(frame)
        paint()
    }

    @objc private func panelKeyChanged(_ notification: Notification) {
        guard let panel, notification.object as? NSWindow === panel else { return }
        contentView?.setRevealed(panel.isKeyWindow)
    }

    @objc private func accessibilityOptionsChanged() {
        contentView?.apply(FocusOverlayAppearance.current)
        applyProgress()
    }
}

@_cdecl("openhistory_focus_bar_update")
public func openHistoryFocusBarUpdate(_ snapshotJSON: UnsafePointer<CChar>?) -> Int32 {
    guard Thread.isMainThread else { return FocusBarResult.notMainThread.rawValue }
    guard let snapshotJSON,
          let snapshot = try? JSONDecoder().decode(
              FocusBarSnapshot.self,
              from: Data(String(cString: snapshotJSON).utf8)
          ) else { return FocusBarResult.invalidRequest.rawValue }
    return MainActor.assumeIsolated { FocusBarController.shared.update(snapshot).rawValue }
}

@_cdecl("openhistory_focus_bar_hide")
public func openHistoryFocusBarHide() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { FocusBarController.shared.hide() }
}

@_cdecl("openhistory_focus_bar_focus")
public func openHistoryFocusBarFocus() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { FocusBarController.shared.focusBar() }
}

@_cdecl("openhistory_focus_bar_set_action_callback")
public func openHistoryFocusBarSetActionCallback(
    _ callback: OpenHistoryFocusActionCallback?,
    _ context: UnsafeMutableRawPointer?
) {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { FocusBarController.shared.setActionCallback(callback, context: context) }
}

@_cdecl("openhistory_focus_bar_shutdown")
public func openHistoryFocusBarShutdown() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { FocusBarController.shared.shutdown() }
}
