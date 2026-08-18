import XCTest
@testable import GradeThread

/// US-2504 AC3/AC4: the submit path and the progress it reports.
@MainActor
final class VideoGradeUploaderTests: XCTestCase {

    private func clip(
        bytes: Int = 12_000_000,
        durationSeconds: Double? = 20,
        format: String = "mov"
    ) -> WalkAroundClip {
        WalkAroundClip(
            url: URL(fileURLWithPath: "/tmp/walkaround-test.mov"),
            bytes: bytes,
            durationSeconds: durationSeconds,
            format: format)
    }

    private func request() -> VideoGradeRequest {
        VideoGradeRequest(
            garmentType: "jacket",
            garmentCategory: "outerwear",
            title: "Barbour Bedale",
            tier: "standard")
    }

    // MARK: - The refusal happens before the upload

    func test_aRefusedClipNeverStartsTheUpload() async {
        let calls = UploadCallBox()
        let uploader = VideoGradeUploader(upload: { _, _, _ in
            calls.count += 1
            return .graded(submissionId: "s1")
        })

        await uploader.submit(
            clip: clip(), request: request(), stagedPhotoCount: 3)

        XCTAssertEqual(calls.count, 0, "a 40 MB upload must not be spent on a known refusal")
        guard case .failed(let message) = uploader.phase else {
            return XCTFail("expected .failed, got \(uploader.phase)")
        }
        XCTAssertTrue(message.contains("photos can't be included"))
    }

    // MARK: - The phase machine

    // The phases have to be observed MID-FLIGHT, because by the time submit
    // returns it has moved to .finished. A box holding the uploader lets the
    // fake report progress and then read the phase that progress produced.
    func test_progressMovesThroughUploadingAndThenGrading() async {
        let observer = PhaseObserver()
        let uploader = VideoGradeUploader(upload: { _, _, onProgress in
            onProgress(0.25)
            observer.record()
            onProgress(0.75)
            observer.record()
            return .graded(submissionId: "s1")
        })
        observer.uploader = uploader

        await uploader.submit(clip: clip(), request: request(), stagedPhotoCount: 0)

        XCTAssertEqual(observer.seen, [
            .uploading(fraction: 0.25),
            .uploading(fraction: 0.75),
        ])
        XCTAssertEqual(uploader.phase, .finished(.graded(submissionId: "s1")))
    }

    // A retried body segment can report a lower cumulative count. A bar that
    // jumps backwards reads as a failure to somebody watching it.
    func test_progressNeverGoesBackwards() async {
        let observer = PhaseObserver()
        let uploader = VideoGradeUploader(upload: { _, _, onProgress in
            onProgress(0.8)
            observer.record()
            onProgress(0.3)
            observer.record()
            return .graded(submissionId: "s1")
        })
        observer.uploader = uploader

        await uploader.submit(clip: clip(), request: request(), stagedPhotoCount: 0)

        XCTAssertEqual(observer.seen, [
            .uploading(fraction: 0.8),
            .uploading(fraction: 0.8),
        ])
    }

    // ⚠ THE RULE AC4 EXISTS FOR. 100% uploaded is not 100% done: frame
    // extraction and grading run after the last byte, and the server sends
    // nothing for that phase. A client that stops at "100%" tells the seller
    // their grade is ready before the server has started.
    func test_atOneHundredPercentTheStateBecomesGradingNotDone() async {
        let observer = PhaseObserver()
        let uploader = VideoGradeUploader(upload: { _, _, onProgress in
            onProgress(1.0)
            observer.record()
            return .graded(submissionId: "s1")
        })
        observer.uploader = uploader

        await uploader.submit(clip: clip(), request: request(), stagedPhotoCount: 0)

        XCTAssertEqual(observer.seen, [.grading], "the last byte is not the last step")
        // And the copy for that phase says what is happening rather than
        // holding a number, because a bar parked at 100 with no words is
        // indistinguishable from a hang.
        XCTAssertEqual(
            VideoGradeUploader.statusText(for: .grading),
            "Sent. Reading the clip and grading - this takes a moment.")
        XCTAssertFalse(VideoGradeUploader.showsPercentage(for: .grading))
        XCTAssertTrue(VideoGradeUploader.showsPercentage(for: .uploading(fraction: 0.5)))
    }
    func test_theUploadPercentageIsRendered() {
        XCTAssertEqual(
            VideoGradeUploader.statusText(for: .uploading(fraction: 0.42)),
            "Sending your clip - 42%")
        XCTAssertEqual(
            VideoGradeUploader.statusText(for: .uploading(fraction: 0)),
            "Sending your clip - 0%")
    }

    // MARK: - The abstain case

    // Not an error. The clip was fine, it just did not show a required view, and
    // NOTHING WAS CHARGED. Recognised by the server's markers rather than by the
    // client deciding a clip was unusable.
    func test_theAbstainResponseIsReadAsNeedsPhotosAndNotAsAFailure() throws {
        let json = """
        {"submissionId":"sub-1","status":"needs_photos",
         "videoGrading":{"ok":false,"reason":"No clear view of the label."},
         "photo_requests":["label","back"],
         "payment":{"paid":false,"charged":false}}
        """
        let outcome = try VideoGradeUploadService.outcome(from: Data(json.utf8))
        XCTAssertEqual(
            outcome,
            .needsPhotos(
                submissionId: "sub-1",
                reason: "No clear view of the label.",
                requested: ["label", "back"]))
    }

    // Both markers are required. A needs_photos that WAS charged is not the
    // abstain guarantee and must not be reported as one — that would tell a
    // seller they were not billed when they were.
    func test_needsPhotosThatWasChargedIsNotTheAbstainCase() throws {
        let json = """
        {"submissionId":"sub-2","status":"needs_photos",
         "payment":{"paid":true,"charged":true}}
        """
        let outcome = try VideoGradeUploadService.outcome(from: Data(json.utf8))
        XCTAssertEqual(outcome, .graded(submissionId: "sub-2"))
    }

    func test_anOrdinaryGradeReadsAsGraded() throws {
        let json = #"{"submissionId":"sub-3","status":"processing"}"#
        XCTAssertEqual(
            try VideoGradeUploadService.outcome(from: Data(json.utf8)),
            .graded(submissionId: "sub-3"))
    }

    func test_bothIdSpellingsAreAccepted() throws {
        // The route sends camelCase on every path I read; snake_case is a
        // DEFENSIVE fallback, not an observed variance. Pinned so the
        // tolerance is deliberate rather than accidental.
        XCTAssertEqual(
            try VideoGradeUploadService.outcome(from: Data(#"{"submission_id":"snake"}"#.utf8)),
            .graded(submissionId: "snake"))
        XCTAssertEqual(
            try VideoGradeUploadService.outcome(from: Data(#"{"submissionId":"camel"}"#.utf8)),
            .graded(submissionId: "camel"))
    }

    // An empty submission id flowing forward produces a "graded" result that
    // points at nothing, which is worse than an error: the seller is told the
    // grade worked and there is nothing to open.
    func test_aResponseWithNoIdFailsRatherThanReturningAnEmptyOne() {
        XCTAssertThrowsError(
            try VideoGradeUploadService.outcome(from: Data(#"{"status":"processing"}"#.utf8)))
        XCTAssertThrowsError(
            try VideoGradeUploadService.outcome(from: Data(#"{"submissionId":""}"#.utf8)))
    }

    // MARK: - The multipart fields

    func test_theFieldsCarryTheContractsNamesAndTheOptIn() {
        let fields = VideoGradeUploadService.fields(for: request())
        let byName = Dictionary(uniqueKeysWithValues: fields)

        XCTAssertEqual(byName[VideoGradingContract.videoGradingField],
                       VideoGradingContract.videoGradingOptIn)
        XCTAssertEqual(byName[VideoGradingContract.videoCaptureSourceField],
                       VideoGradingContract.captureSourceInAppRecorder)
        XCTAssertEqual(byName["garment_type"], "jacket")
        XCTAssertEqual(byName["tier"], "standard")
    }

    // The server refuses photos alongside a clip and the refusal arrives after
    // the upload. This client must never build a body that could earn it.
    func test_noImagePartIsEverIncluded() {
        var withEverything = request()
        withEverything.brand = "Barbour"
        withEverything.description = "Waxed cotton"
        withEverything.closetItemId = "closet-1"
        let names = VideoGradeUploadService.fields(for: withEverything).map(\.0)

        XCTAssertFalse(names.contains("images"))
        XCTAssertFalse(names.contains("image_types"))
        XCTAssertFalse(names.contains("original_images"))
        XCTAssertTrue(names.contains("closet_item_id"))
    }

    // Empty optionals are omitted rather than sent blank. A blank brand is not
    // the same request as no brand, and the server reads them differently.
    func test_emptyOptionalsAreOmittedRatherThanSentBlank() {
        var blank = request()
        blank.brand = ""
        blank.description = "   "
        blank.closetItemId = ""
        let names = VideoGradeUploadService.fields(for: blank).map(\.0)

        XCTAssertFalse(names.contains("brand"))
        XCTAssertFalse(names.contains("closet_item_id"))
        // A whitespace-only description IS sent, because trimming it here would
        // be a second opinion about content the server owns.
        XCTAssertTrue(names.contains("description"))
    }

    // Sent explicitly false rather than omitted. The server re-checks either
    // way, but leaving them out puts the request's meaning at the mercy of a
    // default that could change server-side without this client knowing.
    func test_theOptInsAreSentExplicitly() {
        let byName = Dictionary(
            uniqueKeysWithValues: VideoGradeUploadService.fields(for: request()))
        XCTAssertEqual(byName["verified_capture_opt_in"], "false")
        XCTAssertEqual(byName["authenticity_addon"], "false")
    }
}

@MainActor
private final class UploadCallBox {
    var count = 0
}

/// Holds the uploader so a fake upload closure can read the phase its own
/// progress callback just produced.
@MainActor
private final class PhaseObserver {
    weak var uploader: VideoGradeUploader?
    private(set) var seen: [VideoGradeUploader.Phase] = []
    func record() { if let phase = uploader?.phase { seen.append(phase) } }
}
