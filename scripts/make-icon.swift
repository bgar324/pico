import AppKit
import Foundation

// Render exact pixel sizes without depending on the display's Retina scale.
let destination = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/Pico.iconset"
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
let sourceURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("assets/Pico-source.png")
guard let artwork = NSImage(contentsOf: sourceURL) else {
    fatalError("Cannot load icon artwork at \(sourceURL.path)")
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            fatalError("Icon bitmap creation failed")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let side = Double(pixels)
        let tile = NSRect(x: side * 0.08, y: side * 0.08, width: side * 0.84, height: side * 0.84)
        NSBezierPath(roundedRect: tile, xRadius: side * 0.185, yRadius: side * 0.185).addClip()
        context.imageInterpolation = .high
        artwork.draw(in: tile, from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Icon rendering failed") }
        let suffix = scale == 2 ? "@2x" : ""
        try png.write(to: URL(fileURLWithPath: destination).appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
