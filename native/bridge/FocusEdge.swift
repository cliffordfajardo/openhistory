#if canImport(ActivityCore)
import ActivityCore
#endif
import AppKit
import Foundation

/**
 What the main process asks the edge to be: a mode, one resolved `#rrggbb` color and whether focus
 halo may show. No site, list or preference detail crosses the bridge. A visible halo names the
 accepted observation it stands on, so a halo hidden here after a context change stays hidden
 until a newer observation arrives.
 */
struct FocusEdgeSnapshot: Decodable {
    enum Mode: String, Decodable {
        case off
        case distraction
        case focusHalo = "focus_halo"
    }

    struct Halo: Decodable {
        enum Kind: String, Decodable {
            case hidden
            case visible
        }

        let kind: Kind
        let generation: UInt64?
        let sequence: UInt64?
    }

    let mode: Mode
    let color: String
    let halo: Halo

    var validated: FocusEdgeConfiguration? {
        guard let parsed = FocusProgressColor.parse(color) else { return nil }
        let observation: FocusEdgeObservation?
        switch (halo.kind, halo.generation, halo.sequence) {
        case (.hidden, nil, nil):
            observation = nil
        case let (.visible, generation?, sequence?) where mode == .focusHalo && generation > 0:
            observation = FocusEdgeObservation(generation: generation, sequence: sequence)
        default:
            return nil
        }
        return FocusEdgeConfiguration(
            mode: mode,
            // The default is drawn with the exact original amber, including its Increase Contrast
            // variant, so an edge nobody recolored looks as it always has.
            color: color.lowercased() == FocusEdgeStyle.defaultColor ? nil : parsed,
            halo: observation
        )
    }
}

struct FocusEdgeObservation: Equatable {
    let generation: UInt64
    let sequence: UInt64

    func isNewer(than other: FocusEdgeObservation?) -> Bool {
        guard let other else { return true }
        return generation > other.generation ||
            (generation == other.generation && sequence > other.sequence)
    }
}

struct FocusEdgeConfiguration {
    let mode: FocusEdgeSnapshot.Mode
    /// Nil draws the original amber.
    let color: FocusProgressColor?
    /// Present only when focus halo may show.
    let halo: FocusEdgeObservation?
}

enum FocusEdgeUpdateResult: Int32 {
    case applied = 0
    case invalidRequest = 1
    case notMainThread = 2
    case noDisplay = 3
}

enum FocusEdgeStyle {
    static let defaultColor = "#ffad33"
    static let fadeDuration: TimeInterval = 0.6
    static let glowDepth: CGFloat = 60
    static let cornerRadius: CGFloat = 12
    static let amber = CGColor(srgbRed: 1.0, green: 0.68, blue: 0.2, alpha: 1)
    static let contrastAmber = CGColor(srgbRed: 1.0, green: 0.6, blue: 0.0, alpha: 1)
}

final class FocusGlowView: NSView {
    var appearanceOptions = FocusOverlayAppearance(
        reduceMotion: false,
        reduceTransparency: false,
        increaseContrast: false
    ) { didSet { if oldValue != appearanceOptions { needsDisplay = true } } }

    /// Nil draws the original amber.
    var color: FocusProgressColor? { didSet { if oldValue != color { needsDisplay = true } } }

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
        let color = self.color?.cgColor(alpha: 1) ??
            (options.increaseContrast ? FocusEdgeStyle.contrastAmber : FocusEdgeStyle.amber)
        let radius = FocusEdgeStyle.cornerRadius
        let edge = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
        context.addPath(edge)
        context.clip()

        if !options.reduceTransparency {
            context.saveGState()
            let frame = CGMutablePath()
            frame.addRect(bounds.insetBy(dx: -FocusEdgeStyle.glowDepth * 4, dy: -FocusEdgeStyle.glowDepth * 4))
            frame.addPath(edge)
            context.setShadow(
                offset: .zero,
                blur: FocusEdgeStyle.glowDepth,
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

/**
 The one owner of every edge panel: the reminder edge on the display with the distracting window,
 and focus halo on every connected display. The reminder controller only reports which reminder is
 showing where; this decides what is drawn, so the two edges can never compete for a display.

 Panels are `FocusOverlayPanel`s, which keeps them click-through, never key or main, and excluded
 from the captured grayscale image. Nothing redraws while the edge is unchanged.
 */
@MainActor
final class FocusEdgeController: NSObject {
    static let shared = FocusEdgeController()

    private struct Reminder {
        let id: String
        let displayID: CGDirectDisplayID?
        /// The request's own `amberEdge`, honored only until the app sends an edge update.
        let legacyEdge: Bool
    }

    @MainActor
    private final class Surface {
        let panel: FocusOverlayPanel
        let view: FocusGlowView
        /// Wanted on screen; false while fading out.
        var visible = false
        /// Replaced on every visibility change so a stale fade completion does nothing.
        var fadeToken: UInt64 = 0

        init() {
            panel = FocusOverlayPanel(clickThrough: true, levelOffset: 1)
            view = FocusGlowView(frame: .zero)
            panel.contentView = view
            panel.setAccessibilityElement(false)
        }
    }

    /// Nil until the app sends an edge update. Until then, as before the edge owner existed, a
    /// reminder draws the amber edge only when its request asks for it.
    private var configuration: FocusEdgeConfiguration?
    private var reminder: Reminder?
    private var surfaces: [CGDirectDisplayID: Surface] = [:]
    private var invalidatedObservation: FocusEdgeObservation?
    /// A context change hid a showing halo; it comes back without fading in again.
    private var haloInterrupted = false
    private var observersInstalled = false
    private var fadeCounter: UInt64 = 0

    func update(_ snapshot: FocusEdgeSnapshot) -> FocusEdgeUpdateResult {
        guard let next = snapshot.validated else { return .invalidRequest }
        configuration = next
        if next.mode == .off {
            removeObservers()
        } else {
            installObserversIfNeeded()
        }
        if next.halo == nil { haloInterrupted = false }
        reconcile(immediate: true)
        if next.mode == .focusHalo, next.halo != nil, NSScreen.screens.isEmpty { return .noDisplay }
        return .applied
    }

    /// The reminder card is showing on `displayID`. Replaces any earlier reminder.
    func reminderDidShow(id: String, displayID: CGDirectDisplayID?, legacyEdge: Bool) {
        installObserversIfNeeded()
        reminder = Reminder(id: id, displayID: displayID, legacyEdge: legacyEdge)
        reconcile(immediate: true)
    }

    /// The reminder named `id` is going away. A later reminder is never affected by a late hide.
    func reminderDidHide(id: String, immediate: Bool) {
        guard reminder?.id == id else { return }
        reminder = nil
        reconcile(immediate: immediate)
    }

    /// Removes every panel and observer and forgets the reminder and the app's configuration.
    func shutdown() {
        removeObservers()
        for surface in surfaces.values { close(surface) }
        surfaces.removeAll()
        configuration = nil
        reminder = nil
        invalidatedObservation = nil
        haloInterrupted = false
    }

    private func desiredScreens() -> [CGDirectDisplayID: NSScreen] {
        let connected = connectedScreens()
        guard let configuration else {
            guard let reminder, reminder.legacyEdge, let display = reminder.displayID else { return [:] }
            return connected.filter { $0.key == display }
        }
        switch configuration.mode {
        case .off:
            return [:]
        case .distraction:
            guard let display = reminder?.displayID else { return [:] }
            return connected.filter { $0.key == display }
        case .focusHalo:
            // The app hides the halo before any card shows; this keeps a card and the halo apart
            // even if an update arrives out of order.
            guard reminder == nil, let observation = configuration.halo,
                  observation.isNewer(than: invalidatedObservation) else { return [:] }
            return connected
        }
    }

    private func reconcile(immediate: Bool) {
        let desired = desiredScreens()
        for (id, surface) in surfaces where desired[id] == nil {
            hide(surface, id: id, immediate: immediate)
        }
        guard !desired.isEmpty else { return }
        let options = FocusOverlayAppearance.current
        let color = configuration?.color
        let fade = !options.reduceMotion && !haloInterrupted
        for (id, screen) in desired {
            let surface = surfaces[id] ?? Surface()
            surfaces[id] = surface
            show(surface, on: screen, color: color, options: options, fade: fade)
        }
        haloInterrupted = false
    }

    private func show(
        _ surface: Surface,
        on screen: NSScreen,
        color: FocusProgressColor?,
        options: FocusOverlayAppearance,
        fade: Bool
    ) {
        let panel = surface.panel
        if panel.frame != screen.frame {
            panel.setFrame(screen.frame, display: false)
            surface.view.frame = NSRect(origin: .zero, size: screen.frame.size)
            surface.view.needsDisplay = true
        }
        surface.view.appearanceOptions = options
        surface.view.color = color
        guard !surface.visible else { return }
        surface.visible = true
        surface.fadeToken = nextFadeToken()
        if !panel.isVisible { panel.alphaValue = fade ? 0 : 1 }
        panel.orderFrontRegardless()
        guard fade else {
            panel.alphaValue = 1
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = FocusEdgeStyle.fadeDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = 1
        }
    }

    private func hide(_ surface: Surface, id: CGDirectDisplayID, immediate: Bool) {
        if immediate || FocusOverlayAppearance.current.reduceMotion {
            close(surface)
            surfaces[id] = nil
            return
        }
        // A surface that is no longer wanted but still listed is already fading out.
        guard surface.visible else { return }
        surface.visible = false
        let token = nextFadeToken()
        surface.fadeToken = token
        let panel = surface.panel
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = FocusEdgeStyle.fadeDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = 0
        }, completionHandler: {
            MainActor.assumeIsolated {
                FocusEdgeController.shared.fadeOutFinished(id: id, token: token)
            }
        })
    }

    private func fadeOutFinished(id: CGDirectDisplayID, token: UInt64) {
        guard let surface = surfaces[id], surface.fadeToken == token else { return }
        close(surface)
        surfaces[id] = nil
    }

    private func nextFadeToken() -> UInt64 {
        fadeCounter &+= 1
        return fadeCounter
    }

    private func close(_ surface: Surface) {
        surface.visible = false
        surface.fadeToken = nextFadeToken()
        surface.panel.alphaValue = 0
        surface.panel.orderOut(nil)
        surface.panel.close()
    }

    private func connectedScreens() -> [CGDirectDisplayID: NSScreen] {
        var screens: [CGDirectDisplayID: NSScreen] = [:]
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                continue
            }
            let id = CGDirectDisplayID(number.uint32Value)
            if screens[id] == nil { screens[id] = screen }
        }
        return screens
    }

    private func removeObservers() {
        guard observersInstalled else { return }
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        observersInstalled = false
    }

    private func installObserversIfNeeded() {
        guard configuration?.mode != .off, !observersInstalled else { return }
        observersInstalled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        let workspaceCenter = NSWorkspace.shared.notificationCenter
        for name: NSNotification.Name in [
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.activeSpaceDidChangeNotification,
            NSWorkspace.didWakeNotification,
            NSWorkspace.screensDidWakeNotification
        ] {
            workspaceCenter.addObserver(
                self,
                selector: #selector(foregroundContextChanged),
                name: name,
                object: nil
            )
        }
        workspaceCenter.addObserver(
            self,
            selector: #selector(accessibilityOptionsChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil
        )
    }

    @objc private func screenParametersChanged() {
        reconcile(immediate: true)
    }

    /// What is in front may have changed before the app has judged it, so a showing halo goes
    /// until evidence newer than the one it stood on arrives.
    @objc private func foregroundContextChanged() {
        guard let configuration, configuration.mode == .focusHalo, let observation = configuration.halo,
              observation.isNewer(than: invalidatedObservation) else { return }
        invalidatedObservation = observation
        haloInterrupted = surfaces.values.contains { $0.visible }
        reconcile(immediate: true)
    }

    @objc private func accessibilityOptionsChanged() {
        let options = FocusOverlayAppearance.current
        for surface in surfaces.values {
            surface.view.appearanceOptions = options
            if options.reduceMotion, surface.visible { surface.panel.alphaValue = 1 }
        }
    }
}

@_cdecl("openhistory_focus_edge_update")
public func openHistoryFocusEdgeUpdate(_ snapshotJSON: UnsafePointer<CChar>?) -> Int32 {
    guard Thread.isMainThread else { return FocusEdgeUpdateResult.notMainThread.rawValue }
    guard let snapshotJSON,
          let snapshot = try? JSONDecoder().decode(
              FocusEdgeSnapshot.self,
              from: Data(String(cString: snapshotJSON).utf8)
          ) else { return FocusEdgeUpdateResult.invalidRequest.rawValue }
    return MainActor.assumeIsolated { FocusEdgeController.shared.update(snapshot).rawValue }
}

@_cdecl("openhistory_focus_edge_shutdown")
public func openHistoryFocusEdgeShutdown() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { FocusEdgeController.shared.shutdown() }
}
