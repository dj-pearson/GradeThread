import Foundation

/// US-1209: the optimistic "stamp a completed grade onto the cached item" rule,
/// extracted from ``GradeRequestSheet`` so the confidence gate is unit-testable
/// against a real ``LocalInventoryItem`` (the view method that owns SwiftData
/// save + the sync nudge stays thin).
///
/// A low-confidence grade (< ``GradeScale/gradeReviewConfidenceThreshold``) is
/// routed to a human reviewer server-side, so it is NOT a certified, shareable
/// result yet. We still surface the score/tier so the report can render the
/// "flagged for human review" copy, but we hold back the certificate URL and
/// the "graded" status until review clears — so the same item can't
/// simultaneously read as "Pending review" and "Certified". The server merge is
/// authoritative (``SyncMergeActor``): it likewise won't supply a
/// `certificate_url` / `status = graded` for an unreviewed grade, so the next
/// pull keeps the provisional state until the review lands.
enum GradeApplication {
    /// Pre-grade stages that a high-confidence grade advances to "graded".
    /// A provisional grade leaves the status untouched.
    private static let stampableStatuses: Set<String> = ["cataloged", "photographed", "measured"]

    /// Mutate `item` to mirror a freshly completed grade, applying the
    /// confidence gate. Does NOT persist — the caller owns the save.
    static func stamp(_ report: GradeReportDTO, certificateURL: URL?, onto item: LocalInventoryItem) {
        let pendingReview = GradeScale.requiresReview(confidence: report.confidenceScore)
        item.gradeValue = report.overallScore
        item.gradeLabel = report.gradeTier
        if pendingReview {
            // Hold back the shareable certificate until a reviewer clears it.
            item.certificateURL = nil
        } else if let certificateURL {
            item.certificateURL = certificateURL.absoluteString
        }
        // Only stamp the certified "graded" status for a high-confidence grade;
        // a provisional grade stays in its pre-grade stage until review clears.
        if !pendingReview, stampableStatuses.contains(item.status) {
            item.status = "graded"
        }
        item.updatedAt = .now
    }
}
