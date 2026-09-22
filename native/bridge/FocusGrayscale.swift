import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreMedia
import CoreVideo
import Metal
import QuartzCore
@preconcurrency import ScreenCaptureKit

enum FocusGrayscaleFailure: String {
    case permissionNeeded = "permission_needed"
    case unsupported
    case captureFailed = "capture_failed"
    case noFrame = "no_frame"
    case displayUnavailable = "display_unavailable"
    case windowUnavailable = "window_unavailable"
    case windowSpansDisplays = "window_spans_displays"
}

enum FocusGrayscaleEvent {
    case active
    case failed(FocusGrayscaleFailure)
    case foregroundChanged
}

enum FocusGrayscaleTiming {
    static let framesPerSecond: Int32 = 30
    static let firstFrameTimeout: Duration = .seconds(4)
    static let fadeDuration: TimeInterval = 0.25
    /// Quiet period after a window moves or resizes before its new bounds are captured.
    static let windowSettleDelay: Duration = .milliseconds(200)
    /// Longest wait for foreground evidence that confirms a window before using the amber edge.
    static let windowConfirmationTimeout: Duration = .seconds(2)
}

/// Part of one display to capture and cover, instead of the whole display.
struct FocusGrayscaleRegion: Equatable {
    /// Display-local capture rectangle in points, top-left origin, aligned to display pixels.
    let sourceRect: CGRect
    /// The same rectangle in global AppKit coordinates.
    let panelFrame: NSRect
    let pixelWidth: Int
    let pixelHeight: Int
}

final class FocusGrayscaleRenderer: @unchecked Sendable {
    let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let context: CIContext
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let commandQueue = device.makeCommandQueue() else {
            return nil
        }
        self.device = device
        self.commandQueue = commandQueue
        context = CIContext(mtlCommandQueue: commandQueue, options: [
            .cacheIntermediates: false,
            .name: "OpenHistory Focus grayscale"
        ])
    }

    func makeCommandBuffer() -> MTLCommandBuffer? {
        commandQueue.makeCommandBuffer()
    }

    func encode(_ pixelBuffer: CVPixelBuffer, to texture: MTLTexture, commandBuffer: MTLCommandBuffer) -> Bool {
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        let filter = CIFilter.colorControls()
        filter.saturation = 0
        filter.brightness = 0
        filter.contrast = 1
        filter.inputImage = source
        guard var image = filter.outputImage, source.extent.width > 0, source.extent.height > 0 else { return false }
        let width = CGFloat(texture.width)
        let height = CGFloat(texture.height)
        if source.extent.width != width || source.extent.height != height {
            image = image.transformed(by: CGAffineTransform(
                scaleX: width / source.extent.width,
                y: height / source.extent.height
            ))
        }
        let destination = CIRenderDestination(mtlTexture: texture, commandBuffer: commandBuffer)
        destination.colorSpace = colorSpace
        do {
            try context.startTask(toRender: image, to: destination)
            return true
        } catch {
            return false
        }
    }
}

final class FocusGrayscaleView: NSView {
    let metalLayer = CAMetalLayer()

    init(frame frameRect: NSRect, device: MTLDevice, scale: CGFloat) {
        super.init(frame: frameRect)
        metalLayer.device = device
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = false
        metalLayer.isOpaque = true
        metalLayer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        metalLayer.contentsGravity = .resize
        metalLayer.contentsScale = scale
        metalLayer.backgroundColor = CGColor(gray: 0, alpha: 1)
        layer = metalLayer
        wantsLayer = true
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { nil }

    override var isOpaque: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class FocusGrayscaleFrameSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private struct RetainedFrame: @unchecked Sendable {
        let pixelBuffer: CVPixelBuffer
    }

    let queue = DispatchQueue(label: "io.github.cliffordfajardo.openhistory-focus.grayscale", qos: .userInteractive)
    private let renderer: FocusGrayscaleRenderer
    private let lock = NSLock()
    private var layer: CAMetalLayer?
    private var firstFrameRendered = false
    private let onFirstFrame: @Sendable () -> Void
    private let onStop: @Sendable () -> Void

    init(
        renderer: FocusGrayscaleRenderer,
        layer: CAMetalLayer,
        onFirstFrame: @escaping @Sendable () -> Void,
        onStop: @escaping @Sendable () -> Void
    ) {
        self.renderer = renderer
        self.layer = layer
        self.onFirstFrame = onFirstFrame
        self.onStop = onStop
    }

    func invalidate() {
        lock.lock()
        layer = nil
        lock.unlock()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, Self.isComplete(sampleBuffer),
              let pixelBuffer = sampleBuffer.imageBuffer else { return }
        lock.lock()
        let target = layer
        lock.unlock()
        guard let target, let drawable = target.nextDrawable(),
              let commandBuffer = renderer.makeCommandBuffer(),
              renderer.encode(pixelBuffer, to: drawable.texture, commandBuffer: commandBuffer) else { return }
        commandBuffer.present(drawable)
        let onFirstFrame = onFirstFrame
        let retainedFrame = RetainedFrame(pixelBuffer: pixelBuffer)
        commandBuffer.addCompletedHandler { [self] buffer in
            // The capture buffer must outlive GPU reads; failed GPU work cannot claim the first frame.
            withExtendedLifetime(retainedFrame) {}
            guard buffer.status == .completed else { return }
            lock.lock()
            let reportFirstFrame = !firstFrameRendered
            firstFrameRendered = true
            lock.unlock()
            if reportFirstFrame { onFirstFrame() }
        }
        commandBuffer.commit()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop()
    }

    private static func isComplete(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus) else { return false }
        return status == .complete
    }
}

@MainActor
final class FocusGrayscaleController {
    static let shared = FocusGrayscaleController()

    @MainActor
    private final class Presentation {
        let generation: UInt64
        let expectedProcessIdentifier: pid_t?
        let displayID: CGDirectDisplayID
        let screenFrame: NSRect
        let scale: CGFloat
        let region: FocusGrayscaleRegion?
        let panel: FocusOverlayPanel
        let view: FocusGrayscaleView
        let sink: FocusGrayscaleFrameSink
        let onEvent: @MainActor (FocusGrayscaleEvent) -> Void
        var stream: SCStream?
        var streamStartInProgress = false
        var streamDidStart = false
        var streamShutdownStarted = false
        var setup: Task<Void, Never>?
        var timeout: Task<Void, Never>?
        var frameRendered = false
        var suppressed: Bool
        var reportedActive = false

        init(
            generation: UInt64,
            expectedProcessIdentifier: pid_t?,
            displayID: CGDirectDisplayID,
            screen: NSScreen,
            region: FocusGrayscaleRegion?,
            suppressed: Bool,
            panel: FocusOverlayPanel,
            view: FocusGrayscaleView,
            sink: FocusGrayscaleFrameSink,
            onEvent: @escaping @MainActor (FocusGrayscaleEvent) -> Void
        ) {
            self.generation = generation
            self.expectedProcessIdentifier = expectedProcessIdentifier
            self.displayID = displayID
            screenFrame = screen.frame
            scale = screen.backingScaleFactor
            self.region = region
            self.suppressed = suppressed
            self.panel = panel
            self.view = view
            self.sink = sink
            self.onEvent = onEvent
        }
    }

    private lazy var renderer: FocusGrayscaleRenderer? = FocusGrayscaleRenderer()
    private var generation: UInt64 = 0
    private var presentation: Presentation?
    private var latestSetup: Task<Void, Never>?
    private var latestShutdown: Task<Void, Never>?

    /// Starts capture of `screen`, or of `region` on it. A suppressed presentation captures but
    /// stays hidden until `setSuppressed(false)`.
    func start(
        screen: NSScreen,
        displayID: CGDirectDisplayID,
        expectedProcessIdentifier: pid_t?,
        region: FocusGrayscaleRegion? = nil,
        suppressed: Bool = false,
        onEvent: @escaping @MainActor (FocusGrayscaleEvent) -> Void
    ) -> FocusGrayscaleFailure? {
        stop()
        guard CGPreflightScreenCaptureAccess() else { return .permissionNeeded }
        guard let renderer else { return .unsupported }

        generation &+= 1
        let current = generation
        let frame = region?.panelFrame ?? screen.frame
        let panel = FocusOverlayPanel(clickThrough: true, levelOffset: 0)
        let view = FocusGrayscaleView(
            frame: NSRect(origin: .zero, size: frame.size),
            device: renderer.device,
            scale: screen.backingScaleFactor
        )
        panel.contentView = view
        panel.setAccessibilityElement(false)
        panel.setFrame(frame, display: false)
        let sink = FocusGrayscaleFrameSink(
            renderer: renderer,
            layer: view.metalLayer,
            onFirstFrame: {
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { FocusGrayscaleController.shared.firstFrameRendered(current) }
                }
            },
            onStop: {
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { FocusGrayscaleController.shared.streamStopped(current) }
                }
            }
        )
        let presentation = Presentation(
            generation: current,
            expectedProcessIdentifier: expectedProcessIdentifier,
            displayID: displayID,
            screen: screen,
            region: region,
            suppressed: suppressed,
            panel: panel,
            view: view,
            sink: sink,
            onEvent: onEvent
        )
        self.presentation = presentation
        presentation.timeout = Task { @MainActor in
            try? await Task.sleep(for: FocusGrayscaleTiming.firstFrameTimeout)
            FocusGrayscaleController.shared.firstFrameTimedOut(current)
        }
        let previousSetup = latestSetup
        let setup = Task { @MainActor in
            await previousSetup?.value
            await FocusGrayscaleController.shared.latestShutdown?.value
            guard FocusGrayscaleController.shared.current(current) != nil else { return }
            await FocusGrayscaleController.shared.beginCapture(current)
        }
        presentation.setup = setup
        latestSetup = setup
        return nil
    }

    func stop() {
        guard let presentation else { return }
        self.presentation = nil
        generation &+= 1
        presentation.sink.invalidate()
        presentation.timeout?.cancel()
        presentation.setup?.cancel()
        presentation.panel.alphaValue = 0
        presentation.panel.orderOut(nil)
        presentation.panel.contentView = nil
        presentation.panel.close()
        shutdownStream(presentation)
    }

    private func shutdownStream(_ presentation: Presentation) {
        guard !presentation.streamStartInProgress, !presentation.streamShutdownStarted,
              let stream = presentation.stream else { return }
        presentation.streamShutdownStarted = true
        presentation.stream = nil
        let didStart = presentation.streamDidStart
        let sink = presentation.sink
        latestShutdown = Task {
            if didStart { try? await stream.stopCapture() }
            try? stream.removeStreamOutput(sink, type: .screen)
        }
    }

    /// Hides a presentation's image at once, or shows it again once a frame has been rendered.
    func setSuppressed(_ suppressed: Bool) {
        guard let presentation, presentation.suppressed != suppressed else { return }
        presentation.suppressed = suppressed
        if suppressed {
            let panel = presentation.panel
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                panel.animator().alphaValue = 0
            }
            panel.alphaValue = 0
        } else {
            reveal(presentation)
        }
    }

    func displayChanged(to screen: NSScreen?) {
        guard let presentation else { return }
        guard presentation.region == nil else {
            setSuppressed(true)
            return
        }
        guard let screen, screen.frame.size == presentation.screenFrame.size,
              screen.backingScaleFactor == presentation.scale else {
            fail(presentation.generation, .displayUnavailable)
            return
        }
        presentation.panel.setFrame(screen.frame, display: false)
    }

    private func current(_ generation: UInt64) -> Presentation? {
        guard let presentation, presentation.generation == generation, self.generation == generation else {
            return nil
        }
        return presentation
    }

    private func beginCapture(_ generation: UInt64) async {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            fail(generation, CGPreflightScreenCaptureAccess() ? .captureFailed : .permissionNeeded)
            return
        }
        guard let presentation = current(generation) else { return }
        guard let display = content.displays.first(where: { $0.displayID == presentation.displayID }) else {
            fail(generation, .displayUnavailable)
            return
        }
        guard let filter = Self.contentFilter(display: display, content: content) else {
            fail(generation, .captureFailed)
            return
        }

        let scale = CGFloat(filter.pointPixelScale)
        var width = Int((filter.contentRect.width * scale).rounded())
        var height = Int((filter.contentRect.height * scale).rounded())
        guard width > 0, height > 0 else {
            fail(generation, .displayUnavailable)
            return
        }
        let configuration = SCStreamConfiguration()
        if let region = presentation.region {
            let displayRect = CGRect(origin: .zero, size: filter.contentRect.size)
            guard abs(scale - presentation.scale) < 0.01,
                  displayRect.insetBy(dx: -0.5, dy: -0.5).contains(region.sourceRect) else {
                fail(generation, .windowUnavailable)
                return
            }
            configuration.sourceRect = region.sourceRect
            width = region.pixelWidth
            height = region.pixelHeight
        }
        configuration.width = width
        configuration.height = height
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: FocusGrayscaleTiming.framesPerSecond)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        presentation.view.metalLayer.drawableSize = CGSize(width: width, height: height)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: presentation.sink)
        do {
            try stream.addStreamOutput(presentation.sink, type: .screen, sampleHandlerQueue: presentation.sink.queue)
        } catch {
            fail(generation, .captureFailed)
            return
        }
        presentation.stream = stream
        // Register capture exclusion before ordering the layer-backed panel on screen.
        presentation.panel.alphaValue = 0
        presentation.panel.orderFrontRegardless()
        presentation.streamStartInProgress = true
        do {
            try await stream.startCapture()
        } catch {
            presentation.streamStartInProgress = false
            // A failed start may still have opened capture before reporting its error.
            presentation.streamDidStart = true
            shutdownStream(presentation)
            fail(generation, CGPreflightScreenCaptureAccess() ? .captureFailed : .permissionNeeded)
            return
        }
        presentation.streamStartInProgress = false
        presentation.streamDidStart = true
        if current(generation) == nil {
            shutdownStream(presentation)
        }
    }

    /// Exclude this app's overlay panels while retaining its normal visible windows.
    private static func contentFilter(display: SCDisplay, content: SCShareableContent) -> SCContentFilter? {
        let processIdentifier = ProcessInfo.processInfo.processIdentifier
        guard let application = content.applications.first(where: { $0.processID == processIdentifier }) else {
            return nil
        }
        let hostWindowNumbers = Set(NSApp.windows.compactMap { window -> CGWindowID? in
            guard !(window is FocusOverlayPanel), window.isVisible, window.windowNumber > 0 else { return nil }
            return CGWindowID(window.windowNumber)
        })
        let hostWindows = content.windows.filter {
            $0.owningApplication?.processID == processIdentifier && hostWindowNumbers.contains($0.windowID)
        }
        return SCContentFilter(display: display, excludingApplications: [application], exceptingWindows: hostWindows)
    }

    private func firstFrameRendered(_ generation: UInt64) {
        guard let presentation = current(generation), !presentation.frameRendered else { return }
        if let expected = presentation.expectedProcessIdentifier,
           NSWorkspace.shared.frontmostApplication?.processIdentifier != expected {
            presentation.onEvent(.foregroundChanged)
            return
        }
        presentation.frameRendered = true
        presentation.timeout?.cancel()
        reveal(presentation)
    }

    private func reveal(_ presentation: Presentation) {
        guard presentation.frameRendered, !presentation.suppressed,
              current(presentation.generation) === presentation else { return }
        let panel = presentation.panel
        let reduceMotion = FocusOverlayAppearance.current.reduceMotion
        panel.alphaValue = reduceMotion ? 1 : 0
        panel.orderFrontRegardless()
        if !reduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = FocusGrayscaleTiming.fadeDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                panel.animator().alphaValue = 1
            }
        }
        guard !presentation.reportedActive else { return }
        presentation.reportedActive = true
        presentation.onEvent(.active)
    }

    private func firstFrameTimedOut(_ generation: UInt64) {
        guard let presentation = current(generation), !presentation.frameRendered else { return }
        fail(generation, .noFrame)
    }

    private func streamStopped(_ generation: UInt64) {
        guard current(generation) != nil else { return }
        fail(generation, CGPreflightScreenCaptureAccess() ? .captureFailed : .permissionNeeded)
    }

    private func fail(_ generation: UInt64, _ reason: FocusGrayscaleFailure) {
        guard let presentation = current(generation) else { return }
        stop()
        presentation.onEvent(.failed(reason))
    }
}
