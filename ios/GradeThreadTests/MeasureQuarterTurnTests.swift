import XCTest
@testable import GradeThread

/// US-2889 AC5: the iOS quarter-turn math is held to the same NUMBERS as the
/// browser's, through `assets/measure-card/quarter-turn-cases.json`.
///
/// US-2890 keeps the browser and the edge in step by comparing their source
/// text, which works because both are TypeScript. Swift cannot be compared that
/// way, and "we ported it carefully" is not a check. So the reference
/// implementation generates 240 cases and this replays every one of them.
///
/// What that catches, and a review would not: a sign error. Getting the
/// direction of a quarter turn backwards produces a mirrored measurement rather
/// than a crash - the app runs, the lines draw, the inches are wrong. US-2890
/// hit exactly this on the server side, where imagescript's rotate(90) turned
/// out to be counter-clockwise, and the dimensions were identical either way.
///
/// The fixture is located from `#filePath` rather than from a test bundle
/// resource, so no Xcode project wiring is needed and the path is correct on
/// any checkout. A missing file FAILS - it does not skip. A fixture test that
/// skips when it cannot find its fixture reports green for the one state it
/// exists to detect.
final class MeasureQuarterTurnTests: XCTestCase {

    // MARK: - Loading

    private struct Fixture: Decodable {
        struct Dims: Decodable {
            let w: Double
            let h: Double
            let turns: Int
            let expected: [Double]
        }
        struct Point: Decodable {
            let w: Double
            let h: Double
            let turns: Int
            let point: [Double]
            let expected: [Double]
        }
        struct Affine: Decodable {
            let w: Double
            let h: Double
            let turns: Int
            let expected: [Double]
        }
        struct Homography: Decodable {
            let label: String
            let w: Double
            let h: Double
            let turns: Int
            let homography: [Double]
            let expected: [Double]
        }
        struct Upright: Decodable {
            let label: String
            let w: Double
            let h: Double
            let applied: Int
            let homography: [Double]
            let expected: Int
        }
        struct Cases: Decodable {
            let dims: [Dims]
            let points: [Point]
            let inverseAffine: [Affine]
            let homographies: [Homography]
            let upright: [Upright]
        }
        let source: String
        let cases: Cases
    }

    private static let repoRoot: URL = {
        // .../ios/GradeThreadTests/MeasureQuarterTurnTests.swift -> repo root
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

    /// Guards the guard: a fixture that decoded to nothing would make every
    /// assertion below vacuously true, which is the failure mode of this whole
    /// file.
    func test_fixture_isPresentAndPopulated() throws {
        let f = try loadFixture()
        XCTAssertEqual(f.source, "src/lib/measure-photo-geometry.ts")
        XCTAssertGreaterThan(f.cases.dims.count, 8)
        XCTAssertGreaterThan(f.cases.points.count, 50)
        XCTAssertGreaterThan(f.cases.inverseAffine.count, 8)
        XCTAssertGreaterThan(f.cases.homographies.count, 20)
        XCTAssertGreaterThan(f.cases.upright.count, 20)
    }

    // MARK: - The cases

    func test_rotatedDims_matchesTheReference() throws {
        for c in try loadFixture().cases.dims {
            let got = MeasureQuarterTurn.rotatedDims(
                w: c.w, h: c.h, turns: MeasureQuarterTurn.Quarter(normalizing: c.turns)
            )
            XCTAssertEqual(Double(got.width), c.expected[0], accuracy: 1e-9,
                           "dims \(c.w)x\(c.h) turn \(c.turns)")
            XCTAssertEqual(Double(got.height), c.expected[1], accuracy: 1e-9,
                           "dims \(c.w)x\(c.h) turn \(c.turns)")
        }
    }

    func test_rotatePoint_matchesTheReference() throws {
        for c in try loadFixture().cases.points {
            let got = MeasureQuarterTurn.rotatePoint(
                CGPoint(x: c.point[0], y: c.point[1]),
                turns: MeasureQuarterTurn.Quarter(normalizing: c.turns),
                w: c.w,
                h: c.h
            )
            XCTAssertEqual(Double(got.x), c.expected[0], accuracy: 1e-9,
                           "point \(c.point) turn \(c.turns) in \(c.w)x\(c.h)")
            XCTAssertEqual(Double(got.y), c.expected[1], accuracy: 1e-9,
                           "point \(c.point) turn \(c.turns) in \(c.w)x\(c.h)")
        }
    }

    func test_inverseAffine_matchesTheReference() throws {
        for c in try loadFixture().cases.inverseAffine {
            let got = MeasureQuarterTurn.inverseAffine(
                turns: MeasureQuarterTurn.Quarter(normalizing: c.turns), w: c.w, h: c.h
            )
            XCTAssertEqual(got.count, 9)
            for i in 0..<9 {
                XCTAssertEqual(got[i], c.expected[i], accuracy: 1e-9,
                               "affine[\(i)] turn \(c.turns) in \(c.w)x\(c.h)")
            }
        }
    }

    func test_rotateHomography_matchesTheReference() throws {
        for c in try loadFixture().cases.homographies {
            let got = MeasureQuarterTurn.rotateHomography(
                c.homography,
                turns: MeasureQuarterTurn.Quarter(normalizing: c.turns),
                w: c.w,
                h: c.h
            )
            XCTAssertEqual(got.count, 9)
            for i in 0..<9 {
                XCTAssertEqual(got[i], c.expected[i], accuracy: 1e-9,
                               "\(c.label) H[\(i)] turn \(c.turns) in \(c.w)x\(c.h)")
            }
        }
    }

    func test_cardUprightQuarter_matchesTheReference() throws {
        for c in try loadFixture().cases.upright {
            let got = MeasureQuarterTurn.cardUprightQuarter(c.homography)
            XCTAssertEqual(got.rawValue, c.expected,
                           "\(c.label) applied \(c.applied) in \(c.w)x\(c.h)")
        }
    }

    // MARK: - Properties the fixture does not state

    func test_fourQuarterTurnsReturnEveryPointToItself() {
        var p = CGPoint(x: 123, y: 45)
        var w = 400.0
        var h = 300.0
        for _ in 0..<4 {
            p = MeasureQuarterTurn.rotatePoint(p, turns: .one, w: w, h: h)
            let d = MeasureQuarterTurn.rotatedDims(w: w, h: h, turns: .one)
            w = Double(d.width)
            h = Double(d.height)
        }
        XCTAssertEqual(Double(p.x), 123, accuracy: 1e-9)
        XCTAssertEqual(Double(p.y), 45, accuracy: 1e-9)
        XCTAssertEqual(w, 400, accuracy: 1e-9)
        XCTAssertEqual(h, 300, accuracy: 1e-9)
    }

    func test_aRotatedPointLandsInsideTheRotatedFrame() {
        // The bug US-2889 exists to close: an endpoint at x=3000 in a picture
        // now 2000 wide, drawn off screen and impossible to drag or nudge back.
        let w = 400.0
        let h = 300.0
        for turns in [MeasureQuarterTurn.Quarter.one, .two, .three] {
            let d = MeasureQuarterTurn.rotatedDims(w: w, h: h, turns: turns)
            for p in [CGPoint(x: 0, y: 0), CGPoint(x: w, y: 0),
                      CGPoint(x: 0, y: h), CGPoint(x: w, y: h)] {
                let r = MeasureQuarterTurn.rotatePoint(p, turns: turns, w: w, h: h)
                XCTAssertTrue(
                    r.x >= 0 && r.x <= d.width && r.y >= 0 && r.y <= d.height,
                    "turn \(turns.rawValue) sent \(p) to \(r), outside \(d)"
                )
            }
        }
    }

    func test_aRotatedHomographyReportsTheSameInches() {
        // The justification for carrying rather than re-detecting.
        let H = [0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1]
        let w = 400.0
        let h = 300.0
        let src = CGPoint(x: 250, y: 140)
        let before = MeasureGeometry.applyHomography(H, x: src.x, y: src.y)
        for turns in [MeasureQuarterTurn.Quarter.one, .two, .three] {
            let H2 = MeasureQuarterTurn.rotateHomography(H, turns: turns, w: w, h: h)
            let moved = MeasureQuarterTurn.rotatePoint(src, turns: turns, w: w, h: h)
            let after = MeasureGeometry.applyHomography(H2, x: moved.x, y: moved.y)
            XCTAssertEqual(Double(after.x), Double(before.x), accuracy: 1e-9)
            XCTAssertEqual(Double(after.y), Double(before.y), accuracy: 1e-9)
        }
    }

    func test_cardUprightQuarter_declinesRatherThanGuessesOnASingularHomography() {
        XCTAssertEqual(
            MeasureQuarterTurn.cardUprightQuarter([0, 0, 0, 0, 0, 0, 0, 0, 0]), .none
        )
        XCTAssertEqual(MeasureQuarterTurn.cardUprightQuarter([1, 2, 3]), .none)
    }

    func test_quarterNormalisesAnOutOfRangeServerValue() {
        XCTAssertEqual(MeasureQuarterTurn.Quarter(normalizing: 5), .one)
        XCTAssertEqual(MeasureQuarterTurn.Quarter(normalizing: -1), .three)
        XCTAssertEqual(MeasureQuarterTurn.Quarter(normalizing: 4), .none)
    }
}
