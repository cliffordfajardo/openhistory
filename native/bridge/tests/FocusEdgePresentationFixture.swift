import ActivityCore
import AppKit

@MainActor private final class Fixture: NSObject, NSApplicationDelegate {
    let checks = Checks()
    let colors = ["#5c84b8", "#5c9e73", "#b86b5c", "#8a75b8", "#c9964a", "#8a8f96", "#267bc3", "#A12BCD", "#000000", "#ffffff"]
    func applicationDidFinishLaunching(_ notification: Notification) {
        legacyAndPixels()
        boundary()
        reminderIsolation()
        haloLifecycle()
        shutdown()
        NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        checks.wait(0.7)
        checks.expect(checks.panels().allSatisfy { !$0.isVisible }, "shutdown and subsequent notifications leave all panels hidden")
        shutdown()
        print("Focus edge presentation fixture: \(checks.failures) failure(s); capture controllers are shims.")
        exit(checks.failures == 0 ? 0 : 1)
    }
    func shutdown() { openHistoryFocusOverlayShutdown(); openHistoryFocusEdgeShutdown() }
    func sendRaw(_ json: String) -> Int32 {
        let before = FocusIdentity()
        let result = json.withCString { openHistoryFocusEdgeUpdate($0) }
        checks.expect(FocusIdentity() == before, "edge update preserves foreground/key/main/first responder")
        return result
    }
    @discardableResult func update(_ mode: String, color: String = "#ffad33", token: (Int, Int)? = nil) -> Int32 {
        let halo = token.map { "{\"kind\":\"visible\",\"generation\":\($0.0),\"sequence\":\($0.1)}" } ?? "{\"kind\":\"hidden\"}"
        return sendRaw("{\"mode\":\"\(mode)\",\"color\":\"\(color)\",\"halo\":\(halo)}")
    }
    @discardableResult func show(_ id: String, edge: Bool? = true, experience: String = "grayscale_system") -> Int32 {
        let edgeField = edge.map { ",\"amberEdge\":\($0)" } ?? ""
        let json = "{\"nudgeId\":\"\(id)\",\"title\":\"Synthetic fixture\",\"message\":\"No capture\",\"preview\":true,\"experience\":\"\(experience)\"\(edgeField)}"
        return json.withCString { openHistoryFocusOverlayShow($0) }
    }
    func hide(_ id: String, immediate: Bool) { id.withCString { openHistoryFocusOverlayHide($0, immediate) } }
    var visibleEdges: [FocusOverlayPanel] { checks.glowPanels().filter(\.isVisible) }
    var captureCounts: [Int] { [FocusGrayscaleController.shared.starts, FocusGrayscaleController.shared.stops,
                               FocusWindowGrayscaleController.shared.starts, FocusWindowGrayscaleController.shared.stops] }
    func pixel(_ view: FocusGlowView, color: String) {
        let saved = view.appearanceOptions
        view.appearanceOptions = .init(reduceMotion: true, reduceTransparency: true, increaseContrast: false)
        let samples = GlowBitmap.render(view, at: [CGPoint(x: view.bounds.midX, y: 1), CGPoint(x: view.bounds.midX, y: view.bounds.midY)])
        let value = UInt32(color.dropFirst(), radix: 16)!
        let expected = color.lowercased() == "#ffad33" ? (1.0, 0.68, 0.2) :
            (Double((value >> 16) & 255) / 255, Double((value >> 8) & 255) / 255, Double(value & 255) / 255)
        checks.expect(samples[0].near(expected) && samples[0].alpha > 0.99, "actual drawn \(color) perimeter: \(samples[0])")
        checks.expect(samples[1].alpha == 0, "\(color) leaves center transparent")
        view.appearanceOptions = saved
    }
    func legacyAndPixels() {
        checks.expect(show("legacy-missing", edge: nil) == 0, "omitted legacy edge accepted")
        checks.wait(0.7)
        checks.expect(visibleEdges.count == 1, "legacy request with omitted edge shows one amber edge")
        if let view = visibleEdges.first?.contentView as? FocusGlowView { pixel(view, color: "#ffad33") }
        show("legacy-off", edge: false)
        checks.expect(visibleEdges.isEmpty, "legacy false removes edge")
        checks.expect(checks.cardPanels().contains(where: \.isVisible), "legacy false preserves card")
        show("legacy-on", edge: true)
        checks.wait(0.7)
        checks.expect(visibleEdges.count == 1, "legacy true restores edge")
        shutdown()
        let view = FocusGlowView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        let points = [CGPoint(x: 320, y: 1), CGPoint(x: 320, y: 20), CGPoint(x: 320, y: 200)]
        let normal = GlowBitmap.render(view, at: points)
        checks.expect(normal[0].near((1, 0.68, 0.2)) && normal[0].alpha > 0.85, "normal legacy perimeter keeps hue/opacity: \(normal[0])")
        checks.expect(normal[1].alpha > 0 && normal[1].alpha < normal[0].alpha && normal[2].alpha == 0, "normal glow fades inward and center is clear: \(normal[1]), \(normal[2])")
        view.appearanceOptions = .init(reduceMotion: true, reduceTransparency: true, increaseContrast: true)
        checks.expect(GlowBitmap.render(view, at: points)[0].near((1, 0.6, 0)), "default Increase Contrast amber unchanged")
        view.color = FocusProgressColor.parse("#267bc3")
        checks.expect(GlowBitmap.render(view, at: points)[0].near((38.0/255, 123.0/255, 195.0/255)), "custom Increase Contrast retains chosen hue")
    }
    func boundary() {
        checks.expect(openHistoryFocusEdgeUpdate(nil) == 1, "nil request rejected")
        for input in ["{bad", "{}", "{\"mode\":\"sepia\",\"color\":\"#ffad33\",\"halo\":{\"kind\":\"hidden\"}}"] {
            checks.expect(sendRaw(input) == 1, "invalid snapshot rejected: \(input)")
        }
        for color in ["#abc", "#1234567", "red", "#zz1234", "#12345g", "#12345678"] {
            checks.expect(update("off", color: color) == 1, "invalid color rejected: \(color)")
        }
        checks.expect(update("focus_halo", token: (0, 1)) == 1, "zero generation rejected")
        checks.expect(update("distraction", token: (1, 1)) == 1, "visible halo invalid in distraction mode")
    }
    func reminderIsolation() {
        update("distraction")
        show("screen", experience: "grayscale_screen")
        checks.wait(0.7)
        let card = checks.cardPanels().first(where: \.isVisible)
        let counts = captureCounts
        checks.expect(FocusGrayscaleController.shared.isActive, "synthetic screen capture is active")
        let panel = visibleEdges.first
        for color in colors {
            checks.expect(update("distraction", color: color) == 0, "live distraction color accepted: \(color)")
            checks.expect(visibleEdges.first === panel, "live recolor reuses same panel")
            if let view = visibleEdges.first?.contentView as? FocusGlowView { pixel(view, color: color) }
            checks.expect(captureCounts == counts && card?.isVisible == true, "recolor leaves card and capture lifecycle unchanged")
        }
        update("off")
        checks.expect(visibleEdges.isEmpty, "off immediately removes edge during live reminder")
        update("distraction", color: "#267bc3")
        checks.wait(0.7)
        checks.expect(visibleEdges.count == 1, "off retains reminder registration for re-enabling distraction edge")
        checks.expect(captureCounts == counts && card?.isVisible == true, "off/on did not restart capture or replace card")
        update("focus_halo", token: (1, 1))
        checks.expect(visibleEdges.isEmpty, "visible reminder suppresses halo even with visible snapshot")
        checks.expect(captureCounts == counts && card?.isVisible == true, "halo mode leaves active reminder untouched")
        update("distraction")
        checks.wait(0.7)
        hide("screen", immediate: false)
        checks.wait(0.1)
        update("focus_halo", color: "#267bc3", token: (1, 2))
        checks.wait(0.8)
        checks.expect(visibleEdges.count == NSScreen.screens.count, "old reminder fade cannot remove new halo")
        checks.expect(checks.cardPanels().allSatisfy { !$0.isVisible }, "old reminder card completes fade independently")
        checks.expect(!FocusGrayscaleController.shared.isActive, "real reminder hide stops screen shim")
        update("distraction")
        show("window", experience: "grayscale_window")
        let windowCounts = captureCounts
        update("off"); update("distraction", color: "#5c84b8")
        checks.expect(captureCounts == windowCounts && FocusWindowGrayscaleController.shared.isActive, "window capture unchanged across mode/color edits")
        hide("old-id", immediate: true)
        checks.expect(FocusWindowGrayscaleController.shared.isActive, "stale reminder hide does not stop current capture")
        hide("window", immediate: true)
        checks.expect(!FocusWindowGrayscaleController.shared.isActive, "current reminder hide stops window shim")
    }
    func haloLifecycle() {
        for (index, color) in colors.enumerated() {
            checks.expect(update("focus_halo", color: color, token: (2, 10 + index)) == 0, "halo color accepted: \(color)")
            checks.expect(visibleEdges.count == NSScreen.screens.count, "halo owns one edge per connected screen")
            for panel in visibleEdges {
                if let view = panel.contentView as? FocusGlowView { pixel(view, color: color) }
            }
        }
        checks.wait(0.7)
        update("focus_halo", color: "#ffffff", token: (2, 19))
        for panel in visibleEdges {
            checks.expect(panel.alphaValue > 0.99 && NSScreen.screens.contains { $0.frame == panel.frame }, "halo visible on full screen frame \(panel.frame)")
            checks.expect(panel.ignoresMouseEvents && !panel.canBecomeKey && !panel.canBecomeMain && panel.styleMask.contains(.nonactivatingPanel), "halo is click-through/nonactivating/non-key/non-main")
            checks.expect(panel.level.rawValue == NSWindow.Level.statusBar.rawValue + 1, "halo keeps grayscale/card-compatible window level")
            for behavior: NSWindow.CollectionBehavior in [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle] {
                checks.expect(panel.collectionBehavior.contains(behavior), "halo collection behavior \(behavior.rawValue)")
            }
            if let view = panel.contentView as? FocusGlowView {
                checks.expect([CGPoint.zero, CGPoint(x: 1,y: panel.frame.midY), CGPoint(x: panel.frame.midX,y: panel.frame.midY)].allSatisfy { view.hitTest($0) == nil }, "halo hit testing ignores corners/edge/center")
            }
        }
        for (index, name) in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification,
                              NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification].enumerated() {
            let sequence = 20 + index * 2
            update("focus_halo", token: (2, sequence))
            checks.wait(0.07)
            NSWorkspace.shared.notificationCenter.post(name: name, object: nil)
            checks.expect(visibleEdges.isEmpty, "\(name.rawValue) immediately invalidates halo")
            update("focus_halo", token: (2, sequence))
            checks.expect(visibleEdges.isEmpty, "same token cannot restore invalidated halo")
            update("focus_halo", token: (2, sequence - 1))
            checks.expect(visibleEdges.isEmpty, "older unequal token cannot restore invalidated halo")
            update("focus_halo", token: (1, 999))
            checks.expect(visibleEdges.isEmpty, "older generation cannot restore invalidated halo")
            NSWorkspace.shared.notificationCenter.post(name: name, object: nil)
            update("focus_halo", token: (2, sequence))
            checks.expect(visibleEdges.isEmpty, "context event with older configuration cannot lower invalidation watermark")
            update("focus_halo", token: (2, sequence + 1))
            checks.expect(visibleEdges.count == NSScreen.screens.count && visibleEdges.allSatisfy { $0.alphaValue == 1 }, "new token restores halo without repeating fade")
        }
        NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: nil)
        checks.expect(visibleEdges.count == NSScreen.screens.count, "display reconciliation preserves correct panel count")
        update("focus_halo", token: (4, 0))
        checks.expect(visibleEdges.count == NSScreen.screens.count, "new generation with reset sequence is newer than old generation")
        update("focus_halo")
        checks.expect(visibleEdges.isEmpty, "hidden snapshot immediately removes halo")
        checks.wait(0.7)
        checks.expect(visibleEdges.isEmpty, "hidden halo cannot return after old fades")
        update("focus_halo", token: (5, 1))
        update("off")
        checks.expect(visibleEdges.isEmpty, "off closes halo during fade-in")
        update("focus_halo", token: (5, 2))
        shutdown()
    }
}

@main @MainActor private enum FocusEdgePresentationFixture {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let fixture = Fixture()
        app.delegate = fixture
        app.run()
        withExtendedLifetime(fixture) {}
    }
}
