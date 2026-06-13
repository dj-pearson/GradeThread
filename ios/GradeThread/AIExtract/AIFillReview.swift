import Foundation
import Observation

/// One field the intake auto-applied to the item from a high-confidence AI
/// suggestion. Carries the prior column value so an undo can restore it.
struct AppliedAIField: Identifiable, Equatable {
    var id: String { field }
    let field: String
    let value: String
    /// Value the column held immediately before the AI fill — restored on undo.
    let previousValue: String?
    let confidence: Double
    let source: String

    /// "garment_category" → "Garment Category".
    var displayLabel: String {
        field
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

/// The result of an AI auto-fill, handed off from intake to the item canvas so
/// the user gets a reversible "AI filled N fields — review" entry point instead
/// of a blocking confirm screen (US-686).
struct AIFillReview: Equatable {
    let itemId: String
    /// High-confidence (>=0.8) fields written automatically.
    var applied: [AppliedAIField]
    /// Low-confidence suggestions surfaced for opt-in — never auto-applied.
    var lowConfidence: [FieldSuggestionEntry]
    /// Estimated measurements (empty when none were returned).
    var measurements: [AIExtractStore.Measurement]
    /// Whether the measurements above were auto-applied.
    var measurementsApplied: Bool
    var conditionSummary: String?
    /// True when on-device OCR (Live Text, US-177) produced the suggestions.
    var usedLiveTextFallback: Bool

    /// Count shown in the entry point — applied fields plus applied measurements.
    var appliedCount: Int {
        applied.count + (measurementsApplied ? measurements.count : 0)
    }

    /// Nothing to show once everything's been reviewed away.
    var hasSomethingToReview: Bool {
        !applied.isEmpty || !lowConfidence.isEmpty || measurementsApplied
    }

    /// Canvas entry-point label. Reads "AI filled N fields — review" when
    /// something was auto-applied, else nudges toward the opt-in suggestions.
    var entryPointLabel: String {
        if appliedCount > 0 {
            return "AI filled \(appliedCount) field\(appliedCount == 1 ? "" : "s") — review"
        }
        if !lowConfidence.isEmpty {
            return "AI has \(lowConfidence.count) suggestion\(lowConfidence.count == 1 ? "" : "s") — review"
        }
        return "Review AI suggestions"
    }
}

/// In-memory hand-off of post-intake AI fills, keyed by item id. The intake
/// registers a review after auto-applying; the item canvas reads it to show the
/// reversible review entry point. Transient by design — it doesn't survive an
/// app restart, matching its "just landed on the item" lifetime.
@MainActor
@Observable
final class AIFillReviewStore {
    static let shared = AIFillReviewStore()
    private init() {}

    private(set) var reviews: [String: AIFillReview] = [:]

    func register(_ review: AIFillReview) {
        reviews[review.itemId] = review
    }

    func review(for itemId: String) -> AIFillReview? {
        reviews[itemId]
    }

    /// Replaces the stored review (e.g. after the user opts into a low-confidence
    /// suggestion or reverts a field on the canvas).
    func update(_ review: AIFillReview) {
        reviews[review.itemId] = review
    }

    func clear(for itemId: String) {
        reviews[itemId] = nil
    }
}
