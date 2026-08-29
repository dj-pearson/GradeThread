import XCTest
@testable import GradeThread

/// US-2889 AC3/AC4/AC5: the whole-line move and the off-screen recovery, held
/// to the browser's numbers through `assets/measure-card/quarter-turn-cases.json`.
///
/// These three functions are where a careful port goes wrong quietly, and the
/// first draft of the Swift side got all three wrong in ways a review would
/// have waved through:
///
///   - `translateLine` clamped unconditionally. The browser deliberately does
///     NOT clamp when the window is empty, because a segment longer than the
///     frame has no delta that leaves it inside and clamping into an empty
///     range FREEZES the line - the same dead end as the off-screen endpoint
///     this story exists to fix.
///   - `recenteredIntoFrame` returned an oversized line unchanged. The browser
///     translates first, then shrinks about the midpoint so the line stays on
///     the same landmark.
///   - `distanceToSegment` returned only the distance. The browser returns the
///     parameter too, so a caller can refuse a hit that is really on an
///     endpoint.
///
/// Every one of those passes the ordinary cases. That is the argument for a
/// generated fixture over a careful reading.
final class MeasureLineFixtureTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Pair: Decodable {
            let e1: [Double]
            let e2: [Double]
        }
        struct Translate: Decodable {
            let label: String
            let w: Double
            let h: Double
            let e1: [Double]
            let e2: [Double]
            let dx: Double
            let dy: Double
            let expected: Pair
        }
        struct Recenter: Decodable {
            let label: String
            let w: Double
            let h: Double
            let e1: [Double]
            let e2: [Double]
            let within: Bool
            let expected: Pair
        }
        struct Segment: Decodable {
            struct Result: Decodable {
                let distance: Double
                let t: Double
            }
            let label: String
            let point: [Double]
            let e1: [Double]
            let e2: [Double]
            let expected: Result
        }
        struct Cases: Decodable {
            let translate: [Translate]
            let recenter: [Recenter]
            let segment: [Segment]
        }
        let source: String
        let cases: Cases
    }

    private static let repoRoot: URL = {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }()

    private func loadFixture(file: StaticString = #filePath, line: UInt = #line) throws -> Fixture {
        let url = Self.repoRoot
            .appendingPathComponent("assets/measure-card/quarter-turn-cases.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail(
                "quarter-turn fixture missing at \(url.path). "
                    + "Regenerate with: npx vite-node scripts/gen-quarter-turn-fixture.mjs",
                file: file,
                line: line
            )
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func line(_ e1: [Double], _ e2: [Double]) -> MeasureGeometry.Line {
        MeasureGeometry.Line(
            key: "k",
            label: "L",
            e1: CGPoint(x: e1[0], y: e1[1]),
            e2: CGPoint(x: e2[0], y: e2[1])
        )
    }

    func test_fixture_isPresentAndPopulated() throws {
        // Guards the guard: an empty group makes every loop below a no-op, and a
        // no-op loop looks exactly like a passing one.
        let f = try loadFixture()
        XCTAssertEqual(f.source, "src/lib/measure-photo-geometry.ts")
        XCTAssertGreaterThan(f.cases.translate.count, 50)
        XCTAssertGreaterThan(f.cases.recenter.count, 20)
        XCTAssertGreaterThan(f.cases.segment.count, 20)
    }

    func test_lineWithinBounds_matchesTheReference() throws {
        for c in try loadFixture().cases.recenter {
            XCTAssertEqual(
                MeasureGeometry.lineWithinBounds(line(c.e1, c.e2), imgW: c.w, imgH: c.h),
                c.within,
                "\(c.label) in \(c.w)x\(c.h)"
            )
        }
    }

    func test_translateLine_matchesTheReference() throws {
        for c in try loadFixture().cases.translate {
            let got = MeasureGeometry.translateLine(
                line(c.e1, c.e2), dx: c.dx, dy: c.dy, imgW: c.w, imgH: c.h
            )
            let what = "\(c.label) by \(c.dx),\(c.dy) in \(c.w)x\(c.h)"
            XCTAssertEqual(Double(got.e1.x), c.expected.e1[0], accuracy: 1e-9, "\(what) e1.x")
            XCTAssertEqual(Double(got.e1.y), c.expected.e1[1], accuracy: 1e-9, "\(what) e1.y")
            XCTAssertEqual(Double(got.e2.x), c.expected.e2[0], accuracy: 1e-9, "\(what) e2.x")
            XCTAssertEqual(Double(got.e2.y), c.expected.e2[1], accuracy: 1e-9, "\(what) e2.y")
        }
    }

    func test_recenter_matchesTheReference() throws {
        for c in try loadFixture().cases.recenter {
            let got = MeasureGeometry.recenteredIntoFrame(
                line(c.e1, c.e2), imgW: c.w, imgH: c.h
            )
            let what = "\(c.label) in \(c.w)x\(c.h)"
            XCTAssertEqual(Double(got.e1.x), c.expected.e1[0], accuracy: 1e-9, "\(what) e1.x")
            XCTAssertEqual(Double(got.e1.y), c.expected.e1[1], accuracy: 1e-9, "\(what) e1.y")
            XCTAssertEqual(Double(got.e2.x), c.expected.e2[0], accuracy: 1e-9, "\(what) e2.x")
            XCTAssertEqual(Double(got.e2.y), c.expected.e2[1], accuracy: 1e-9, "\(what) e2.y")
        }
    }

    func test_distanceToSegment_matchesTheReference() throws {
        for c in try loadFixture().cases.segment {
            let got = MeasureGeometry.distanceToSegment(
                CGPoint(x: c.point[0], y: c.point[1]),
                CGPoint(x: c.e1[0], y: c.e1[1]),
                CGPoint(x: c.e2[0], y: c.e2[1])
            )
            XCTAssertEqual(got.distance, c.expected.distance, accuracy: 1e-9,
                           "\(c.label) distance from \(c.point)")
            XCTAssertEqual(got.t, c.expected.t, accuracy: 1e-9,
                           "\(c.label) t from \(c.point)")
        }
    }

    // MARK: - Properties the fixture does not state

    func test_aWholeLineMoveKeepsItsLengthAndAngle() {
        // AC3's actual promise. Dragging both ends by hand is what a seller had
        // to do before this, and it changed the measurement every time.
        let l = line([40, 40], [240, 120])
        let before = hypot(l.e2.x - l.e1.x, l.e2.y - l.e1.y)
        let angleBefore = atan2(l.e2.y - l.e1.y, l.e2.x - l.e1.x)
        for (dx, dy) in [(30.0, 0.0), (0.0, -20.0), (-1000.0, 1000.0)] {
            let moved = MeasureGeometry.translateLine(l, dx: dx, dy: dy, imgW: 400, imgH: 300)
            let after = hypot(moved.e2.x - moved.e1.x, moved.e2.y - moved.e1.y)
            let angleAfter = atan2(moved.e2.y - moved.e1.y, moved.e2.x - moved.e1.x)
            XCTAssertEqual(after, before, accuracy: 1e-9, "length changed on \(dx),\(dy)")
            XCTAssertEqual(angleAfter, angleBefore, accuracy: 1e-9, "angle changed on \(dx),\(dy)")
        }
    }

    func test_recenterBringsAStrandedLineBackAndKeepsItsLength() {
        // AC4. The line is wholly outside a frame it fits inside, so the answer
        // is a pure translation and the measurement must survive it.
        let stranded = line([700, 700], [900, 760])
        let before = hypot(stranded.e2.x - stranded.e1.x, stranded.e2.y - stranded.e1.y)
        let back = MeasureGeometry.recenteredIntoFrame(stranded, imgW: 400, imgH: 300)
        XCTAssertTrue(MeasureGeometry.lineWithinBounds(back, imgW: 400, imgH: 300))
        let after = hypot(back.e2.x - back.e1.x, back.e2.y - back.e1.y)
        XCTAssertEqual(after, before, accuracy: 1e-9)
    }

    func test_isOutsideFrame_isTheNegationOfWithinBounds() {
        // One definition of "inside", not two. Worth pinning because the two
        // used to be written out separately and could disagree on an endpoint
        // sitting exactly on the edge.
        for l in [line([0, 0], [400, 300]), line([-1, 0], [10, 10]), line([10, 10], [20, 20])] {
            XCTAssertEqual(
                MeasureGeometry.isOutsideFrame(l, imgW: 400, imgH: 300),
                !MeasureGeometry.lineWithinBounds(l, imgW: 400, imgH: 300)
            )
        }
    }

    func test_endpointsWinTheHitTestOverTheLineBody() {
        // On a line barely longer than the touch radius every point is near an
        // end, so a body hit that beat an endpoint would make the endpoints of
        // a short line unreachable - and resizing has to stay the easier
        // gesture.
        let lines = [line([100, 100], [140, 100])]
        let onEnd = MeasureGeometry.hitTest(
            lines: lines, displayPoint: CGPoint(x: 100, y: 100), scale: 1
        )
        XCTAssertEqual(onEnd, .end(index: 0, end: .e1))
    }

    func test_aTouchOnEmptySpaceGrabsNothing() {
        let lines = [line([100, 100], [140, 100])]
        XCTAssertNil(
            MeasureGeometry.hitTest(lines: lines, displayPoint: CGPoint(x: 5, y: 250), scale: 1)
        )
    }
}
