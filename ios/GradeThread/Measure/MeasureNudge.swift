import CoreGraphics
import Foundation

/// US-2534 — moving a measurement endpoint without dragging it.
///
/// The measurement canvas positions endpoints with a `DragGesture`, and a drag
/// on a bare canvas is reachable by exactly one input method. VoiceOver has no
/// handle on it, Switch Control has nothing to select, and full keyboard access
/// has nothing to focus. Every other control on that screen got a label in the
/// earlier passes of this story; this one could not be fixed with a label,
/// because the missing thing is not a NAME, it is a way to perform the action.
///
/// SEPARATE FROM ``MeasureGeometry`` ON PURPOSE. That file states in its own
/// header that it is a port of `src/lib/measure-editor-math.ts` and that the two
/// suites assert the same cases so the platforms cannot drift. Adding a function
/// there that the web does not have would quietly make that sentence false. The
/// web canvas has the same accessibility gap and it needs its own story, with a
/// keyboard model rather than a copy of this one - filing that is honest;
/// shipping an unused TypeScript twin to preserve a symmetry nobody is using is
/// not.
enum MeasureNudge {
    /// How far one nudge moves an endpoint, in ORIGINAL image pixels.
    ///
    /// Proportional to the SHORT edge rather than a fixed count, so a nudge
    /// covers the same fraction of the garment on a 1600px phone photo and a
    /// 4000px camera one. A fixed 8px would be a visible step on the first and
    /// imperceptible on the second, which turns "nudge until it lines up" into
    /// forty presses.
    ///
    /// Floored at 1: a step of zero is a control that reports success and moves
    /// nothing, which is worse than no control.
    static func step(imgW: Double, imgH: Double) -> Double {
        let short = min(imgW, imgH)
        guard short.isFinite, short > 0 else { return 1 }
        return max(1, (short * 0.005).rounded())
    }

    /// The four directions a nudge control offers, as screen directions.
    ///
    /// `down` increases y because these are IMAGE pixels, whose origin is the
    /// top-left. Naming them by what the user sees rather than by the sign
    /// keeps the button labels and the maths from disagreeing.
    enum Direction: String, CaseIterable {
        case left, right, up, down

        var delta: (dx: Double, dy: Double) {
            switch self {
            case .left:  return (-1, 0)
            case .right: return (1, 0)
            case .up:    return (0, -1)
            case .down:  return (0, 1)
            }
        }

        var label: String { rawValue.capitalized }
    }

    /// Move `point` one step, clamped inside the image.
    ///
    /// CLAMPED, not refused: an endpoint pushed past the edge stops at the edge,
    /// which is what the drag path already does (`handleDrag` clamps the same
    /// way). Refusing instead would leave a user pressing a button that silently
    /// does nothing near the border, with no way to tell that from a bug.
    static func nudged(
        _ point: CGPoint,
        _ direction: Direction,
        step: Double,
        imgW: Double,
        imgH: Double
    ) -> CGPoint {
        let (dx, dy) = direction.delta
        return CGPoint(
            x: min(max(0, point.x + dx * step), max(0, imgW)),
            y: min(max(0, point.y + dy * step), max(0, imgH))
        )
    }

    /// What the screen reader says after a nudge.
    ///
    /// The INCHES, not the pixel coordinates. A seller adjusting a chest line
    /// cares that it now reads 21 and a quarter; "x 1284, y 902" is a true
    /// statement about nothing they can act on. The endpoint is still named so
    /// two consecutive presses on different endpoints are distinguishable.
    static func announcement(lineLabel: String, endName: String, inches: Double) -> String {
        let short = lineLabel.components(separatedBy: " (").first ?? lineLabel
        return "\(short), \(endName), \(MeasureGeometry.formatQuarter(inches)) inches"
    }
}
