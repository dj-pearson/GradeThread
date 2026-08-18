import AVFoundation
import XCTest
@testable import GradeThread

/// US-2504 AC2: the client half of the walk-around contract.
final class VideoGradingContractTests: XCTestCase {

    // The trap the TypeScript contract calls out in capitals: lib/video-validation
    // defaults to 100 MB / 60s and routes/grade.ts is stricter. A recorder built
    // to the looser numbers produces clips refused AFTER the whole upload.
    func test_theCapsAreTheRoutesNotTheValidationLibrarys() {
        XCTAssertEqual(VideoGradingContract.maxBytes, 60 * 1024 * 1024)
        XCTAssertEqual(VideoGradingContract.maxDurationSeconds, 45)
        XCTAssertNotEqual(VideoGradingContract.maxBytes, 100 * 1024 * 1024)
        XCTAssertNotEqual(VideoGradingContract.maxDurationSeconds, 60)
    }

    // The photo conflict is checked FIRST because it is the only refusal the
    // seller can act on without re-recording. Order is behaviour here, not style.
    func test_thePhotoConflictIsReportedBeforeAnythingElse() {
        let message = VideoGradingContract.rejection(
            bytes: 0,                       // also empty
            durationSeconds: 900,           // also far too long
            format: "avi",                  // also the wrong container
            stagedPhotoCount: 3)
        XCTAssertEqual(
            message,
            "Video grading grades the clip's own frames, so photos can't be included too.")
    }

    func test_eachRefusalHasItsOwnSentence() {
        XCTAssertEqual(
            VideoGradingContract.rejection(
                bytes: 0, durationSeconds: 5, format: "mov", stagedPhotoCount: 0),
            "That clip is empty.")
        XCTAssertEqual(
            VideoGradingContract.rejection(
                bytes: VideoGradingContract.maxBytes + 1,
                durationSeconds: 5, format: "mov", stagedPhotoCount: 0),
            "That clip is too large (max 60 MB).")
        XCTAssertEqual(
            VideoGradingContract.rejection(
                bytes: 10, durationSeconds: 5, format: "avi", stagedPhotoCount: 0),
            "That video format can't be graded.")
        XCTAssertEqual(
            VideoGradingContract.rejection(
                bytes: 10, durationSeconds: 46, format: "mov", stagedPhotoCount: 0),
            "That clip is too long (max 45 seconds).")
    }

    // THE ONE THAT IS EASY TO GET WRONG. nil means "the client could not read the
    // length", which is NOT the same as knowing it is bad. Refusing it here would
    // block clips the server would have accepted; the server has its own rule and
    // it is the one that counts.
    func test_anUnreadableDurationIsPassedThroughRatherThanGuessedAt() {
        XCTAssertNil(VideoGradingContract.rejection(
            bytes: 10, durationSeconds: nil, format: "mov", stagedPhotoCount: 0))
        // A duration we DID read and that is zero is a different fact, and is
        // refused.
        XCTAssertNotNil(VideoGradingContract.rejection(
            bytes: 10, durationSeconds: 0, format: "mov", stagedPhotoCount: 0))
    }

    func test_aGoodClipIsAccepted() {
        XCTAssertNil(VideoGradingContract.rejection(
            bytes: 12_000_000, durationSeconds: 22, format: "mov", stagedPhotoCount: 0))
        // The boundary values themselves are fine; only past them is not.
        XCTAssertNil(VideoGradingContract.rejection(
            bytes: VideoGradingContract.maxBytes,
            durationSeconds: VideoGradingContract.maxDurationSeconds,
            format: "mp4", stagedPhotoCount: 0))
    }

    // AVFoundation writes .mov by default. If that ever stopped being an accepted
    // container, every clip this recorder produces would be refused.
    func test_theRecordersOwnContainerIsOneTheServerAccepts() {
        let url = URL(fileURLWithPath: "/tmp/walkaround-abc.mov")
        XCTAssertTrue(VideoGradingContract.formats.contains(WalkAroundRecorder.format(for: url)))
    }

    func test_formatIsLowercasedAndUnknownExtensionsPassThrough() {
        XCTAssertEqual(
            WalkAroundRecorder.format(for: URL(fileURLWithPath: "/tmp/a.MOV")), "mov")
        // Not normalised to a guess: the rejection message should name what was
        // actually seen.
        XCTAssertEqual(
            WalkAroundRecorder.format(for: URL(fileURLWithPath: "/tmp/a.avi")), "avi")
    }

    func test_anUnreadableFileMeasuresAsEmptyRatherThanCrashing() {
        let missing = URL(fileURLWithPath: "/tmp/definitely-not-here-\(UUID().uuidString).mov")
        XCTAssertEqual(WalkAroundRecorder.byteSize(of: missing), 0)
        // 0 bytes is refused as "empty", which is the right answer for a file we
        // cannot read either way.
        XCTAssertEqual(
            VideoGradingContract.rejection(
                bytes: WalkAroundRecorder.byteSize(of: missing),
                durationSeconds: nil, format: "mov", stagedPhotoCount: 0),
            "That clip is empty.")
    }

    func test_anUnreadableAssetReportsNoDurationRatherThanZero() async {
        let missing = URL(fileURLWithPath: "/tmp/definitely-not-here-\(UUID().uuidString).mov")
        let duration = await WalkAroundRecorder.duration(of: missing)
        // nil, NOT 0. Zero would be refused locally as unreadable-length; nil
        // lets the server decide, which is the documented behaviour.
        XCTAssertNil(duration)
    }

    // Provenance is positive-only server-side: anything unrecognised normalises
    // to null rather than to a claim. A typo here does not read as "recorded
    // live" — it silently drops the claim the recorder exists to make.
    func test_theCaptureSourceIsTheRecordersOwn() {
        let clip = WalkAroundClip(
            url: URL(fileURLWithPath: "/tmp/a.mov"),
            bytes: 10, durationSeconds: 5, format: "mov")
        XCTAssertEqual(clip.captureSource, "in_app_recorder")
        XCTAssertEqual(clip.captureSource, VideoGradingContract.captureSourceInAppRecorder)
        XCTAssertNotEqual(clip.captureSource, VideoGradingContract.captureSourceLibrary)
    }

    func test_theOptInIsTheExactStringTheServerCompares() {
        // "1", "TRUE" and true-ish values do NOT opt in.
        XCTAssertEqual(VideoGradingContract.videoGradingOptIn, "true")
    }
}
