import XCTest
@testable import GradeThread

/// US-2504 AC2/AC4: the copy and the state rules the screen depends on.
@MainActor
final class WalkAroundGradeViewTests: XCTestCase {

    private func clip(
        bytes: Int = 12_000_000,
        durationSeconds: Double? = 20,
        format: String = "mov"
    ) -> WalkAroundClip {
        WalkAroundClip(
            url: URL(fileURLWithPath: "/tmp/a.mov"),
            bytes: bytes,
            durationSeconds: durationSeconds,
            format: format)
    }

    // The number that changes what a seller does is how long is LEFT. Elapsed
    // time is a fact about the past, and the cap is what they are working
    // against.
    func test_theTimerCountsDown() {
        XCTAssertEqual(WalkAroundGradeView.remainingText(elapsed: 0), "45s left")
        XCTAssertEqual(WalkAroundGradeView.remainingText(elapsed: 27), "18s left")
        // Never negative, however late the last tick lands.
        XCTAssertEqual(WalkAroundGradeView.remainingText(elapsed: 60), "0s left")
    }

    // "Not readable" rather than a dash or a zero. The server refuses a clip
    // whose length it cannot parse, so the review step is where that should be
    // met — not after the upload.
    func test_anUnreadableLengthSaysSoOnTheReviewStep() {
        XCTAssertEqual(WalkAroundGradeView.lengthText(nil), "Not readable")
        XCTAssertEqual(WalkAroundGradeView.lengthText(22.4), "22s")
    }

    func test_sizeReadsInTheUnitAPersonWouldUse() {
        XCTAssertEqual(WalkAroundGradeView.sizeText(12_000_000), "11.4 MB")
        XCTAssertEqual(WalkAroundGradeView.sizeText(2048), "2 KB")
        // Never "0 KB" for a file that exists.
        XCTAssertEqual(WalkAroundGradeView.sizeText(100), "1 KB")
    }

    // THE POINT OF HAVING A REVIEW STEP AT ALL. A clip that will be refused
    // says why HERE, rather than after the seller has spent a 40 MB upload
    // finding out.
    func test_theReviewFooterNamesTheRefusalBeforeTheUpload() {
        XCTAssertEqual(
            WalkAroundGradeView.reviewFooter(clip: clip(), photoPartCount: 2),
            "Video grading grades the clip's own frames, so photos can't be included too.")
        XCTAssertEqual(
            WalkAroundGradeView.reviewFooter(
                clip: clip(bytes: VideoGradingContract.maxBytes + 1), photoPartCount: 0),
            "That clip is too large (max 60 MB).")
        XCTAssertEqual(
            WalkAroundGradeView.reviewFooter(
                clip: clip(durationSeconds: 0), photoPartCount: 0),
            "That clip's length could not be read, so it can't be graded.")
    }

    // And when it looks fine, the footer promises the thing that makes trying
    // it safe — which is the server's guarantee, not the client's.
    func test_anAcceptableClipPromisesTheAbstainGuarantee() {
        let footer = WalkAroundGradeView.reviewFooter(clip: clip(), photoPartCount: 0)
        XCTAssertTrue(footer.contains("won't be charged"))
    }

    // An unreadable duration must NOT be refused locally: nil means the client
    // could not read it, and the server has its own rule. Refusing here would
    // block clips the server would have taken.
    func test_anUnreadableDurationStillOffersTheUpload() {
        let footer = WalkAroundGradeView.reviewFooter(
            clip: clip(durationSeconds: nil), photoPartCount: 0)
        XCTAssertTrue(footer.contains("won't be charged"))
    }

    func test_theHintChangesWhenRecordingStarts() {
        let idle = WalkAroundGradeView.captureHint(isRecording: false)
        let live = WalkAroundGradeView.captureHint(isRecording: true)
        XCTAssertNotEqual(idle, live)
        // The idle hint states the cap, because that is what a seller needs
        // before they start rather than after.
        XCTAssertTrue(idle.contains("45 seconds"))
        // The live hint tells them what to do with their hands.
        XCTAssertTrue(live.contains("slowly"))
    }

    // A "back" that abandoned a request mid-flight would leave the server
    // holding a submission the client has forgotten about, and the seller with
    // no way to reach it.
    func test_resetRefusesWhileBytesAreInFlight() async {
        let uploader = VideoGradeUploader(upload: { _, _, onProgress in
            onProgress(0.5)
            return .graded(submissionId: "s1")
        })
        // Drive it into a mid-flight state directly rather than racing a real
        // upload: the phase machine is what reset() reads.
        let observer = ResetObserver()
        let midFlight = VideoGradeUploader(upload: { _, _, onProgress in
            onProgress(0.5)
            observer.uploader?.reset()
            observer.phaseAfterReset = observer.uploader?.phase
            return .graded(submissionId: "s1")
        })
        observer.uploader = midFlight

        await midFlight.submit(
            clip: clip(), request: request(), photoPartCount: 0)

        XCTAssertEqual(observer.phaseAfterReset, .uploading(fraction: 0.5),
                       "reset must not abandon an upload in progress")

        // ...and it DOES work once the request is over.
        await uploader.submit(clip: clip(), request: request(), photoPartCount: 0)
        uploader.reset()
        XCTAssertEqual(uploader.phase, .idle)
    }

    private func request() -> VideoGradeRequest {
        VideoGradeRequest(
            garmentType: "jacket",
            garmentCategory: "outerwear",
            title: "Test",
            tier: "standard")
    }
}

@MainActor
private final class ResetObserver {
    weak var uploader: VideoGradeUploader?
    var phaseAfterReset: VideoGradeUploader.Phase?
}
