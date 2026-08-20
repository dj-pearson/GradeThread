import XCTest
@testable import GradeThread

/// US-2534. The nudge maths behind the measurement screen's non-drag path.
///
/// Small surface, and every case here is one where a wrong answer looks like a
/// working control: a zero step is a button that reports success and moves
/// nothing, a missing clamp puts an endpoint off the photo where the homography
/// has nothing to say, and an announcement of pixel coordinates is a true
/// sentence about something no seller can act on.
final class MeasureNudgeTests: XCTestCase {

    // MARK: - Step

    func testStepScalesWithTheShortEdge() {
        // Proportional so a nudge covers the same fraction of the garment on a
        // phone photo and a camera one. 0.5% of the short edge.
        XCTAssertEqual(MeasureNudge.step(imgW: 1600, imgH: 2000), 8)
        XCTAssertEqual(MeasureNudge.step(imgW: 4000, imgH: 3000), 15)
    }

    func testStepUsesTheSHORTEdgeNotTheWidth() {
        // A wide, short photo and a tall, narrow one of the same garment should
        // nudge by the same amount. Keying on width alone would make one of
        // them four times coarser.
        XCTAssertEqual(
            MeasureNudge.step(imgW: 3000, imgH: 1000),
            MeasureNudge.step(imgW: 1000, imgH: 3000)
        )
    }

    func testStepIsNeverZero() {
        // A step of zero is a control that says it worked and does nothing,
        // which is worse than having no control at all.
        XCTAssertEqual(MeasureNudge.step(imgW: 10, imgH: 10), 1)
        XCTAssertEqual(MeasureNudge.step(imgW: 0, imgH: 0), 1)
        XCTAssertEqual(MeasureNudge.step(imgW: -5, imgH: 100), 1)
    }

    // MARK: - Movement

    func testEachDirectionMovesTheRightWay() {
        let p = CGPoint(x: 100, y: 100)
        let moved = { (d: MeasureNudge.Direction) in
            MeasureNudge.nudged(p, d, step: 10, imgW: 1000, imgH: 1000)
        }
        XCTAssertEqual(moved(.left), CGPoint(x: 90, y: 100))
        XCTAssertEqual(moved(.right), CGPoint(x: 110, y: 100))
        // Image pixels have a top-left origin, so "up" DECREASES y. Naming the
        // directions by what the user sees is the whole reason this is pinned.
        XCTAssertEqual(moved(.up), CGPoint(x: 100, y: 90))
        XCTAssertEqual(moved(.down), CGPoint(x: 100, y: 110))
    }

    func testItClampsToTheImageRatherThanRefusing() {
        // The drag path clamps the same way. Refusing instead would leave a user
        // pressing a button that silently does nothing near the border, with no
        // way to tell that from a bug.
        XCTAssertEqual(
            MeasureNudge.nudged(CGPoint(x: 2, y: 500), .left, step: 10, imgW: 1000, imgH: 1000),
            CGPoint(x: 0, y: 500)
        )
        XCTAssertEqual(
            MeasureNudge.nudged(CGPoint(x: 995, y: 500), .right, step: 10, imgW: 1000, imgH: 1000),
            CGPoint(x: 1000, y: 500)
        )
        XCTAssertEqual(
            MeasureNudge.nudged(CGPoint(x: 500, y: 3), .up, step: 10, imgW: 1000, imgH: 1000),
            CGPoint(x: 500, y: 0)
        )
        XCTAssertEqual(
            MeasureNudge.nudged(CGPoint(x: 500, y: 998), .down, step: 10, imgW: 1000, imgH: 1000),
            CGPoint(x: 500, y: 1000)
        )
    }

    func testAlreadyAtTheEdgeStaysThere() {
        XCTAssertEqual(
            MeasureNudge.nudged(CGPoint(x: 0, y: 0), .left, step: 10, imgW: 1000, imgH: 1000),
            CGPoint(x: 0, y: 0)
        )
    }

    // MARK: - Announcement

    func testAnnouncementSaysTheMEASUREMENT() {
        // Not the coordinates. A seller adjusting a chest line cares that it now
        // reads 21 and a quarter; "x 1284, y 902" is true and useless.
        XCTAssertEqual(
            MeasureNudge.announcement(
                lineLabel: "Chest (pit to pit)",
                endName: "Start",
                inches: 21.25
            ),
            "Chest, Start, 21 1/4 inches"
        )
    }

    func testAnnouncementKeepsALabelThatHasNoParenthetical() {
        XCTAssertEqual(
            MeasureNudge.announcement(lineLabel: "Length", endName: "End", inches: 28),
            "Length, End, 28 inches"
        )
    }

    func testDirectionLabelsAreSpeakable() {
        XCTAssertEqual(
            MeasureNudge.Direction.allCases.map(\.label),
            ["Left", "Right", "Up", "Down"]
        )
    }
}
