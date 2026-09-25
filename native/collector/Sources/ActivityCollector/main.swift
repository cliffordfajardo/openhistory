import ActivityCore
import Foundation

let defaultDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/OpenHistory Focus/activity-data", isDirectory: true)
let configuredDirectory = ProcessInfo.processInfo.environment["OPENHISTORY_FOCUS_DATA_DIR"]
    .map { URL(fileURLWithPath: $0, isDirectory: true) }
let dataDirectory = configuredDirectory ?? defaultDirectory

do {
    let writer = try EventWriter(directory: dataDirectory)
    let collector = ApplicationActivityCollector(writer: writer)
    collector.start()
    RunLoop.main.run()
} catch {
    FileHandle.standardError.write(Data("collector startup failed: \(error)\n".utf8))
    exit(EXIT_FAILURE)
}
