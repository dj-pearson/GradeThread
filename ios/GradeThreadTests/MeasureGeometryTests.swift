import XCTest
@testable import GradeThread

/// US-1575: the Swift port of the measurement-editor math must agree with the
/// web spec (src/lib/measure-editor-math.ts + its vitest suite) — the SAME
/// numeric cases are asserted on both platforms so px->inch behavior cannot
/// drift, plus the shared photo-type listing-exclusion vocabulary.
final class MeasureGeometryTests: XCTestCase {
    /// 100 px per inch, pure scale (matches the vitest constant).
    private let h: [Double] = [1.0 / 100, 0, 0, 0, 1.0 / 100, 0, 0, 0, 1]

    func testHomographyMapsPxToInches() {
        let p = MeasureGeometry.applyHomography(h, x: 250, y: 0)
        XCTAssertEqual(p.x, 2.5, accuracy: 1e-9)
        XCTAssertEqual(
            MeasureGeometry.inchesBetween(h, CGPoint(x: 100, y: 500), CGPoint(x: 2300, y: 500)),
            22
        )
        XCTAssertEqual(
            MeasureGeometry.inchesBetween(h, CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 2837)),
            28.25
        )
    }

    func testQuarterRoundingAndFormatting() {
        XCTAssertEqual(MeasureGeometry.roundQuarterInch(22.13), 22.25)
        XCTAssertEqual(MeasureGeometry.formatQuarter(22.25), "22 1/4")
        XCTAssertEqual(MeasureGeometry.formatQuarter(28), "28")
        XCTAssertEqual(MeasureGeometry.formatQuarter(0.5), "1/2")
    }

    func testFitScaleNeverUpscales() {
        XCTAssertEqual(
            MeasureGeometry.fitScale(imgW: 4000, imgH: 3000, maxW: 640, maxH: 480),
            0.16, accuracy: 1e-9
        )
        XCTAssertEqual(
            MeasureGeometry.fitScale(imgW: 300, imgH: 200, maxW: 640, maxH: 480),
            1
        )
    }

    func testHitEndpointGrabsNearestInDisplaySpace() {
        let lines = [
            MeasureGeometry.Line(
                key: "chest", label: "Chest",
                e1: CGPoint(x: 100, y: 100), e2: CGPoint(x: 500, y: 100)),
            MeasureGeometry.Line(
                key: "length", label: "Length",
                e1: CGPoint(x: 300, y: 50), e2: CGPoint(x: 300, y: 450)),
        ]
        // Display scale 0.5: chest.e2 shows at (250, 50).
        let hit = MeasureGeometry.hitEndpoint(
            lines: lines, displayPoint: CGPoint(x: 252, y: 52), scale: 0.5, radius: 14)
        XCTAssertEqual(hit?.index, 0)
        XCTAssertEqual(hit?.end, .e2)
        // Nothing within radius.
        XCTAssertNil(MeasureGeometry.hitEndpoint(
            lines: lines, displayPoint: CGPoint(x: 400, y: 400), scale: 0.5, radius: 14))
        // length.e1 at (150, 25) wins for a point near it.
        let hit2 = MeasureGeometry.hitEndpoint(
            lines: lines, displayPoint: CGPoint(x: 149, y: 27), scale: 0.5, radius: 14)
        XCTAssertEqual(hit2?.index, 1)
        XCTAssertEqual(hit2?.end, .e1)
    }

    func testDefaultPlacementAxes() {
        let v = MeasureGeometry.defaultPlacement(key: "length", imgW: 1000, imgH: 800)
        XCTAssertEqual(v.e1.x, v.e2.x) // vertical
        let hz = MeasureGeometry.defaultPlacement(key: "chest", imgW: 1000, imgH: 800)
        XCTAssertEqual(hz.e1.y, hz.e2.y) // horizontal
        XCTAssertEqual(hz.e2.x - hz.e1.x, 400, accuracy: 1e-9)
    }

    // MARK: - Shared vocabulary (AC4)

    func testMeasurementPhotoTypesAreExcludedFromListings() {
        // The mirror of the edge's NON_LISTABLE_PHOTO_TYPES.
        XCTAssertTrue(FlipdeskPhotoType.isNonListable("measurement"))
        XCTAssertTrue(FlipdeskPhotoType.isNonListable("internal"))
        // The GENERATED overlay photo IS listable; regular roles are too.
        XCTAssertFalse(FlipdeskPhotoType.isNonListable("measurement_overlay"))
        XCTAssertFalse(FlipdeskPhotoType.isNonListable("front"))
        // Every non-listable type is a real vocabulary member.
        for type in FlipdeskPhotoType.nonListable {
            XCTAssertTrue(FlipdeskPhotoType.all.contains(type), type)
        }
    }

    func testMeasurementCardSlotRoundTrips() {
        // The capture slot resolves from the server profile role and
        // round-trips to the server photo_type.
        let slot = PhotoSlotType(serverType: "measurement")
        XCTAssertEqual(slot, .measurementCard)
        XCTAssertEqual(PhotoSlotType.measurementCard.serverPhotoType, "measurement")
        XCTAssertFalse(PhotoSlotType.measurementCard.isRequired, "measurement shot is skippable")
    }
}
