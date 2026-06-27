import XCTest
@testable import GradeThread

/// US-1230: dictation reliability — the final transcription segment must land
/// in Notes, and stop() must be safe to call repeatedly.
@MainActor
final class SpeechDictationTests: XCTestCase {

    // MARK: - Final-segment merge (the behavior that dropped the last words)

    func test_mergedDictationNotes_emptyAnchor_usesTranscriptVerbatim() {
        XCTAssertEqual(
            DetailsIntakeView.mergedDictationNotes(anchor: "", transcript: "small moth hole"),
            "small moth hole")
    }

    func test_mergedDictationNotes_extendsExistingNotesWithSpace() {
        XCTAssertEqual(
            DetailsIntakeView.mergedDictationNotes(anchor: "Light wear", transcript: "on the cuffs"),
            "Light wear on the cuffs")
    }

    func test_mergedDictationNotes_doesNotDoubleSpace() {
        // Anchor already ends in a space → no extra separator inserted.
        XCTAssertEqual(
            DetailsIntakeView.mergedDictationNotes(anchor: "Light wear ", transcript: "on the cuffs"),
            "Light wear on the cuffs")
    }

    func test_mergedDictationNotes_finalSegmentReplacesPartialIdempotently() {
        // The live partial and the final result are both merged against the SAME
        // anchor, so applying the final value after the last partial yields the
        // corrected note — never an appended duplicate (US-1230 final-segment fix).
        let anchor = "Brand new"
        let partial = DetailsIntakeView.mergedDictationNotes(anchor: anchor, transcript: "with tag")
        let final = DetailsIntakeView.mergedDictationNotes(anchor: anchor, transcript: "with tags")
        XCTAssertEqual(partial, "Brand new with tag")
        XCTAssertEqual(final, "Brand new with tags")
    }

    // MARK: - stop() idempotency

    func test_stop_isIdempotent_whenNeverStarted() {
        let dictation = SpeechDictation()
        // Calling stop() before any session was activated must be a safe no-op:
        // it must not remove a tap that was never installed nor deactivate a
        // shared audio session this instance never activated.
        dictation.stop()
        dictation.stop()
        XCTAssertFalse(dictation.isRecording)
        XCTAssertNil(dictation.finalizedText)
    }

    func test_reset_clearsRecognizedAndFinalizedText() {
        let dictation = SpeechDictation()
        dictation.reset()
        XCTAssertEqual(dictation.recognizedText, "")
        XCTAssertNil(dictation.finalizedText)
        XCTAssertFalse(dictation.isRecording)
    }
}
