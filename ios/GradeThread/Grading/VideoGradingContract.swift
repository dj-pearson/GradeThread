import Foundation

// US-2504 AC2: the multipart contract for grading from a walk-around clip, on
// the iOS side.
//
// src/lib/video-grading-contract.ts exists so a second client has a spec to
// implement rather than a page to reverse-engineer. This is that client, and
// this file is the Swift half of the spec.
//
// The mirror is TESTED, not trusted: src/test/video-grading-ios-parity.test.ts
// imports the TypeScript contract, parses this file, and fails on any drift in
// a field name, a cap, a format or a rejection sentence. Two hand-kept copies of
// a wire contract is how the second client breaks silently — the whole reason
// the TypeScript file was written.

enum VideoGradingContract {

    // MARK: - Multipart field names

    /// The clip itself.
    static let videoField = "video"

    /// "Grade FROM this clip", not "attach one as evidence". The server compares
    /// against the exact string below, so "1" and "TRUE" do NOT opt in.
    static let videoGradingField = "video_grading"
    static let videoGradingOptIn = "true"

    /// Optional guided-capture marks. JSON, and never trusted — the server bounds
    /// them against the clip's real duration, so a client cannot claim a view it
    /// did not record.
    static let videoSlotMarksField = "video_slot_marks"

    /// How the clip entered the app. Positive-only provenance: anything the
    /// server does not recognise normalises to null rather than to a claim.
    static let videoCaptureSourceField = "video_capture_source"
    static let captureSourceInAppRecorder = "in_app_recorder"
    static let captureSourceLibrary = "library"

    // MARK: - What the route accepts

    /// ⚠ THESE ARE THE ROUTE'S NUMBERS, NOT THE VALIDATION LIBRARY'S, and they
    /// differ. lib/video-validation.ts defaults to 100 MB / 60s; routes/grade.ts
    /// passes stricter caps. A recorder built by reading the validator produces
    /// clips rejected at sizes the validator calls fine — after the whole upload.
    static let maxBytes = 60 * 1024 * 1024

    static let maxDurationSeconds = 45.0

    /// Detected from MAGIC BYTES server-side, so naming a file .mp4 does not make
    /// it one. AVFoundation writes .mov by default, which is on the list.
    static let formats = ["mp4", "mov", "webm"]

    /// The clip's duration must be READABLE from the container. The frame plan
    /// samples by timestamp, so an unparseable length gives the server nowhere to
    /// look, and it is refused before a submission row or a charge exists.
    static let durationMustBeReadable = true

    /// Photos and a clip in one submission are REFUSED, and this is the rule a
    /// second client is most likely to break: the natural iOS flow is additive.
    /// Choosing video must CLEAR staged photos, and choosing photos must clear
    /// the clip. It is a mode, not an addition.
    static let excludesPhotos = true

    /// ⚠ 100% UPLOADED IS NOT 100% DONE. Frame extraction and grading run after
    /// the last byte and the server sends no progress for that phase. A client
    /// that dismisses at 100 tells the seller their grade is ready before the
    /// server has started. Determinate bar to 100, then an indeterminate
    /// "grading" state until the response arrives.
    static let uploadCompleteIsNotGraded = true

    // MARK: - The abstain case

    /// A clip that yielded no usable required view lands here, unpaid.
    ///
    /// The guarantee is the SERVER'S: failVideoGrading returns before payment
    /// precedence runs and refunds a meter debit taken at the gate. This client
    /// inherits it and MUST NOT reimplement it — a client-side "do not charge" is
    /// not a guarantee at all.
    static let abstainStatus = "needs_photos"

    // MARK: - Pre-upload refusal

    /// Why a clip would be refused, or nil if it looks acceptable. A port of
    /// `videoSubmitRejection`, in the same ORDER as the server checks — the photo
    /// conflict comes first because it is the one thing the seller can fix
    /// without re-recording.
    ///
    /// `durationSeconds` nil means the client could not read it, which is NOT the
    /// same as knowing it is bad. That passes through to the server rather than
    /// being guessed at, because guessing would block clips the server would have
    /// taken.
    static func rejection(
        bytes: Int,
        durationSeconds: Double?,
        format: String,
        stagedPhotoCount: Int
    ) -> String? {
        if stagedPhotoCount > 0 {
            return "Video grading grades the clip's own frames, so photos can't be included too."
        }
        if bytes <= 0 { return "That clip is empty." }
        if bytes > maxBytes {
            return "That clip is too large (max \(maxBytes / (1024 * 1024)) MB)."
        }
        if !formats.contains(format) {
            return "That video format can't be graded."
        }
        if let durationSeconds, !(durationSeconds > 0) {
            return "That clip's length could not be read, so it can't be graded."
        }
        if let durationSeconds, durationSeconds > maxDurationSeconds {
            return "That clip is too long (max \(Int(maxDurationSeconds)) seconds)."
        }
        return nil
    }
}
