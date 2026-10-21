import AppKit
import Foundation

// Render exact pixel sizes without depending on the display's Retina scale.
let destination = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/Pico.iconset"
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
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
        NSColor(srgbRed: 24.0 / 255, green: 24.0 / 255, blue: 24.0 / 255, alpha: 1).setFill()
        let tile = NSRect(x: side * 0.08, y: side * 0.08, width: side * 0.84, height: side * 0.84)
        NSBezierPath(roundedRect: tile, xRadius: side * 0.185, yRadius: side * 0.185).fill()

        // The reference's square-ended pi: nine units wide, ten units tall.
        // Its right leg extends farther down than its left leg.
        let unit = side / 18
        let origin = NSPoint(x: side * 0.25, y: side * 0.5 + unit * 5)
        NSColor(srgbRed: 56.0 / 255, green: 56.0 / 255, blue: 56.0 / 255, alpha: 1).setFill()
        let mark = NSBezierPath()
        for (x, y, width, height) in [(0.0, 0.0, 9.0, 2.0), (1.0, 2.0, 2.0, 5.5), (4.5, 2.0, 2.0, 8.0)] {
            mark.appendRect(NSRect(x: origin.x + x * unit, y: origin.y - (y + height) * unit, width: width * unit, height: height * unit))
        }
        mark.fill()
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Icon rendering failed") }
        let suffix = scale == 2 ? "@2x" : ""
        try png.write(to: URL(fileURLWithPath: destination).appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
