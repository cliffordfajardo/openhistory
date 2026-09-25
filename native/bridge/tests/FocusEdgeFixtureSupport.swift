import AppKit

struct Pixel: CustomStringConvertible {
    let red: Double
    let green: Double
    let blue: Double
    let alpha: Double
    var description: String { String(format: "rgba(%.3f, %.3f, %.3f, %.3f)", red, green, blue, alpha) }
    func near(_ rgb: (Double, Double, Double), tolerance: Double = 0.025) -> Bool {
        abs(red - rgb.0) <= tolerance && abs(green - rgb.1) <= tolerance && abs(blue - rgb.2) <= tolerance
    }
}

@MainActor enum GlowBitmap {
    // Calls the production drawing method, not a replica or stored-color inspection.
    static func render(_ view: FocusGlowView, at points: [CGPoint]) -> [Pixel] {
        let width = Int(view.bounds.width), height = Int(view.bounds.height)
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        context.clear(view.bounds)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        view.draw(view.bounds)
        NSGraphicsContext.restoreGraphicsState()
        let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
        return points.map { point in
            let offset = (Int(point.y) * width + Int(point.x)) * 4
            let alpha = Double(bytes[offset + 3]) / 255
            let divisor = alpha > 0 ? 255 * alpha : 255
            return Pixel(red: Double(bytes[offset]) / divisor, green: Double(bytes[offset + 1]) / divisor,
                         blue: Double(bytes[offset + 2]) / divisor, alpha: alpha)
        }
    }
}

struct FocusIdentity: Equatable, CustomStringConvertible {
    let foreground: pid_t?
    let key: ObjectIdentifier?
    let main: ObjectIdentifier?
    let responder: ObjectIdentifier?
    @MainActor init() {
        foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        key = NSApp.keyWindow.map(ObjectIdentifier.init)
        main = NSApp.mainWindow.map(ObjectIdentifier.init)
        responder = NSApp.keyWindow?.firstResponder.map(ObjectIdentifier.init)
    }
    var description: String { "foreground=\(String(describing: foreground)), key=\(String(describing: key)), main=\(String(describing: main)), responder=\(String(describing: responder))" }
}

@MainActor final class Checks {
    private(set) var failures = 0
    func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        let passed = condition()
        if !passed { failures += 1 }
        print("\(passed ? "ok  " : "FAIL") \(label)")
    }
    func wait(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    func panels() -> [FocusOverlayPanel] { NSApp.windows.compactMap { $0 as? FocusOverlayPanel } }
    func glowPanels() -> [FocusOverlayPanel] { panels().filter { $0.contentView is FocusGlowView } }
    func cardPanels() -> [FocusOverlayPanel] { panels().filter { $0.contentView is FocusCardView } }
}
