import XCTest
import UIKit
@testable import GradeThread

/// Pure compositing geometry + severity colors for annotated defect photos.
final class DisclosureGeometryTests: XCTestCase {

    func test_canvasSize_capsWidth_keepsAspect() {
        let s = DisclosureGeometry.canvasSize(imageSize: CGSize(width: 1800, height: 1200))
        XCTAssertEqual(s.width, 900)
        XCTAssertEqual(s.height, 600, accuracy: 0.5)
    }

    func test_canvasSize_doesNotUpscaleSmallImages() {
        let s = DisclosureGeometry.canvasSize(imageSize: CGSize(width: 400, height: 300))
        XCTAssertEqual(s.width, 400)
        XCTAssertEqual(s.height, 300, accuracy: 0.5)
    }

    func test_canvasSize_zeroForEmpty() {
        XCTAssertEqual(DisclosureGeometry.canvasSize(imageSize: .zero), .zero)
    }

    func test_scaledRect_mapsNormalizedToPixels() {
        let r = DisclosureGeometry.scaledRect(bbox: [0.1, 0.2, 0.3, 0.4],
                                              in: CGSize(width: 1000, height: 800))
        XCTAssertEqual(r, CGRect(x: 100, y: 160, width: 300, height: 320))
    }

    func test_scaledRect_nilForMalformedBbox() {
        XCTAssertNil(DisclosureGeometry.scaledRect(bbox: [0.1, 0.2],
                                                   in: CGSize(width: 100, height: 100)))
    }

    func test_legendHeight() {
        XCTAssertEqual(DisclosureGeometry.legendHeight(annotationCount: 0), 0)
        XCTAssertEqual(DisclosureGeometry.legendHeight(annotationCount: 3), 14 * 2 + 3 * 26)
    }

    func test_compositeSize_addsLegendBelowPhoto() {
        let c = DisclosureGeometry.compositeSize(
            imageSize: CGSize(width: 900, height: 600), annotationCount: 2
        )
        XCTAssertEqual(c.width, 900)
        XCTAssertEqual(c.height, 600 + (14 * 2 + 2 * 26), accuracy: 0.5)
    }

    func test_severityColor_major() {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        DisclosureSeverityColor.color(for: "major").getRed(&r, green: &g, blue: &b, alpha: &a)
        XCTAssertEqual(r, 0.941, accuracy: 0.01)
        XCTAssertEqual(g, 0.239, accuracy: 0.01)
    }

    func test_severityColor_unknownFallsBackToMinor() {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        DisclosureSeverityColor.color(for: "weird").getRed(&r, green: &g, blue: &b, alpha: &a)
        XCTAssertEqual(r, 0.918, accuracy: 0.01) // #EAB308 (minor)
    }
}
