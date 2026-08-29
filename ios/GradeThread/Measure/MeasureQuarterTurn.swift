import CoreGraphics
import Foundation

/// US-2889: what happens to a MeasureCard calibration when the photo it was
/// measured on is rotated.
///
/// `item_photos.measure_calibration` holds two things and both are expressed in
/// the pixel coordinates of the stored image: a homography (image px -> card
/// plane inches) and the endpoints of every measurement line.
/// ``PhotoRotateService`` rewrites those pixels and used to touch neither. The
/// homography then measured along the wrong axis, and an endpoint at x=3000 in
/// a picture now 2000 wide drew past the edge of the frame - present,
/// saveable, and impossible to reach, because the iOS editor moves an endpoint
/// by dragging it or nudging it and both need it on screen.
///
/// A quarter turn is a rigid motion, so nothing has to be re-detected: inches
/// are preserved and both halves of the calibration carry across exactly. That
/// is the whole idea. Anything that is NOT a quarter turn resamples the frame,
/// and the caller clears the calibration rather than guessing.
///
/// PARITY IS ASSERTED AGAINST NUMBERS, NOT AGAINST TEXT. The browser and the
/// edge hold the same math in TypeScript and US-2890 compares their SOURCE,
/// which cannot work across languages. Instead
/// `assets/measure-card/quarter-turn-cases.json` is generated from the browser
/// implementation and `MeasureQuarterTurnTests` replays every case here. A sign
/// error in this file is a mirrored measurement rather than a crash, which is
/// exactly the kind of bug a shared fixture catches and a code review does not.
enum MeasureQuarterTurn {

    /// Clockwise quarter turns. 1 = 90 degrees clockwise, matching the editor's
    /// rotate button and the web's `Quarter`.
    enum Quarter: Int, CaseIterable {
        case none = 0
        case one = 1
        case two = 2
        case three = 3

        /// Normalise any integer into the 0..<4 range, the way the web does.
        /// A value from a server row is not trusted to be in range.
        init(normalizing raw: Int) {
            self = Quarter(rawValue: ((raw % 4) + 4) % 4) ?? .none
        }
    }

    /// Image dimensions after `turns` clockwise quarter turns.
    static func rotatedDims(w: Double, h: Double, turns: Quarter) -> CGSize {
        turns.rawValue % 2 == 0 ? CGSize(width: w, height: h) : CGSize(width: h, height: w)
    }

    /// Where a source pixel lands after `turns` clockwise quarter turns.
    /// `w`/`h` are the SOURCE dimensions.
    static func rotatePoint(
        _ p: CGPoint,
        turns: Quarter,
        w: Double,
        h: Double
    ) -> CGPoint {
        switch turns {
        case .one: return CGPoint(x: h - p.y, y: p.x)
        case .two: return CGPoint(x: w - p.x, y: h - p.y)
        case .three: return CGPoint(x: p.y, y: w - p.x)
        case .none: return p
        }
    }

    /// Row-major 3x3 product.
    static func matMul3(_ a: [Double], _ b: [Double]) -> [Double] {
        guard a.count == 9, b.count == 9 else { return a }
        var out = [Double](repeating: 0, count: 9)
        for r in 0..<3 {
            for c in 0..<3 {
                var sum = 0.0
                for k in 0..<3 {
                    sum += a[r * 3 + k] * b[k * 3 + c]
                }
                out[r * 3 + c] = sum
            }
        }
        return out
    }

    /// The affine that takes a ROTATED pixel back to its source pixel,
    /// row-major. The inverse of ``rotatePoint(_:turns:w:h:)``, and the piece
    /// the homography needs: `H` reads source pixels, so composing it with
    /// "new pixel -> source pixel" gives a homography that reads the rotated
    /// image and returns the same inches.
    static func inverseAffine(turns: Quarter, w: Double, h: Double) -> [Double] {
        switch turns {
        case .one: return [0, 1, 0, -1, 0, h, 0, 0, 1]
        case .two: return [-1, 0, w, 0, -1, h, 0, 0, 1]
        case .three: return [0, -1, w, 1, 0, 0, 0, 0, 1]
        case .none: return [1, 0, 0, 0, 1, 0, 0, 0, 1]
        }
    }

    /// The same homography, reading the rotated image. `w`/`h` are the SOURCE
    /// dimensions.
    static func rotateHomography(
        _ homography: [Double],
        turns: Quarter,
        w: Double,
        h: Double
    ) -> [Double] {
        guard turns != .none else { return homography }
        return matMul3(homography, inverseAffine(turns: turns, w: w, h: h))
    }

    /// Row-major 3x3 inverse, or nil when the matrix is singular.
    static func invert3(_ m: [Double]) -> [Double]? {
        guard m.count == 9 else { return nil }
        let a = m[0], b = m[1], c = m[2]
        let d = m[3], e = m[4], f = m[5]
        let g = m[6], h = m[7], i = m[8]
        let A = e * i - f * h
        let B = -(d * i - f * g)
        let C = d * h - e * g
        let det = a * A + b * B + c * C
        guard det.isFinite, abs(det) >= 1e-12 else { return nil }
        let inv = 1 / det
        return [
            A * inv,
            -(b * i - c * h) * inv,
            (b * f - c * e) * inv,
            B * inv,
            (a * i - c * g) * inv,
            -(a * f - c * d) * inv,
            C * inv,
            -(a * h - b * g) * inv,
            (a * e - b * d) * inv,
        ]
    }

    /// How many clockwise quarter turns put the CARD upright in the frame.
    ///
    /// The card's own +x axis is walked back into pixel space through the
    /// inverse homography, and the answer is the turn that lands that axis
    /// pointing right. No detection and no model call: the card's four
    /// fiducials carry different ids in a known clockwise order, so the
    /// homography already knows which way the card is lying.
    ///
    /// Returns `.none` for a homography that will not invert, which reads as
    /// "already upright" and therefore as "do nothing". Declining to act on a
    /// reading it does not trust is the correct failure here.
    static func cardUprightQuarter(_ homography: [Double]) -> Quarter {
        guard homography.count == 9, let inv = invert3(homography) else { return .none }
        let origin = MeasureGeometry.applyHomography(inv, x: 0, y: 0)
        let along = MeasureGeometry.applyHomography(inv, x: 1, y: 0)
        let dx = along.x - origin.x
        let dy = along.y - origin.y
        guard dx.isFinite, dy.isFinite, !(dx == 0 && dy == 0) else { return .none }
        // Screen y grows downward, so this angle is already measured clockwise,
        // and a clockwise quarter turn adds 90 to it. Solve for the turn that
        // lands on 0.
        let degrees = atan2(dy, dx) * 180 / .pi
        let quarters = Int((degrees / 90).rounded())
        return Quarter(normalizing: -quarters)
    }

    /// Human phrasing for a turn, for a button label and a toast.
    static func label(_ turns: Quarter) -> String {
        switch turns {
        case .one: return String(localized: "a quarter turn right")
        case .two: return String(localized: "upside down")
        case .three: return String(localized: "a quarter turn left")
        case .none: return String(localized: "already upright")
        }
    }
}
