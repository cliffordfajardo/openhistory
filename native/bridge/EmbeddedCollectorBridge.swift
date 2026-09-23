import ActivityCore
import Foundation

public typealias OpenHistoryCollectorEventCallback = @convention(c) (
    UnsafePointer<CChar>?,
    UnsafeMutableRawPointer?
) -> Void

private struct EmbeddedCaptureConfiguration: Decodable {
    let captureWindowTitles: Bool
    let captureFocusedElements: Bool
    let captureTextInput: Bool
    let capturePointerClicks: Bool
    let captureBrowserURLs: Bool
    let captureDocumentContext: Bool
    let captureUISnapshots: Bool
    let captureEmailActivity: Bool
    let captureMessagingActivity: Bool
    let excludedBundleIdentifiers: [String]
    let excludedProcessIdentifiers: [Int32]

    var collectorConfiguration: CaptureConfiguration {
        CaptureConfiguration(
            windowTitles: captureWindowTitles,
            focusedElements: captureFocusedElements,
            textInput: captureTextInput,
            pointerClicks: capturePointerClicks,
            browserURLs: captureBrowserURLs,
            documentContext: captureDocumentContext,
            uiSnapshots: captureUISnapshots,
            emailActivity: captureEmailActivity,
            messagingActivity: captureMessagingActivity,
            excludedBundleIdentifiers: Set(excludedBundleIdentifiers),
            excludedProcessIdentifiers: Set(excludedProcessIdentifiers),
            emitHeartbeat: false
        )
    }
}

private final class EmbeddedEventSink: @unchecked Sendable {
    private let callback: OpenHistoryCollectorEventCallback
    private let context: UnsafeMutableRawPointer?

    init(
        callback: @escaping OpenHistoryCollectorEventCallback,
        context: UnsafeMutableRawPointer?
    ) {
        self.callback = callback
        self.context = context
    }

    func send(_ data: Data) {
        send(String(decoding: data, as: UTF8.self))
    }

    func send(_ line: String) {
        line.withCString { pointer in
            callback(pointer, context)
        }
    }
}

private final class EmbeddedCollectorHost: @unchecked Sendable {
    static let shared = EmbeddedCollectorHost()
    private var collector: ApplicationActivityCollector?
    private var foregroundGeneration: UInt64 = 0

    func start(
        dataDirectory: String,
        configurationJSON: String,
        callback: @escaping OpenHistoryCollectorEventCallback,
        context: UnsafeMutableRawPointer?
    ) throws {
        stop()
        let configuration = try JSONDecoder().decode(
            EmbeddedCaptureConfiguration.self,
            from: Data(configurationJSON.utf8)
        )
        let sink = EmbeddedEventSink(callback: callback, context: context)
        let writer = try EventWriter(
            directory: URL(fileURLWithPath: dataDirectory, isDirectory: true),
            emitToStandardOutput: false,
            eventHandler: { data in sink.send(data) }
        )
        let collector = ApplicationActivityCollector(
            writer: writer,
            configuration: configuration.collectorConfiguration
        )
        collector.foregroundEvidenceHandler = { evidence, sampledWindow in
            MainActor.assumeIsolated {
                FocusOverlayController.shared.foregroundEvidenceChanged(evidence, sampledWindow: sampledWindow)
            }
            if let packet = evidence.packet() { sink.send(packet) }
        }
        collector.pointerExclusion = { point in
            MainActor.assumeIsolated {
                FocusOverlayController.shared.recentlyContainsCardPoint(point) ||
                    FocusBarController.shared.containsPoint(point)
            }
        }
        self.collector = collector
        collector.start()
        collector.setForegroundObservation(generation: foregroundGeneration)
    }

    func setForegroundObservation(generation: UInt64) {
        foregroundGeneration = generation
        collector?.setForegroundObservation(generation: generation)
    }

    func stop() {
        collector?.stop()
        collector = nil
    }
}

@_cdecl("openhistory_collector_start")
public func openHistoryCollectorStart(
    _ dataDirectory: UnsafePointer<CChar>?,
    _ configurationJSON: UnsafePointer<CChar>?,
    _ callback: OpenHistoryCollectorEventCallback?,
    _ context: UnsafeMutableRawPointer?
) -> Int32 {
    guard Thread.isMainThread else { return 2 }
    guard let dataDirectory, let configurationJSON, let callback else { return 3 }
    do {
        try EmbeddedCollectorHost.shared.start(
            dataDirectory: String(cString: dataDirectory),
            configurationJSON: String(cString: configurationJSON),
            callback: callback,
            context: context
        )
        return 0
    } catch {
        FileHandle.standardError.write(Data("embedded collector startup failed: \(error)\n".utf8))
        EmbeddedCollectorHost.shared.stop()
        return 1
    }
}

@_cdecl("openhistory_collector_stop")
public func openHistoryCollectorStop() {
    guard Thread.isMainThread else { return }
    EmbeddedCollectorHost.shared.stop()
}

@_cdecl("openhistory_collector_set_foreground_observation")
public func openHistoryCollectorSetForegroundObservation(_ generation: UInt64) -> Int32 {
    guard Thread.isMainThread else { return 2 }
    EmbeddedCollectorHost.shared.setForegroundObservation(generation: generation)
    return 0
}
