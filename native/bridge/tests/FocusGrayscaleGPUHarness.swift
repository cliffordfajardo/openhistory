import AppKit
import CoreVideo
import Foundation
import Metal

@main
@MainActor
enum FocusGrayscaleGPUHarness {
    static func main() {
        guard let renderer = FocusGrayscaleRenderer() else {
            // 77 is the conventional test-suite skip exit code. The shell wrapper preserves it.
            fputs("SKIP: no Metal device\n", stderr)
            exit(77)
        }
        let width = 4
        let height = 4
        var source: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                  kCVPixelFormatType_32BGRA, attributes as CFDictionary,
                                  &source) == kCVReturnSuccess,
              let source else { fatalError("CVPixelBufferCreate failed") }

        // CVPixelBuffer row zero is the image top. Four distinct luma values expose flips.
        let colors: [[UInt8]] = [
            [0, 0, 255, 255],       // top-left red
            [0, 255, 0, 255],       // top-right green
            [255, 0, 0, 255],       // bottom-left blue
            [255, 255, 255, 255]   // bottom-right white
        ]
        CVPixelBufferLockBaseAddress(source, [])
        guard let base = CVPixelBufferGetBaseAddress(source) else { fatalError("No pixel buffer base") }
        let stride = CVPixelBufferGetBytesPerRow(source)
        for y in 0..<height {
            for x in 0..<width {
                let pixel = base.advanced(by: y * stride + x * 4).assumingMemoryBound(to: UInt8.self)
                let color = colors[(y / 2) * 2 + x / 2]
                for channel in 0..<4 { pixel[channel] = color[channel] }
            }
        }
        CVPixelBufferUnlockBaseAddress(source, [])

        verify(renderer: renderer, source: source, size: 4)
        verify(renderer: renderer, source: source, size: 8)
    }

    private static func verify(renderer: FocusGrayscaleRenderer, source: CVPixelBuffer, size: Int) {
        let view = FocusGrayscaleView(frame: NSRect(x: 0, y: 0, width: size, height: size),
                                      device: renderer.device, scale: 1)
        guard view.layer === view.metalLayer, !view.isFlipped,
              !view.metalLayer.isGeometryFlipped, !view.metalLayer.contentsAreFlipped() else {
            fatalError("Grayscale view presentation orientation changed; recheck displayed pixel mapping")
        }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: size, height: size, mipmapped: false
        )
        descriptor.usage = [.shaderRead, .shaderWrite, .renderTarget]
        descriptor.storageMode = renderer.device.hasUnifiedMemory ? .shared : .managed
        guard let destination = renderer.device.makeTexture(descriptor: descriptor),
              let buffer = renderer.makeCommandBuffer(),
              renderer.encode(source, to: destination, commandBuffer: buffer) else {
            fatalError("Renderer could not encode synthetic frame")
        }
        buffer.commit()
        buffer.waitUntilCompleted()
        guard buffer.status == .completed else { fatalError("GPU command failed: \(String(describing: buffer.error))") }
        if descriptor.storageMode == .managed {
            guard let readback = renderer.makeCommandBuffer(),
                  let blit = readback.makeBlitCommandEncoder() else {
                fatalError("Could not synchronize managed texture")
            }
            blit.synchronize(resource: destination)
            blit.endEncoding()
            readback.commit()
            readback.waitUntilCompleted()
            guard readback.status == .completed else { fatalError("Managed texture readback failed") }
        }

        var output = [UInt8](repeating: 0, count: size * size * 4)
        output.withUnsafeMutableBytes { bytes in
            destination.getBytes(bytes.baseAddress!, bytesPerRow: size * 4,
                                 from: MTLRegionMake2D(0, 0, size, size), mipmapLevel: 0)
        }
        func sampleDisplayed(_ x: Int, _ yFromTop: Int) -> [Int] {
            // This AppKit CAMetalLayer presents texture row zero at the bottom of the view.
            // The visual fixture verifies that convention using an actual drawable.
            let textureRow = size - 1 - yFromTop
            let offset = (textureRow * size + x) * 4
            return (0..<4).map { Int(output[offset + $0]) }
        }
        let topLeft = sampleDisplayed(0, 0), topRight = sampleDisplayed(size - 1, 0)
        let bottomLeft = sampleDisplayed(0, size - 1), bottomRight = sampleDisplayed(size - 1, size - 1)
        let samples = [topLeft, topRight, bottomLeft, bottomRight]
        for (index, pixel) in samples.enumerated() {
            guard abs(pixel[0] - pixel[1]) <= 3, abs(pixel[1] - pixel[2]) <= 3,
                  pixel[3] >= 250 else {
                fatalError("Sample \(index) is not opaque gray: \(pixel)")
            }
        }
        // Relative brightness survives color-space conversion and distinguishes all quadrants.
        guard bottomLeft[0] < topLeft[0], topLeft[0] < topRight[0],
              topRight[0] < bottomRight[0] else {
            fatalError("Orientation/order wrong: TL=\(topLeft), TR=\(topRight), BL=\(bottomLeft), BR=\(bottomRight)")
        }
        print("PASS \(size)x\(size) grayscale and orientation: TL=\(topLeft), TR=\(topRight), BL=\(bottomLeft), BR=\(bottomRight)")
    }
}
