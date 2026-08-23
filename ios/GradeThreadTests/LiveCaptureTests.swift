import XCTest
@testable import GradeThread

/// US-2802: Live Capture on iOS.
///
/// The badge claims the app WATCHED the photo being taken, so it is only as
/// good as the bookkeeping behind it. These cover the two ways that goes wrong
/// quietly: claiming the tier for a photo nobody watched, and losing it for one
/// we did.
///
/// The Android twin of this file is
/// `android/app/src/test/java/com/gradethread/app/grading/LiveCaptureTest.kt`.
/// Its sabotage run is why the source STRING is pinned in
/// `src/test/native-photo-grade-contract-parity.test.ts` instead of here:
/// every Kotlin case referenced the constant symbolically, so changing its
/// value to the video tier's string left all of them green while the server -
/// which compares against its own literal - would have called every submission
/// not-live. A test that names the constant cannot catch the constant moving.
final class LiveCaptureTests: XCTestCase {

    private let camera = PhotoGradeContract.captureSourceInAppCamera
    private let library = PhotoGradeContract.captureSourceLibrary

    private func image(_ type: String, _ from: String) -> PhotoGradeImage {
        PhotoGradeImage(gradingType: type, jpeg: Data([0xFF]), captureSource: from)
    }

    // MARK: - The derivation

    func testEveryPhotoTakenInAppQualifies() {
        XCTAssertTrue(
            PhotoGradeContract.qualifiesForLiveCapture([camera, camera, camera])
        )
    }

    func testOneLibraryPhotoLosesItForTheWholeSubmission() {
        // The claim is about the SET. A single added photo makes "every photo
        // was taken here" false, and the route rejects the combination outright
        // rather than quietly downgrading it.
        XCTAssertFalse(
            PhotoGradeContract.qualifiesForLiveCapture([camera, camera, library])
        )
    }

    func testAnEmptySetIsNotLive_thoughAllSatisfyWouldSayItIs() {
        // `allSatisfy` is vacuously true on an empty collection. A submission
        // with no photos at all claiming the strongest provenance tier there is
        // is exactly the vacuous pass this refuses.
        XCTAssertFalse(PhotoGradeContract.qualifiesForLiveCapture([]))
    }

    // MARK: - What goes on the wire

    func testTheOptInIsSentOnlyWhenEarned() {
        let live = PhotoGradeFields.liveCaptureFields(for: [
            image("front", camera),
            image("back", camera),
            image("label", camera),
        ])
        XCTAssertEqual(live.count, 1)
        XCTAssertEqual(live.first?.0, PhotoGradeContract.liveCaptureOptInField)
        XCTAssertEqual(live.first?.1, "true")

        let mixed = PhotoGradeFields.liveCaptureFields(for: [
            image("front", camera),
            image("back", library),
            image("label", camera),
        ])
        XCTAssertTrue(
            mixed.isEmpty,
            "a mixed set claimed the tier, which the route rejects outright"
        )
    }

    func testTheOptInIsAbsentRatherThanFalse() {
        // Not "false": the field is omitted entirely when unearned, so a
        // submission that does not opt in is byte-identical to one sent before
        // this existed. US-2802 AC4 asks for exactly that.
        let names = PhotoGradeFields.liveCaptureFields(for: [image("front", library)])
            .map { $0.0 }
        XCTAssertFalse(names.contains(PhotoGradeContract.liveCaptureOptInField))
    }

    func testTheSourceDefaultsToLibrary_failingClosed() {
        // An origin nobody recorded must not be reported as live. The opposite
        // default hands out the strongest provenance badge on a bookkeeping
        // slip, and every caller that predates this picks the default up
        // without saying anything.
        let implicit = PhotoGradeImage(gradingType: "front", jpeg: Data([0xFF]))
        XCTAssertEqual(implicit.captureSource, library)
    }

    // MARK: - The two fields are a pair

    func testTheOptInAloneEarnsNothing_soBothTravelTogether() {
        // The server needs the opt-in AND a per-image source; either alone
        // earns nothing. The per-image half is written inside the multipart
        // body's image loop, which is private, so the assertion that it stays
        // in THAT loop lives in the parity test named in this file's header.
        // What is checkable here is that the opt-in is derived from the same
        // sources the loop writes.
        let sources = [camera, camera, library]
        let images = zip(["front", "back", "label"], sources).map { image($0.0, $0.1) }
        XCTAssertEqual(images.map(\.captureSource), sources)
        XCTAssertEqual(
            PhotoGradeFields.liveCaptureFields(for: images).isEmpty,
            !PhotoGradeContract.qualifiesForLiveCapture(images.map(\.captureSource))
        )
    }
}
