import Foundation

/// US-2016 — polling `GET /api/grade/status/:id` for a consumer grade.
///
/// THIS IS WHERE AN ABSTAIN SURFACES ON THE PHOTO PATH. The image-quality gate
/// runs inside the grading pipeline rather than at submit, so a submission
/// missing a usable required shot comes back here as `needs_photos` carrying
/// `quality_feedback`. The video path abstains at submit instead; copying its
/// shape onto this one was my first draft and would have read a field the route
/// never sends here.
struct PhotoGradeStatus: Decodable, Equatable {
    let id: String
    let status: String
    let payment_status: String?
    let quality_feedback: QualityFeedback?

    /// Written by the pipeline when the gate abstains (grading-pipeline.ts).
    /// Null on every other status, so its presence IS the signal.
    struct QualityFeedback: Decodable, Equatable {
        /// One line describing why grading stopped.
        let summary: String?
        /// ALREADY de-duplicated and user-facing: the gate turns its issues into
        /// asks a person can act on. Show these. Re-deriving copy from `issues`
        /// would be building worse sentences out of better data.
        let photo_requests: [String]?
        let issues: [Issue]?

        struct Issue: Decodable, Equatable {
            let image_type: String?
            let problem: String?
            /// `block` caused the abstain; `warn` is surfaced and the grade
            /// still proceeds. Treating them alike tells someone to retake a
            /// photo that was fine.
            let severity: String?
            let message: String?
        }
    }

    /// Terminal from the caller's point of view: nothing here changes without
    /// the user doing something.
    var isTerminal: Bool { PhotoGradeStatusRules.terminalStatuses.contains(status) }

    /// The grade landed and there is a certificate to show.
    var isGraded: Bool { status == "completed" }

    /// The gate abstained. NOT a failure - nothing was charged for a grade that
    /// did not happen, and the user is told which shot to retake.
    var needsPhotos: Bool { status == "needs_photos" }
}

enum PhotoGradeStatusRules {
    /// Statuses that will not change on their own.
    ///
    /// `pending_review` is deliberately NOT terminal: a sub-0.75 confidence
    /// grade goes to a human and does move afterwards, so polling must continue
    /// or the user sits on a spinner that has stopped meaning anything.
    /// Taken from `SubmissionStatus` in src/types/database.ts, which is the
    /// canonical set. My first draft invented `refunded`, `grading` and
    /// `pending_payment` and missed `disputed` and `pending` - `grading` is real
    /// but belongs to the flipdesk_grading_submissions BRIDGE row, not to
    /// `submissions.status`, which is what this endpoint returns.
    static let terminalStatuses: Set<String> = [
        "completed", "needs_photos", "failed", "expired", "disputed",
    ]

    /// What to say while it works. One vision call per image means tens of
    /// seconds, and a screen with no words on it reads as a hang.
    static func waitingText(for status: String) -> String {
        switch status {
        case "pending": return "Getting your photos ready…"
        case "processing": return "Grading your photos…"
        case "pending_review": return "A grader is double-checking this one…"
        default: return "Working…"
        }
    }

    /// What to show when the gate abstained.
    ///
    /// The server's own `photo_requests` FIRST and unaltered - it wrote them for
    /// this screen. The summary is the fallback for an older pipeline that sent
    /// one without the other, and the generic line is the last resort so the
    /// screen is never blank on a terminal state.
    static func retakeMessages(_ feedback: PhotoGradeStatus.QualityFeedback?) -> [String] {
        if let requests = feedback?.photo_requests, !requests.isEmpty { return requests }
        if let summary = feedback?.summary, !summary.isEmpty { return [summary] }
        return ["Those photos weren't clear enough to grade. Retake them in better light."]
    }

    /// The slots to retake, in the user's words rather than the route's.
    ///
    /// BLOCKING issues only. A `warn` did not stop the grade, and listing it
    /// beside the blockers tells someone to redo a photo that was accepted.
    /// The route names image types (`label`) and the capture strip names slots
    /// (`tag`), so the names are translated - the same split the submit
    /// contract crosses in the other direction.
    static func blockingSlots(_ feedback: PhotoGradeStatus.QualityFeedback?) -> [String] {
        guard let issues = feedback?.issues else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for issue in issues where issue.severity == "block" {
            guard let type = issue.image_type, !type.isEmpty else { continue }
            let name = PhotoGradeCopy.friendlyName(type)
            if seen.insert(name).inserted { out.append(name) }
        }
        return out
    }

    /// Poll spacing. Tight at first because an already-graded submission answers
    /// immediately, then backing off so a slow grade does not hammer the route.
    /// Capped, so a watching user never waits longer than this between updates.
    static func nextDelaySeconds(attempt: Int) -> Double {
        min(1.5 * pow(1.5, Double(max(0, attempt))), 8)
    }
}
