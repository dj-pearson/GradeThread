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
    /// US-822: the eBay category + item-specifics the server resolved AND
    /// persisted onto the item during the extract pass. Display-only in the
    /// review (the specifics editor reads the saved values) — it just makes the
    /// "selected eBay category / required info" visible right after intake.
    struct EbaySummary: Equatable, Codable {
        let categoryId: String
        let categoryPath: String?
        /// Number of item-specifics (aspects) filled for this category.
        let filledAspectCount: Int

        /// Leaf category name from the tree path (eBay paths are delimited by
        /// '>' or '|'); falls back to the raw path, then the id.
        var displayName: String {
            guard let path = categoryPath?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !path.isEmpty else {
                return "eBay category \(categoryId)"
            }
            let leaf = path
                .components(separatedBy: CharacterSet(charactersIn: ">|"))
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .last { !$0.isEmpty }
            return leaf ?? path
        }

        /// nil when the server skipped/failed the eBay phase (no category
        /// resolvable, AI budget exhausted, taxonomy hiccup, or an older build).
        init?(from block: AIExtractEbayBlock?) {
            guard let block, !block.categoryId.isEmpty else { return nil }
            categoryId = block.categoryId
            categoryPath = block.categoryPath
            filledAspectCount = block.aspects.values.reduce(0) { $0 + ($1.isEmpty ? 0 : 1) }
        }
    }

    let itemId: String
    /// Fields written automatically (confidence ≥ the auto-apply threshold).
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
    /// US-822: eBay category + specifics resolved+persisted server-side this pass.
    /// Optional + defaulted so (a) the synthesized Decodable tolerates its absence
    /// in reviews persisted before this field existed (US-1171 disk cache), and
    /// (b) the memberwise init stays callable without it (tests / synthetic uses).
    var ebayCategory: EbaySummary? = nil

    /// Count shown in the entry point — applied fields plus applied measurements.
    var appliedCount: Int {
        applied.count + (measurementsApplied ? measurements.count : 0)
    }

    /// Nothing to show once everything's been reviewed away. A resolved eBay
    /// category counts: it's worth surfacing that the listing's category +
    /// specifics were set even when no editable field needs review.
    var hasSomethingToReview: Bool {
        !applied.isEmpty || !lowConfidence.isEmpty || measurementsApplied || ebayCategory != nil
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

    /// Item ids whose review should AUTO-PRESENT as a sheet the next time their
    /// canvas appears, instead of waiting for a tap on the (easy-to-miss) banner.
    /// Set at post-intake registration so the extracted fields surface as a
    /// dialog — the behavior users expect from the web's review panel. Transient
    /// (in-memory): after an app restart the persisted review still shows via the
    /// banner, so nothing is lost; we just don't force the popup across launches.
    private var autoPresentQueue: Set<String> = []

    /// - Parameter autoPresent: when true, the item canvas pops the review sheet
    ///   on its next appearance (used by the post-intake auto-fill so a fresh
    ///   extraction is never silently hidden behind a bare "Untitled item").
    func register(_ review: AIFillReview, autoPresent: Bool = false) {
        reviews[review.itemId] = review
        if autoPresent { autoPresentQueue.insert(review.itemId) }
        Self.persist(review)
    }

    /// True exactly once per registration: the canvas should pop the review
    /// sheet for this item now. Caller must follow a `true` with
    /// ``markAutoPresented(_:)`` so it doesn't re-pop on later reopens.
    func shouldAutoPresent(_ itemId: String) -> Bool {
        autoPresentQueue.contains(itemId)
    }

    func markAutoPresented(_ itemId: String) {
        autoPresentQueue.remove(itemId)
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
        autoPresentQueue.remove(itemId)
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
