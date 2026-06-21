import Foundation
import Observation

/// One field the intake auto-applied to the item from a high-confidence AI
/// suggestion. Carries the prior column value so an undo can restore it.
struct AppliedAIField: Identifiable, Equatable, Codable {
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
struct AIFillReview: Equatable, Codable {
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

/// Hand-off of post-intake AI fills, keyed by item id. The intake registers a
/// review after auto-applying; the item canvas reads it to show the reversible
/// review entry point.
///
/// US-1171: persisted to disk (a small per-item JSON file under Application
/// Support) so the review + undo survive an app restart or a lost
/// `inventoryPullRequested` deep-link race — previously it was in-memory only
/// and the review (with its undo + low-confidence opt-ins) silently vanished if
/// the app was killed before the user tapped the canvas entry point.
@MainActor
@Observable
final class AIFillReviewStore {
    static let shared = AIFillReviewStore()
    private init() {
        reviews = Self.loadAllFromDisk()
    }

    private(set) var reviews: [String: AIFillReview] = [:]

    func register(_ review: AIFillReview) {
        reviews[review.itemId] = review
        Self.persist(review)
    }

    func review(for itemId: String) -> AIFillReview? {
        reviews[itemId]
    }

    /// Replaces the stored review (e.g. after the user opts into a low-confidence
    /// suggestion or reverts a field on the canvas).
    func update(_ review: AIFillReview) {
        reviews[review.itemId] = review
        Self.persist(review)
    }

    func clear(for itemId: String) {
        reviews[itemId] = nil
        Self.deleteFromDisk(itemId)
    }

    // MARK: - Disk persistence (US-1171)

    private static var directory: URL? {
        guard let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("ai-fill-reviews", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// item ids are UUID strings, so they're safe, collision-free filenames.
    private static func fileURL(_ itemId: String) -> URL? {
        directory?.appendingPathComponent("\(itemId).json")
    }

    private static func persist(_ review: AIFillReview) {
        guard let url = fileURL(review.itemId),
              let data = try? JSONEncoder().encode(review) else { return }
        // The payload can carry extracted field values, so protect it at rest.
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func deleteFromDisk(_ itemId: String) {
        guard let url = fileURL(itemId) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private static func loadAllFromDisk() -> [String: AIFillReview] {
        guard let dir = directory,
              let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { return [:] }
        var result: [String: AIFillReview] = [:]
        let decoder = JSONDecoder()
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let review = try? decoder.decode(AIFillReview.self, from: data) else { continue }
            result[review.itemId] = review
        }
        return result
    }
}
