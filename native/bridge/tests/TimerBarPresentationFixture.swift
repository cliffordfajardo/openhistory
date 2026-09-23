import AppKit

@MainActor
private final class Fixture: NSObject, NSApplicationDelegate {
    private var failures = 0
    private let total = 20.0

    func applicationDidFinishLaunching(_ notification: Notification) {
        checkPanelFlagsAndPlacement()
        checkLinearShrinkAcrossEveryPanel()
        checkRecoloringKeepsTheSameCountdown()
        checkPauseFreezesTheFill()
        checkReduceMotionStepsFromTheHeartbeatAlone()
        checkTurningItOffRemovesEverything()
        print(failures == 0 ? "\nAll timer bar presentation checks passed." : "\n\(failures) check(s) FAILED.")
        exit(failures == 0 ? 0 : 1)
    }


    private func checkPanelFlagsAndPlacement() {
        let deadline = Date().timeIntervalSince1970 + total
        expect(send(enabled: true, endsAt: deadline) == 0, "a valid request is applied")
        expect(!panels().isEmpty, "one panel exists")
        expect(panels().count == NSScreen.screens.count, "one panel per display")
        for panel in panels() {
            expect(panel.level == .statusBar, "the panel sits at exactly the status bar level")
            expect(panel.ignoresMouseEvents, "clicks pass straight through the panel")
            expect(!panel.canBecomeKey && !panel.canBecomeMain, "the panel never takes the keyboard")
            expect(!panel.isKeyWindow, "and never became key by being shown")
            expect(panel.isVisible, "the panel is on screen")
            for behavior: NSWindow.CollectionBehavior in
                [.canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary, .stationary, .ignoresCycle] {
                expect(panel.collectionBehavior.contains(behavior), "collection behavior \(behavior.rawValue)")
            }
            guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(panel.frame) }) else {
                expect(false, "the panel is on a connected display")
                continue
            }
            expect(panel.frame.width == screen.frame.width, "the panel spans the full display width")
            expect(abs(panel.frame.maxY - screen.frame.maxY) < 0.5, "the panel is anchored to the top edge")
            expect(panel.frame.height <= max(3, screen.frame.maxY - screen.visibleFrame.maxY) + 0.5,
                   "the panel is no taller than the menu region")
        }
        expect(NSApp.keyWindow == nil, "showing the bar never activated the app")
        expect(send(enabled: true, endsAt: deadline, pausedRemaining: 10) == 1,
               "two clocks in one request are refused")
        expect(send(enabled: true, endsAt: deadline, total: 0) == 1, "a zero-length session is refused")
        expect(send(enabled: true, endsAt: deadline, progressColor: "#12345") == 1,
               "a malformed color is refused rather than guessed at")
        expect(send(enabled: true, endsAt: deadline, progressColor: nil) == 0,
               "an app that sends no color at all still gets the original green")
        expect(send(enabled: true, endsAt: nil) == 0, "an enabled request with no session is applied")
        expect(!panels().isEmpty, "which keeps the panels ready for the next session")
        expect(panels().allSatisfy { !$0.isVisible }, "with nothing drawn on screen")
    }

    private func checkLinearShrinkAcrossEveryPanel() {
        let started = Date()
        let deadline = started.timeIntervalSince1970 + total
        _ = send(enabled: true, endsAt: deadline)
        var samples: [(elapsed: Double, fraction: Double)] = []
        for _ in 0..<5 {
            heartbeat(seconds: 1, endsAt: deadline)
            let fractions = drawnFractions()
            expect((fractions.max() ?? 0) - (fractions.min() ?? 0) < 0.02,
                   "every display shows the same fraction")
            samples.append((elapsed: Date().timeIntervalSince(started), fraction: fractions.first ?? -1))
        }
        for sample in samples {
            let expected = max(0, 1 - sample.elapsed / total)
            expect(abs(sample.fraction - expected) < 0.05,
                   String(format: "after %.1fs the fill is %.3f, near the clock's %.3f",
                          sample.elapsed, sample.fraction, expected))
        }
        let steps = zip(samples, samples.dropFirst()).map { $0.0.fraction - $0.1.fraction }
        if let smallest = steps.min(), let largest = steps.max() {
            expect(largest - smallest < 0.03, "the fill shrinks at a steady, linear rate")
        }
    }

    private func checkRecoloringKeepsTheSameCountdown() {
        let deadline = Date().timeIntervalSince1970 + total
        _ = send(enabled: true, endsAt: deadline)
        wait(1)
        let before = drawnFractions().first ?? -1
        _ = send(enabled: true, endsAt: deadline, progressColor: "#b86b5c")
        wait(0.1)
        let after = drawnFractions().first ?? -1
        expect(before - after < 0.02 && after < before,
               String(format: "a new color leaves the fill at %.3f, near the %.3f it had reached",
                      after, before))
    }

    private func checkPauseFreezesTheFill() {
        _ = send(enabled: true, endsAt: nil, pausedRemaining: total / 2)
        wait(0.1)
        let atPause = drawnFractions().first ?? -1
        expect(abs(atPause - 0.5) < 0.02, "a pause draws exactly the remainder it was given")
        heartbeat(seconds: 2, endsAt: nil, pausedRemaining: total / 2)
        expect(abs((drawnFractions().first ?? -1) - atPause) < 0.005,
               "and the fill does not move while the session is paused")
    }

    private func checkReduceMotionStepsFromTheHeartbeatAlone() {
        FocusOverlayAppearance.forcedReduceMotion = true
        let deadline = Date().timeIntervalSince1970 + total
        _ = send(enabled: true, endsAt: deadline)
        wait(0.1)
        let drawn = drawnFractions().first ?? -1
        wait(1.5)
        expect(abs((drawnFractions().first ?? -1) - drawn) < 0.005,
               "under Reduce Motion nothing animates between heartbeats")
        _ = send(enabled: true, endsAt: deadline)
        wait(0.1)
        let stepped = drawnFractions().first ?? -1
        expect(drawn - stepped > 0.02, "and the heartbeat itself steps the fill down")
        FocusOverlayAppearance.forcedReduceMotion = false
    }

    private func checkTurningItOffRemovesEverything() {
        _ = send(enabled: true, endsAt: Date().timeIntervalSince1970 + total)
        expect(!panels().isEmpty, "the bar is back before it is switched off")
        expect(send(enabled: false, endsAt: nil) == 0, "switching the preference off is applied")
        wait(0.2)
        expect(panels().allSatisfy { !$0.isVisible }, "no panel is left on screen")
        TimerBarController.shared.shutdown()
        wait(0.2)
        expect(panels().allSatisfy { !$0.isVisible }, "and shutting down leaves nothing visible either")
    }


    private func send(
        enabled: Bool,
        endsAt: Double?,
        pausedRemaining: Double? = nil,
        total: Double? = nil,
        progressColor: String? = "#5c9e73"
    ) -> Int32 {
        var session = "null"
        if endsAt != nil || pausedRemaining != nil {
            session = """
            {"endsAtEpochSeconds":\(endsAt.map { String($0) } ?? "null"),\
            "pausedRemainingSeconds":\(pausedRemaining.map { String($0) } ?? "null"),\
            "totalSeconds":\(total ?? self.total)}
            """
        }
        let color = progressColor.map { "\"\($0)\"" } ?? "null"
        let request = "{\"enabled\":\(enabled),\"session\":\(session),\"progressColor\":\(color)}"
        return request.withCString { openHistoryTimerBarUpdate($0) }
    }

    private func heartbeat(seconds: Int, endsAt: Double?, pausedRemaining: Double? = nil) {
        for _ in 0..<seconds {
            wait(1)
            _ = send(enabled: true, endsAt: endsAt, pausedRemaining: pausedRemaining)
        }
    }

    private func panels() -> [TimerBarPanel] {
        NSApp.windows.compactMap { $0 as? TimerBarPanel }
    }

    private func drawnFractions() -> [Double] {
        panels().compactMap { panel in
            guard let content = panel.contentView as? TimerBarContentView, panel.frame.width > 0 else {
                return nil
            }
            return Double(content.drawnWidth / panel.frame.width)
        }
    }

    private func wait(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func expect(_ condition: Bool, _ description: String) {
        if !condition { failures += 1 }
        print("\(condition ? "ok  " : "FAIL") \(description)")
    }
}

@main
@MainActor
private enum TimerBarPresentationFixture {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let fixture = Fixture()
        app.delegate = fixture
        app.run()
        withExtendedLifetime(fixture) {}
    }
}
