import ActivityCore
import AppKit
@preconcurrency import ApplicationServices
import Foundation


public typealias OpenHistoryFocusActionCallback = @convention(c) (
    UnsafePointer<CChar>?,
    UnsafeMutableRawPointer?
) -> Void

struct FocusOverlayRequest: Decodable {
    let nudgeId: String
    let sessionId: String?
    let title: String
    let message: String
    let expectedProcessIdentifier: Int32?
    let preview: Bool
    /// "amber" (no grayscale; the default when absent), "grayscale_window", "grayscale_screen" or
    /// "grayscale_system". Color Filters are switched by the app outside this overlay, so
    /// "grayscale_system" captures nothing here.
    let experience: String?
    /// Whether to draw the amber edge; absent means yes, as before the edge was separate.
    let amberEdge: Bool?
    /// The listed site rule a window-only reminder is for; its window is grayed only while fresh
    /// foreground evidence from that window matches it.
    let domain: String?

    var wantsGrayscale: Bool { experience == "grayscale_screen" }
    var wantsWindowGrayscale: Bool { experience == "grayscale_window" }
    var showsAmberEdge: Bool { amberEdge ?? true }

    var isValid: Bool {
        !nudgeId.isEmpty && nudgeId.count <= 100 &&
            (sessionId?.count ?? 0) <= 100 &&
            !title.isEmpty && title.count <= 300 &&
            message.count <= 600 &&
            (experience == nil ||
                ["amber", "grayscale_window", "grayscale_screen", "grayscale_system"].contains(experience)) &&
            (domain?.count ?? 0) <= 253 &&
            (preview || !wantsWindowGrayscale || domain?.isEmpty == false) &&
            (preview || (expectedProcessIdentifier ?? 0) > 0)
    }
}

enum FocusOverlayShowResult: Int32 {
    case shown = 0
    case invalidRequest = 1
    case notMainThread = 2
    case noDisplay = 3
    case foregroundChanged = 4
    /// Grayscale needs Screen Recording access.
    case shownFallbackPermission = 5
    /// Grayscale capture isn't supported here.
    case shownFallbackUnavailable = 6
    /// The distracting window couldn't be matched exactly.
    case shownFallbackWindow = 7
    /// The distracting window covers more than one display.
    case shownFallbackWindowSpansDisplays = 8
}

struct FocusOverlayAppearance: Equatable {
    var reduceMotion: Bool
    var reduceTransparency: Bool
    var increaseContrast: Bool

    @MainActor static var current: FocusOverlayAppearance {
        let workspace = NSWorkspace.shared
        return FocusOverlayAppearance(
            reduceMotion: workspace.accessibilityDisplayShouldReduceMotion,
            reduceTransparency: workspace.accessibilityDisplayShouldReduceTransparency,
            increaseContrast: workspace.accessibilityDisplayShouldIncreaseContrast
        )
    }
}

private enum FocusOverlayStyle {
    static let fadeDuration: TimeInterval = 0.6
    static let glowDepth: CGFloat = 60
    static let cornerRadius: CGFloat = 12
    static let cardSize = NSSize(width: 520, height: 88)
    static let cardTopInset: CGFloat = 14
    static let amber = CGColor(srgbRed: 1.0, green: 0.68, blue: 0.2, alpha: 1)
    static let contrastAmber = CGColor(srgbRed: 1.0, green: 0.6, blue: 0.0, alpha: 1)
}

final class FocusOverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    convenience init(clickThrough: Bool, levelOffset: Int) {
        self.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        // isFloatingPanel resets the level to .floating, so it must be set before the level.
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + levelOffset)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = clickThrough
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        isExcludedFromWindowsMenu = true
        animationBehavior = .none
        alphaValue = 0
    }
}

final class FocusGlowView: NSView {
    var appearanceOptions = FocusOverlayAppearance(
        reduceMotion: false,
        reduceTransparency: false,
        increaseContrast: false
    ) { didSet { if oldValue != appearanceOptions { needsDisplay = true } } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { nil }

    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.clear(bounds)
        let options = appearanceOptions
        let color = options.increaseContrast ? FocusOverlayStyle.contrastAmber : FocusOverlayStyle.amber
        let radius = FocusOverlayStyle.cornerRadius
        let edge = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
        context.addPath(edge)
        context.clip()

        if !options.reduceTransparency {
            context.saveGState()
            let frame = CGMutablePath()
            frame.addRect(bounds.insetBy(dx: -FocusOverlayStyle.glowDepth * 4, dy: -FocusOverlayStyle.glowDepth * 4))
            frame.addPath(edge)
            context.setShadow(
                offset: .zero,
                blur: FocusOverlayStyle.glowDepth,
                color: color.copy(alpha: options.increaseContrast ? 0.8 : 0.55)
            )
            context.setFillColor(color)
            context.addPath(frame)
            context.fillPath(using: .evenOdd)
            context.restoreGState()
        }

        let perimeter: CGFloat = options.increaseContrast ? 5 : (options.reduceTransparency ? 4 : 2.5)
        context.addPath(edge)
        context.setStrokeColor(color.copy(alpha: options.reduceTransparency || options.increaseContrast ? 1 : 0.9) ?? color)
        // Half of a stroke centered on the edge falls outside the clip.
        context.setLineWidth(perimeter * 2)
        context.strokePath()

        if options.increaseContrast {
            let inset = perimeter + 0.75
            let inner = CGPath(
                roundedRect: bounds.insetBy(dx: inset, dy: inset),
                cornerWidth: max(0, radius - perimeter),
                cornerHeight: max(0, radius - perimeter),
                transform: nil
            )
            context.addPath(inner)
            context.setStrokeColor(CGColor(gray: 0, alpha: 0.85))
            context.setLineWidth(1.5)
            context.strokePath()
        }
    }
}

final class FocusCardButton: NSView {
    private let title: String
    private let action: () -> Void
    var highContrast = false { didSet { needsDisplay = true } }
    private var pressed = false { didSet { needsDisplay = true } }

    init(title: String, accessibilityTitle: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(accessibilityTitle)
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool {
        action()
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

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8)
        if highContrast {
            (pressed ? NSColor.white : NSColor.black).setFill()
            path.fill()
            NSColor.white.setStroke()
            path.lineWidth = 1.5
            path.stroke()
        } else {
            NSColor.white.withAlphaComponent(pressed ? 0.3 : 0.14).setFill()
            path.fill()
        }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: highContrast && pressed ? NSColor.black : NSColor.white
        ]
        let label = NSAttributedString(string: title, attributes: attributes)
        let size = label.size()
        label.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2))
    }
}

final class FocusCardView: NSView {
    private let blur = NSVisualEffectView()
    private let solid = NSView()
    private let dot = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let messageLabel = NSTextField(wrappingLabelWithString: "")
    let snoozeButton: FocusCardButton
    let dismissButton: FocusCardButton

    init(onSnooze: @escaping () -> Void, onDismiss: @escaping () -> Void) {
        snoozeButton = FocusCardButton(
            title: "Snooze 5 min",
            accessibilityTitle: "Snooze focus reminders for 5 minutes",
            action: onSnooze
        )
        dismissButton = FocusCardButton(
            title: "Dismiss",
            accessibilityTitle: "Dismiss this focus reminder",
            action: onDismiss
        )
        super.init(frame: NSRect(origin: .zero, size: FocusOverlayStyle.cardSize))
        wantsLayer = true
        layer?.cornerRadius = 16
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
        dot.layer?.backgroundColor = FocusOverlayStyle.amber
        dot.setAccessibilityElement(false)
        addSubview(dot)

        titleLabel.textColor = .white
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.maximumNumberOfLines = 1
        addSubview(titleLabel)

        messageLabel.textColor = NSColor.white.withAlphaComponent(0.82)
        messageLabel.font = .systemFont(ofSize: 12)
        messageLabel.maximumNumberOfLines = 2
        messageLabel.lineBreakMode = .byTruncatingTail
        addSubview(messageLabel)

        addSubview(snoozeButton)
        addSubview(dismissButton)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { nil }

    func configure(title: String, message: String, preview: Bool) {
        titleLabel.stringValue = preview ? "Preview · \(title)" : title
        messageLabel.stringValue = message
        messageLabel.isHidden = message.isEmpty
        setAccessibilityLabel(preview
            ? "Focus reminder preview. \(title). \(message)"
            : "Focus reminder. \(title). \(message)")
        needsLayout = true
    }

    func apply(_ options: FocusOverlayAppearance) {
        let opaque = options.reduceTransparency || options.increaseContrast
        blur.isHidden = opaque
        solid.layer?.backgroundColor = opaque ? CGColor(gray: 0.08, alpha: 1) : CGColor(gray: 0.05, alpha: 0.42)
        layer?.borderWidth = options.increaseContrast ? 2 : 1
        layer?.borderColor = options.increaseContrast
            ? FocusOverlayStyle.contrastAmber
            : CGColor(gray: 1, alpha: 0.12)
        titleLabel.font = .systemFont(ofSize: 14, weight: options.increaseContrast ? .bold : .semibold)
        messageLabel.textColor = NSColor.white.withAlphaComponent(options.increaseContrast ? 1 : 0.82)
        snoozeButton.highContrast = options.increaseContrast
        dismissButton.highContrast = options.increaseContrast
    }

    override func layout() {
        super.layout()
        blur.frame = bounds
        solid.frame = bounds
        let padding: CGFloat = 18
        let buttonHeight: CGFloat = 30
        let dismissWidth: CGFloat = 76
        let snoozeWidth: CGFloat = 108
        dismissButton.frame = NSRect(
            x: bounds.maxX - padding - dismissWidth,
            y: bounds.midY - buttonHeight / 2,
            width: dismissWidth,
            height: buttonHeight
        )
        snoozeButton.frame = NSRect(
            x: dismissButton.frame.minX - 8 - snoozeWidth,
            y: bounds.midY - buttonHeight / 2,
            width: snoozeWidth,
            height: buttonHeight
        )
        let textX = padding + 18
        let textWidth = max(80, snoozeButton.frame.minX - 14 - textX)
        if messageLabel.isHidden {
            titleLabel.frame = NSRect(x: textX, y: bounds.midY - 10, width: textWidth, height: 20)
        } else {
            titleLabel.frame = NSRect(x: textX, y: bounds.midY + 4, width: textWidth, height: 20)
            messageLabel.frame = NSRect(x: textX, y: bounds.midY - 32, width: textWidth, height: 34)
        }
        dot.frame = NSRect(x: padding, y: titleLabel.frame.midY - 4, width: 8, height: 8)
    }
}

@MainActor
final class FocusOverlayController: NSObject {
    static let shared = FocusOverlayController()

    private var glowPanel: FocusOverlayPanel?
    private var cardPanel: FocusOverlayPanel?
    private var glowView: FocusGlowView?
    private var cardView: FocusCardView?
    private var current: FocusOverlayRequest?
    private var currentDisplay: CGDirectDisplayID?
    private var presentationToken: UInt64 = 0
    private var observersInstalled = false
    private var actionCallback: OpenHistoryFocusActionCallback?
    private var actionContext: UnsafeMutableRawPointer?
    private var cardFrame: NSRect = .zero
    private var cardInteractiveUntil = Date.distantPast
    private let accessibility = AccessibilityReader()

    func setActionCallback(_ callback: OpenHistoryFocusActionCallback?, context: UnsafeMutableRawPointer?) {
        actionCallback = callback
        actionContext = context
    }

    func show(_ request: FocusOverlayRequest) -> FocusOverlayShowResult {
        guard request.isValid else { return .invalidRequest }
        let screen: NSScreen
        if request.preview {
            guard let previewScreen = previewScreen() else { return .noDisplay }
            screen = previewScreen
        } else {
            guard let expected = request.expectedProcessIdentifier,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == expected else {
                return .foregroundChanged
            }
            guard let target = screenForProcess(expected) else { return .noDisplay }
            screen = target
        }

        installObserversIfNeeded()
        FocusWindowGrayscaleController.shared.stop()
        FocusGrayscaleController.shared.stop()
        let (glow, card, glowView, cardView) = ensurePanels()
        presentationToken &+= 1
        let cardWasVisible = card.isVisible
        current = request
        currentDisplay = displayIdentifier(screen)

        let options = FocusOverlayAppearance.current
        glowView.appearanceOptions = options
        cardView.apply(options)
        cardView.configure(title: request.title, message: request.message, preview: request.preview)
        layout(glow: glow, card: card, glowView: glowView, cardView: cardView, on: screen)
        card.ignoresMouseEvents = false
        cardInteractiveUntil = .distantFuture

        if !cardWasVisible { card.alphaValue = options.reduceMotion ? 1 : 0 }
        card.orderFrontRegardless()
        if !options.reduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = FocusOverlayStyle.fadeDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                card.animator().alphaValue = 1
            }
        }

        var result = FocusOverlayShowResult.shown
        if request.wantsGrayscale {
            if let display = currentDisplay {
                let nudgeId = request.nudgeId
                // The card is already on screen, so this app appears in the shareable content the
                // capture filter excludes.
                let failure = FocusGrayscaleController.shared.start(
                    screen: screen,
                    displayID: display,
                    expectedProcessIdentifier: request.preview ? nil : request.expectedProcessIdentifier,
                    onEvent: { event in
                        FocusOverlayController.shared.grayscaleEvent(event, nudgeId: nudgeId)
                    }
                )
                switch failure {
                case nil: break
                case .permissionNeeded?: result = .shownFallbackPermission
                case _?: result = .shownFallbackUnavailable
                }
            } else {
                result = .shownFallbackUnavailable
            }
        } else if request.wantsWindowGrayscale {
            let nudgeId = request.nudgeId
            let failure = FocusWindowGrayscaleController.shared.start(
                processIdentifier: request.preview ? nil : request.expectedProcessIdentifier,
                domainRule: request.domain,
                preview: request.preview,
                onEvent: { event in
                    FocusOverlayController.shared.grayscaleEvent(event, nudgeId: nudgeId)
                }
            )
            switch failure {
            case nil: break
            case .permissionNeeded?: result = .shownFallbackPermission
            case .windowUnavailable?: result = .shownFallbackWindow
            case .windowSpansDisplays?: result = .shownFallbackWindowSpansDisplays
            case _?: result = .shownFallbackUnavailable
            }
        }
        if request.showsAmberEdge {
            presentGlow(glow, options: options)
        } else {
            glow.alphaValue = 0
            glow.orderOut(nil)
        }
        NSAccessibility.post(element: cardView, notification: .layoutChanged)
        return result
    }

    private func presentGlow(_ glow: FocusOverlayPanel, options: FocusOverlayAppearance) {
        if !glow.isVisible { glow.alphaValue = options.reduceMotion ? 1 : 0 }
        glow.orderFrontRegardless()
        guard !options.reduceMotion else {
            glow.alphaValue = 1
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = FocusOverlayStyle.fadeDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            glow.animator().alphaValue = 1
        }
    }

    private func grayscaleEvent(_ event: FocusGrayscaleEvent, nudgeId: String) {
        guard let request = current, request.nudgeId == nudgeId else { return }
        switch event {
        case .active:
            reportEffect("active", request: request, reason: nil)
        case .failed(let reason):
            reportEffect("fallback", request: request, reason: reason.rawValue)
        case .foregroundChanged:
            hide(nudgeId: request.nudgeId, immediate: true)
            report(action: "hidden", request: request, reason: "foreground_changed")
        }
    }

    /// Hides the current reminder. A nudge identifier limits the hide to that reminder so a late
    /// request for an older reminder cannot remove a newer one.
    func hide(nudgeId: String?, immediate: Bool) {
        guard let request = current else { return }
        if let nudgeId, !nudgeId.isEmpty, nudgeId != request.nudgeId { return }
        FocusWindowGrayscaleController.shared.stop()
        FocusGrayscaleController.shared.stop()
        current = nil
        currentDisplay = nil
        presentationToken &+= 1
        let token = presentationToken
        cardInteractiveUntil = Date().addingTimeInterval(1)
        guard let glow = glowPanel, let card = cardPanel else { return }
        card.ignoresMouseEvents = true
        if immediate || FocusOverlayAppearance.current.reduceMotion {
            glow.alphaValue = 0
            card.alphaValue = 0
            glow.orderOut(nil)
            card.orderOut(nil)
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = FocusOverlayStyle.fadeDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            glow.animator().alphaValue = 0
            card.animator().alphaValue = 0
        }, completionHandler: {
            MainActor.assumeIsolated {
                guard FocusOverlayController.shared.presentationToken == token else { return }
                glow.orderOut(nil)
                card.orderOut(nil)
            }
        })
    }

    /// Called from the collector's existing sampler. A different process or a non-browser state
    /// means the reminder no longer describes what is on screen.
    func foregroundEvidenceChanged(_ evidence: ForegroundEvidence, sampledWindow: AXUIElement?) {
        guard let request = current, !request.preview else { return }
        if evidence.kind != .browser || evidence.processIdentifier != request.expectedProcessIdentifier {
            hide(nudgeId: request.nudgeId, immediate: true)
            report(action: "hidden", request: request, reason: "foreground_changed")
        } else if request.wantsWindowGrayscale {
            FocusWindowGrayscaleController.shared.foregroundEvidence(evidence, sampledWindow: sampledWindow)
        }
    }

    /// Pointer capture asks this before recording a click so snooze and dismiss clicks are never
    /// attributed to the app underneath. `point` uses global top-left-origin coordinates.
    func recentlyContainsCardPoint(_ point: CGPoint) -> Bool {
        guard Date() <= cardInteractiveUntil, let primary = NSScreen.screens.first else { return false }
        let cocoaPoint = NSPoint(x: point.x, y: primary.frame.height - point.y)
        return cardFrame.contains(cocoaPoint)
    }

    func shutdown() {
        hide(nudgeId: nil, immediate: true)
        FocusWindowGrayscaleController.shared.stop()
        FocusGrayscaleController.shared.stop()
        if observersInstalled {
            NotificationCenter.default.removeObserver(self)
            NSWorkspace.shared.notificationCenter.removeObserver(self)
            observersInstalled = false
        }
        glowPanel?.close()
        cardPanel?.close()
        glowPanel = nil
        cardPanel = nil
        glowView = nil
        cardView = nil
        actionCallback = nil
        actionContext = nil
    }

    private func handleButton(_ action: String) {
        guard let request = current else { return }
        hide(nudgeId: request.nudgeId, immediate: false)
        report(action: action, request: request, reason: nil)
    }

    private func report(action: String, request: FocusOverlayRequest, reason: String?) {
        var payload: [String: Any] = [
            "action": action,
            "nudgeId": request.nudgeId,
            "preview": request.preview
        ]
        if let sessionId = request.sessionId { payload["sessionId"] = sessionId }
        if let reason { payload["reason"] = reason }
        send(payload)
    }

    private func reportEffect(_ status: String, request: FocusOverlayRequest, reason: String?) {
        var payload: [String: Any] = [
            "event": "effect",
            "status": status,
            "nudgeId": request.nudgeId,
            "preview": request.preview
        ]
        if let reason { payload["reason"] = reason }
        send(payload)
    }

    private func send(_ payload: [String: Any]) {
        guard let callback = actionCallback else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        String(decoding: data, as: UTF8.self).withCString { callback($0, actionContext) }
    }

    private func ensurePanels() -> (FocusOverlayPanel, FocusOverlayPanel, FocusGlowView, FocusCardView) {
        if let glowPanel, let cardPanel, let glowView, let cardView {
            return (glowPanel, cardPanel, glowView, cardView)
        }
        let glow = FocusOverlayPanel(clickThrough: true, levelOffset: 1)
        let glowView = FocusGlowView(frame: .zero)
        glow.contentView = glowView
        glow.setAccessibilityElement(false)

        let card = FocusOverlayPanel(clickThrough: false, levelOffset: 2)
        let cardView = FocusCardView(
            onSnooze: { MainActor.assumeIsolated { FocusOverlayController.shared.handleButton("snooze") } },
            onDismiss: { MainActor.assumeIsolated { FocusOverlayController.shared.handleButton("dismiss") } }
        )
        card.contentView = cardView
        card.setAccessibilityTitle("Focus reminder")

        glowPanel = glow
        cardPanel = card
        self.glowView = glowView
        self.cardView = cardView
        return (glow, card, glowView, cardView)
    }

    private func layout(
        glow: FocusOverlayPanel,
        card: FocusOverlayPanel,
        glowView: FocusGlowView,
        cardView: FocusCardView,
        on screen: NSScreen
    ) {
        glow.setFrame(screen.frame, display: false)
        glowView.frame = NSRect(origin: .zero, size: screen.frame.size)
        glowView.needsDisplay = true

        let visible = screen.visibleFrame
        let width = min(FocusOverlayStyle.cardSize.width, visible.width - 48)
        let height = FocusOverlayStyle.cardSize.height
        let frame = NSRect(
            x: visible.midX - width / 2,
            y: visible.maxY - height - FocusOverlayStyle.cardTopInset,
            width: width,
            height: height
        ).integral
        card.setFrame(frame, display: false)
        cardView.frame = NSRect(origin: .zero, size: frame.size)
        cardView.needsLayout = true
        cardFrame = frame
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
        let workspaceCenter = NSWorkspace.shared.notificationCenter
        workspaceCenter.addObserver(
            self,
            selector: #selector(foregroundApplicationChanged),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        workspaceCenter.addObserver(
            self,
            selector: #selector(activeSpaceChanged),
            name: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil
        )
        workspaceCenter.addObserver(
            self,
            selector: #selector(accessibilityOptionsChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil
        )
    }

    @objc private func screenParametersChanged() {
        guard let request = current else { return }
        guard let display = currentDisplay,
              let screen = NSScreen.screens.first(where: { displayIdentifier($0) == display }),
              let glow = glowPanel, let card = cardPanel, let glowView, let cardView else {
            hide(nudgeId: request.nudgeId, immediate: true)
            report(action: "hidden", request: request, reason: "display_changed")
            return
        }
        layout(glow: glow, card: card, glowView: glowView, cardView: cardView, on: screen)
        if FocusWindowGrayscaleController.shared.isActive {
            FocusWindowGrayscaleController.shared.geometryMayHaveChanged()
        } else {
            FocusGrayscaleController.shared.displayChanged(to: screen)
        }
    }

    @objc private func foregroundApplicationChanged() {
        guard let request = current else { return }
        if request.preview {
            FocusWindowGrayscaleController.shared.applicationActivationChanged()
            return
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier != request.expectedProcessIdentifier else { return }
        hide(nudgeId: request.nudgeId, immediate: true)
        report(action: "hidden", request: request, reason: "foreground_changed")
    }

    @objc private func activeSpaceChanged() {
        guard let request = current else { return }
        if request.preview {
            FocusWindowGrayscaleController.shared.geometryMayHaveChanged()
            return
        }
        hide(nudgeId: request.nudgeId, immediate: true)
        report(action: "hidden", request: request, reason: "space_changed")
    }

    @objc private func accessibilityOptionsChanged() {
        let options = FocusOverlayAppearance.current
        glowView?.appearanceOptions = options
        cardView?.apply(options)
        if options.reduceMotion, let request = current {
            if request.showsAmberEdge { glowPanel?.alphaValue = 1 }
            cardPanel?.alphaValue = 1
        }
    }

    private func previewScreen() -> NSScreen? {
        let hostWindow = [NSApp.keyWindow, NSApp.mainWindow].compactMap { $0 }.first
            ?? NSApp.windows.first { $0.isVisible && !($0 is FocusOverlayPanel) }
        return hostWindow?.screen ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func screenForProcess(_ processIdentifier: pid_t) -> NSScreen? {
        if AXIsProcessTrusted(),
           let frame = accessibility.focusedWindowFrame(processIdentifier: processIdentifier),
           let screen = bestScreen(forTopLeftRect: frame) {
            return screen
        }
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return nil }
        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? Int32) == processIdentifier,
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
            if let screen = bestScreen(forTopLeftRect: rect) { return screen }
        }
        return nil
    }

    private func bestScreen(forTopLeftRect rect: CGRect) -> NSScreen? {
        guard let primary = NSScreen.screens.first else { return nil }
        let cocoaRect = CGRect(
            x: rect.minX,
            y: primary.frame.height - rect.maxY,
            width: rect.width,
            height: rect.height
        )
        var best: (screen: NSScreen, area: CGFloat)?
        for screen in NSScreen.screens {
            let intersection = screen.frame.intersection(cocoaRect)
            let area = intersection.isNull ? 0 : intersection.width * intersection.height
            if area > (best?.area ?? 0) { best = (screen, area) }
        }
        return best?.screen
    }

    private func displayIdentifier(_ screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}

@_cdecl("openhistory_focus_overlay_show")
public func openHistoryFocusOverlayShow(_ requestJSON: UnsafePointer<CChar>?) -> Int32 {
    guard Thread.isMainThread else { return FocusOverlayShowResult.notMainThread.rawValue }
    guard let requestJSON,
          let request = try? JSONDecoder().decode(
              FocusOverlayRequest.self,
              from: Data(String(cString: requestJSON).utf8)
          ) else { return FocusOverlayShowResult.invalidRequest.rawValue }
    return MainActor.assumeIsolated {
        FocusOverlayController.shared.show(request).rawValue
    }
}

@_cdecl("openhistory_focus_overlay_hide")
public func openHistoryFocusOverlayHide(_ nudgeId: UnsafePointer<CChar>?, _ immediate: Bool) {
    guard Thread.isMainThread else { return }
    let identifier = nudgeId.map { String(cString: $0) }
    MainActor.assumeIsolated {
        FocusOverlayController.shared.hide(nudgeId: identifier, immediate: immediate)
    }
}

@_cdecl("openhistory_focus_overlay_set_action_callback")
public func openHistoryFocusOverlaySetActionCallback(
    _ callback: OpenHistoryFocusActionCallback?,
    _ context: UnsafeMutableRawPointer?
) {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated {
        FocusOverlayController.shared.setActionCallback(callback, context: context)
    }
}

@_cdecl("openhistory_focus_overlay_shutdown")
public func openHistoryFocusOverlayShutdown() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated {
        FocusOverlayController.shared.shutdown()
    }
}
