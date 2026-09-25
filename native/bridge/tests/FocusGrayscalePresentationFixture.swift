import AppKit
import CoreVideo
import Metal

private final class ReferenceView: NSView {
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let halfWidth = bounds.width / 2
        let halfHeight = bounds.height / 2
        let tiles: [(NSColor, NSRect)] = [
            (.red, NSRect(x: 0, y: 0, width: halfWidth, height: halfHeight)),
            (.green, NSRect(x: halfWidth, y: 0, width: halfWidth, height: halfHeight)),
            (.blue, NSRect(x: 0, y: halfHeight, width: halfWidth, height: halfHeight)),
            (.white, NSRect(x: halfWidth, y: halfHeight, width: halfWidth, height: halfHeight))
        ]
        for (color, rect) in tiles {
            color.setFill()
            rect.fill()
        }
    }
}

@MainActor
private final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var renderer: FocusGrayscaleRenderer?
    private var grayscaleView: FocusGrayscaleView?
    private var source: CVPixelBuffer?
    private var timer: Timer?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let renderer = FocusGrayscaleRenderer(), let source = makeSource() else {
            fatalError("Metal or synthetic source unavailable")
        }
        self.renderer = renderer
        self.source = source

        let window = NSWindow(contentRect: NSRect(x: 200, y: 160, width: 860, height: 480),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Grayscale orientation fixture"
        window.backgroundColor = .darkGray
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 860, height: 480))
        let reference = ReferenceView(frame: NSRect(x: 20, y: 20, width: 400, height: 400))
        let grayscale = FocusGrayscaleView(frame: NSRect(x: 440, y: 20, width: 400, height: 400),
                                           device: renderer.device, scale: 1)
        grayscale.metalLayer.drawableSize = CGSize(width: 400, height: 400)
        content.addSubview(reference)
        content.addSubview(grayscale)
        for (title, x) in [("SOURCE (red/green on top)", CGFloat(20)),
                           ("PRODUCTION GRAYSCALE (should match)", CGFloat(440))] {
            let label = NSTextField(labelWithString: title)
            label.textColor = .white
            label.frame = NSRect(x: x, y: 430, width: 400, height: 24)
            content.addSubview(label)
        }
        window.contentView = content
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        grayscaleView = grayscale
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.drawFrame() }
        }
    }

    private func drawFrame() {
        guard let renderer, let source, let grayscaleView,
              let drawable = grayscaleView.metalLayer.nextDrawable(),
              let buffer = renderer.makeCommandBuffer(),
              renderer.encode(source, to: drawable.texture, commandBuffer: buffer) else { return }
        buffer.present(drawable)
        buffer.commit()
    }

    private func makeSource() -> CVPixelBuffer? {
        var source: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, 4, 4, kCVPixelFormatType_32BGRA,
                                  attributes as CFDictionary, &source) == kCVReturnSuccess,
              let source else { return nil }
        let colors: [[UInt8]] = [
            [0, 0, 255, 255], [0, 255, 0, 255],
            [255, 0, 0, 255], [255, 255, 255, 255]
        ]
        CVPixelBufferLockBaseAddress(source, [])
        let base = CVPixelBufferGetBaseAddress(source)!
        let stride = CVPixelBufferGetBytesPerRow(source)
        for y in 0..<4 {
            for x in 0..<4 {
                let pixel = base.advanced(by: y * stride + x * 4).assumingMemoryBound(to: UInt8.self)
                let color = colors[(y / 2) * 2 + x / 2]
                for channel in 0..<4 { pixel[channel] = color[channel] }
            }
        }
        CVPixelBufferUnlockBaseAddress(source, [])
        return source
    }
}

@main
@MainActor
private enum OrientationFixture {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let fixture = Fixture()
        app.delegate = fixture
        app.run()
        withExtendedLifetime(fixture) {}
    }
}
