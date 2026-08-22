import AVFoundation
import XCTest
@testable import GradeThread

/// US-2137 AC2: the macro camera preference order.
///
/// These run without a camera, which is the reason the selection was split out
/// of ``CameraSession`` at all. The failure this guards is silent: a bad order
/// downgrades every macro shot on hardware that could have focused closer, and
/// the photo still arrives, still uploads, and still grades — just softer at the
/// one distance a serial number needs.
///
/// ⚠ NOT COMPILED OR RUN LOCALLY. iOS cannot be built from the Windows
/// checkout; the macOS CI lane is the gate.
final class MacroCameraSelectionTests: XCTestCase {

    func test_prefersTriple_overEverythingElse() {
        // Discovery hands devices back in ITS order, not ours. This is the case
        // that matters: wide-angle listed first, triple available.
        let available: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .builtInDualWideCamera,
            .builtInTripleCamera,
        ]
        let index = MacroCameraSelection.indexOfPreferred(among: available)
        XCTAssertEqual(index, 2)
        XCTAssertEqual(available[index!], .builtInTripleCamera)
    }

    func test_prefersDualWide_whenThereIsNoTriple() {
        let available: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .builtInDualWideCamera,
        ]
        let index = MacroCameraSelection.indexOfPreferred(among: available)
        XCTAssertEqual(available[index!], .builtInDualWideCamera)
    }

    func test_fallsBackToWideAngle_whichIsTodaysBehaviour() {
        // An older phone must degrade to exactly what it does now, not to an
        // error. This is the case that keeps the change safe to ship.
        let available: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        let index = MacroCameraSelection.indexOfPreferred(among: available)
        XCTAssertEqual(available[index!], .builtInWideAngleCamera)
    }

    func test_returnsNil_whenNothingIsRecognised() {
        // Nil rather than 0. Picking an arbitrary unknown device is worse than
        // letting the caller fall back deliberately, and the caller does.
        XCTAssertNil(MacroCameraSelection.indexOfPreferred(among: []))
        XCTAssertNil(
            MacroCameraSelection.indexOfPreferred(among: [.builtInTelephotoCamera])
        )
    }

    func test_wideAngleIsPresentAndLast() {
        // Pinned as its own case because both properties are load-bearing and
        // neither is obvious from reading the array. Present: it is the
        // universal fallback, and dropping it turns an older phone from "works
        // as before" into "no video device". Last: anything after it would be
        // unreachable, because every back camera reports wide-angle.
        XCTAssertEqual(MacroCameraSelection.preferredTypes.last, .builtInWideAngleCamera)
        XCTAssertEqual(
            MacroCameraSelection.preferredTypes.filter { $0 == .builtInWideAngleCamera }.count,
            1
        )
    }

    func test_preferenceOrderHasNoDuplicates() {
        // A duplicate would make the second entry dead and the order a lie.
        let types = MacroCameraSelection.preferredTypes
        XCTAssertEqual(Set(types).count, types.count)
    }

    // MARK: - Focus distance, for the AC1 guidance copy

    func test_focusDistance_convertsMillimetresToMetres() {
        // Unwrapped before the accuracy overload: XCTAssertEqual(_:_:accuracy:)
        // takes non-optional FloatingPoint, so passing the Float? straight in
        // does not compile.
        let metres = try? XCTUnwrap(MacroCameraSelection.focusDistanceMetres(120))
        XCTAssertNotNil(metres)
        XCTAssertEqual(metres ?? 0, 0.12, accuracy: 0.0001)
    }

    func test_focusDistance_refusesTheUnknownSentinel() {
        // AVFoundation reports -1 when it will not say. That is not a distance,
        // and letting it reach the copy would render "hold it -0.001 m away".
        XCTAssertNil(MacroCameraSelection.focusDistanceMetres(-1))
        XCTAssertNil(MacroCameraSelection.focusDistanceMetres(0))
        XCTAssertNil(MacroCameraSelection.focusDistanceMetres(.nan))
        XCTAssertNil(MacroCameraSelection.focusDistanceMetres(.infinity))
    }
}
