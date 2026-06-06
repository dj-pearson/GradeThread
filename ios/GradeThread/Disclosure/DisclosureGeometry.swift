import UIKit

/// Pure layout + color math for compositing an annotated defect photo. Kept
/// side-effect-free so the geometry is unit-tested without rendering pixels;
/// `DisclosureRenderer` consumes it. Mirrors the web `annotated-photo.tsx`.
enum DisclosureGeometry {
    /// Cap the composite's long edge so the legend text stays legible and the
    /// PNG stays small. Matches the web `MAX_CANVAS_W`.
    static let maxCanvasWidth: CGFloat = 900
    static let legendLineHeight: CGFloat = 26
    static let legendPadding: CGFloat = 14

    /// Photo draw size: scaled down to `maxCanvasWidth` (never up), aspect kept.
    static func canvasSize(imageSize: CGSize) -> CGSize {
        guard imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let width = min(imageSize.width, maxCanvasWidth)
        let scale = width / imageSize.width
        return CGSize(width: width, height: (imageSize.height * scale).rounded(.down))
    }

    /// Map a normalized `[x, y, w, h]` bbox into pixel space for `size`.
    /// Returns nil for a malformed bbox (caller treats it as legend-only).
    static func scaledRect(bbox: [Double], in size: CGSize) -> CGRect? {
        guard bbox.count == 4 else { return nil }
        return CGRect(
            x: CGFloat(bbox[0]) * size.width,
            y: CGFloat(bbox[1]) * size.height,
            width: CGFloat(bbox[2]) * size.width,
            height: CGFloat(bbox[3]) * size.height
        )
    }

    /// Height of the legend strip beneath the photo for `count` callouts.
    static func legendHeight(annotationCount count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return legendPadding * 2 + CGFloat(count) * legendLineHeight
    }

    /// Total composite size = photo + legend strip.
    static func compositeSize(imageSize: CGSize, annotationCount: Int) -> CGSize {
        let canvas = canvasSize(imageSize: imageSize)
        return CGSize(width: canvas.width, height: canvas.height + legendHeight(annotationCount: annotationCount))
    }
}

/// Severity → color, matching the web `SEVERITY_COLOR` (Vibrant Crimson / Amber
/// Gold / Yellow). Unknown severities fall back to the minor tone.
enum DisclosureSeverityColor {
    static func color(for severity: String) -> UIColor {
        switch severity.lowercased() {
        case "major":    return UIColor(red: 0.941, green: 0.239, blue: 0.373, alpha: 1) // #F03D5F
        case "moderate": return UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #F59E0B
        default:         return UIColor(red: 0.918, green: 0.702, blue: 0.031, alpha: 1) // #EAB308
        }
    }
}
