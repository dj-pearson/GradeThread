import XCTest
@testable import GradeThread

// US-1281: Verified 360 — capability/mode-decision + badge-preview thresholds.
// Pure logic (no ARKit session), so it runs on the CI host.
final class Capture360SupportTests: XCTestCase {

    // AC1: a capable device is offered the premium Verified 360 mode.
    func testCapableDeviceOffersVerified360() {
        let cap = Capture360Capability(hasDepth: true, supportsPhotogrammetry: true)
        XCTAssertTrue(cap.supportsVerified360)
        XCTAssertEqual(Capture360Support.resolveMode(cap), .verified360)
    }

    // AC1: depth (LiDAR) is a strengthener, not a gate — photogrammetry-only
    // still qualifies for the mode offer.
    func testPhotogrammetryOnlyStillOffersVerified360() {
        let cap = Capture360Capability(hasDepth: false, supportsPhotogrammetry: true)
        XCTAssertEqual(Capture360Support.resolveMode(cap), .verified360)
    }

    // AC2: unsupported devices fall back to 2D zone coverage; 360 never required.
    func testUnsupportedDeviceFallsBackTo2D() {
        XCTAssertEqual(
            Capture360Support.resolveMode(.unsupported),
            .zoneCoverage2D
        )
    }

    // AC3 preview: a complete capture over both thresholds qualifies.
    func testQualifiesWhenThresholdsMet() {
        XCTAssertTrue(
            Capture360Support.qualifies(
                angles: 12,
                geometricCoverage: 0.93,
                captureComplete: true
            )
        )
    }

    func testDoesNotQualifyWithTooFewAngles() {
        XCTAssertFalse(
            Capture360Support.qualifies(
                angles: 3,
                geometricCoverage: 0.99,
                captureComplete: true
            )
        )
    }

    func testDoesNotQualifyWithLowCoverage() {
        XCTAssertFalse(
            Capture360Support.qualifies(
                angles: 16,
                geometricCoverage: 0.4,
                captureComplete: true
            )
        )
    }

    func testDoesNotQualifyWhenCaptureIncomplete() {
        XCTAssertFalse(
            Capture360Support.qualifies(
                angles: 16,
                geometricCoverage: 0.99,
                captureComplete: false
            )
        )
    }

    // The client preview thresholds must mirror the server defaults so the UI
    // does not promise a badge the server then withholds.
    func testThresholdsMirrorServerDefaults() {
        XCTAssertEqual(Capture360Support.minAngles, 8)
        XCTAssertEqual(Capture360Support.minGeometricCoverage, 0.85, accuracy: 0.0001)
    }
}
