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

    /// What a touch grabbed: one END of a line, or the LINE ITSELF.
    ///
    /// US-2889 AC3. Until now the only gesture that moved anything was dragging
    /// an endpoint, which resizes. A seller who has the right length in the
    /// wrong place had to drag both ends and try to keep them the same distance
    /// apart, by eye - so a measurement got worse every time it was
    /// repositioned.
    enum Grab: Equatable {
        case end(index: Int, end: End)
        case line(index: Int)
    }

    /// Which line BODY (if any) a display-space touch grabs.
    ///
    /// Endpoints win: 'hitTest(lines:displayPoint:scale:)' asks for an
    /// endpoint first, and only falls back to the body. A body hit that beat an
    /// endpoint would make the endpoints of a short line unreachable, since on
    /// a line barely longer than the touch radius every point is near an end.
    static func hitLineBody(
        lines: [Line],
        displayPoint p: CGPoint,
        scale: Double,
        radius: Double = 20
    ) -> Int? {
        var best: Int?
        var bestD = radius
        for (index, line) in lines.enumerated() {
            let a = CGPoint(x: line.e1.x * scale, y: line.e1.y * scale)
            let b = CGPoint(x: line.e2.x * scale, y: line.e2.y * scale)
            let d = distanceToSegment(p, a, b).distance
            if d <= bestD {
                bestD = d
                best = index
            }
        }
        return best
    }

    /// Endpoint first, then line body. The one entry point the canvas uses.
    static func hitTest(
        lines: [Line],
        displayPoint p: CGPoint,
        scale: Double
    ) -> Grab? {
        if let e = hitEndpoint(lines: lines, displayPoint: p, scale: scale) {
            return .end(index: e.index, end: e.end)
        }
        if let i = hitLineBody(lines: lines, displayPoint: p, scale: scale) {
            return .line(index: i)
        }
        return nil
    }

    /// Distance from a DISPLAY-space point to the body of a segment, plus how
    /// far along the segment the foot of the perpendicular sits (0..1).
    ///
    /// The parameter is returned because a caller wants to refuse a hit that
    /// is really on an endpoint. Mirrors the web's distanceToSegment, which
    /// returns the same pair.
    static func distanceToSegment(
        _ p: CGPoint,
        _ a: CGPoint,
        _ b: CGPoint
    ) -> (distance: Double, t: Double) {
        let vx = b.x - a.x
        let vy = b.y - a.y
        let len2 = vx * vx + vy * vy
        // A degenerate segment is a point. Falling through would divide by zero.
        guard len2 > 0 else { return (hypot(p.x - a.x, p.y - a.y), 0) }
        var s = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
        s = min(max(0, s), 1)
        return (hypot(p.x - (a.x + s * vx), p.y - (a.y + s * vy)), s)
    }

    /// Slide a line by (dx, dy) as ONE object.
    ///
    /// The TRANSLATION is clamped, never the endpoints. Clamping each endpoint
    /// on its own is what turns a drag near the edge into a shortened,
    /// re-angled line - the measurement changes while the seller is only
    /// trying to reposition it.
    ///
    /// AND THE CLAMP IS SKIPPED WHEN THE WINDOW IS EMPTY. A segment longer
    /// than the frame along an axis has no delta that leaves it wholly inside,
    /// and clamping into an empty range would FREEZE the line - the same dead
    /// end as the off-screen endpoint this whole story exists to fix. Such a
    /// line moves freely and recenteredIntoFrame is the thing that shrinks it.
    /// This mirrors the web's translateLine exactly; an earlier draft of this
    /// function clamped unconditionally and would have diverged.
    static func translateLine(
        _ line: Line,
        dx: Double,
        dy: Double,
        imgW: Double,
        imgH: Double
    ) -> Line {
        let minX = min(line.e1.x, line.e2.x)
        let maxX = max(line.e1.x, line.e2.x)
        let minY = min(line.e1.y, line.e2.y)
        let maxY = max(line.e1.y, line.e2.y)
        let lowX = -minX
        let highX = imgW - maxX
        let lowY = -minY
        let highY = imgH - maxY
        let cdx = lowX <= highX ? max(lowX, min(highX, dx)) : dx
        let cdy = lowY <= highY ? max(lowY, min(highY, dy)) : dy
        var out = line
        out.e1 = CGPoint(x: line.e1.x + cdx, y: line.e1.y + cdy)
        out.e2 = CGPoint(x: line.e2.x + cdx, y: line.e2.y + cdy)
        return out
    }

    /// Are both endpoints inside the frame?
    static func lineWithinBounds(_ line: Line, imgW: Double, imgH: Double) -> Bool {
        [line.e1, line.e2].allSatisfy {
            $0.x >= 0 && $0.y >= 0 && $0.x <= imgW && $0.y <= imgH
        }
    }

    /// Pull a line that is partly or wholly outside the image back into view,
    /// keeping its length and angle where it can.
    ///
    /// US-2889 AC4. This is how a line written before the calibration carry
    /// existed is recovered: a portrait-to-landscape turn left endpoints past
    /// the new edge, where the editor draws them off screen and neither a drag
    /// nor a nudge can reach them, because both need the endpoint visible.
    ///
    /// Translation FIRST, because that is the answer that changes no
    /// measurement. Only a line too long to fit is shrunk, and then about its
    /// own midpoint so it stays on the same landmark. Mirrors the web's
    /// recenterLine step for step.
    static func recenteredIntoFrame(_ line: Line, imgW: Double, imgH: Double) -> Line {
        // A zero delta still clamps a segment that STARTED outside the frame,
        // because the allowed range collapses onto the offending edge.
        var slid = translateLine(line, dx: 0, dy: 0, imgW: imgW, imgH: imgH)
        let spanX = abs(slid.e1.x - slid.e2.x)
        let spanY = abs(slid.e1.y - slid.e2.y)
        let shrink = min(
            1,
            min(spanX > imgW ? imgW / spanX : 1, spanY > imgH ? imgH / spanY : 1)
        )
        if shrink < 1 {
            let mx = (slid.e1.x + slid.e2.x) / 2
            let my = (slid.e1.y + slid.e2.y) / 2
            slid.e1 = CGPoint(
                x: mx + (slid.e1.x - mx) * shrink,
                y: my + (slid.e1.y - my) * shrink
            )
            slid.e2 = CGPoint(
                x: mx + (slid.e2.x - mx) * shrink,
                y: my + (slid.e2.y - my) * shrink
            )
            slid = translateLine(slid, dx: 0, dy: 0, imgW: imgW, imgH: imgH)
        }
        return slid
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
