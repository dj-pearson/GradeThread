import CoreGraphics
import Foundation

/// US-1575: pure math for the measurement overlay editor — the Swift port of
/// the web's `src/lib/measure-editor-math.ts` (which is the spec; the vitest
/// suite there and `MeasureGeometryTests` here assert the same cases so the
/// platforms cannot drift). The homography maps ORIGINAL image pixels onto
/// the MeasureCard's inch plane (US-1572 calibration, fetched from the
/// server — iOS never re-implements detection).
enum MeasureGeometry {
    /// One draggable measurement line, endpoints in ORIGINAL image pixels.
    struct Line: Equatable, Identifiable {
        let key: String
        let label: String
        var e1: CGPoint
        var e2: CGPoint
        var id: String { key }
    }

    enum End {
        case e1
        case e2
    }

    /// Apply a row-major 3x3 homography.
    static func applyHomography(_ h: [Double], x: Double, y: Double) -> CGPoint {
        guard h.count == 9 else { return CGPoint(x: x, y: y) }
        let w = h[6] * x + h[7] * y + h[8]
        guard w != 0 else { return CGPoint(x: x, y: y) }
        return CGPoint(
            x: (h[0] * x + h[1] * y + h[2]) / w,
            y: (h[3] * x + h[4] * y + h[5]) / w
        )
    }

    static func roundQuarterInch(_ v: Double) -> Double {
        (v * 4).rounded() / 4
    }

    /// Card-plane inches between two ORIGINAL-px endpoints, 0.25in steps.
    static func inchesBetween(_ h: [Double], _ a: CGPoint, _ b: CGPoint) -> Double {
        let pa = applyHomography(h, x: a.x, y: a.y)
        let pb = applyHomography(h, x: b.x, y: b.y)
        return roundQuarterInch(hypot(pa.x - pb.x, pa.y - pb.y))
    }

    /// `22.25` -> `22 1/4` (ASCII fractions; label text stays glyph-safe).
    static func formatQuarter(_ v: Double) -> String {
        let whole = Int(v.rounded(.down))
        let frac = Int(((v - Double(whole)) * 4).rounded())
        let fracs = ["", "1/4", "1/2", "3/4"]
        guard frac > 0, frac < 4 else { return String(whole) }
        return whole == 0 ? fracs[frac] : "\(whole) \(fracs[frac])"
    }

    /// Uniform display scale fitting the image inside maxW x maxH (never >1).
    static func fitScale(imgW: Double, imgH: Double, maxW: Double, maxH: Double) -> Double {
        guard imgW > 0, imgH > 0 else { return 1 }
        return min(1, min(maxW / imgW, maxH / imgH))
    }

    /// Which endpoint (if any) a DISPLAY-space touch grabs. Radius in display
    /// points — wider than the web default because fingers beat cursors.
    static func hitEndpoint(
        lines: [Line],
        displayPoint p: CGPoint,
        scale: Double,
        radius: Double = 24
    ) -> (index: Int, end: End)? {
        var best: (index: Int, end: End)?
        var bestD = radius
        for (index, line) in lines.enumerated() {
            for end in [End.e1, End.e2] {
                let pt = end == .e1 ? line.e1 : line.e2
                let d = hypot(pt.x * scale - p.x, pt.y * scale - p.y)
                if d <= bestD {
                    bestD = d
                    best = (index, end)
                }
            }
        }
        return best
    }

    /// Keys that read as vertical measurements on a flat-lay (mirrors the web).
    private static let verticalKeys: Set<String> = [
        "length", "inseam", "rise", "sleeve", "insole",
    ]

    /// Starting line for a measurement the auto pass didn't place — centered,
    /// 40% of the image span, along the key's natural axis.
    static func defaultPlacement(key: String, imgW: Double, imgH: Double) -> (e1: CGPoint, e2: CGPoint) {
        let cx = imgW / 2
        let cy = imgH / 2
        if verticalKeys.contains(key) {
            let span = imgH * 0.4
            return (CGPoint(x: cx, y: cy - span / 2), CGPoint(x: cx, y: cy + span / 2))
        }
        let span = imgW * 0.4
        return (CGPoint(x: cx - span / 2, y: cy), CGPoint(x: cx + span / 2, y: cy))
    }
}
