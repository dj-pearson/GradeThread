import Foundation
import Observation

/// Drives the AI extract review screen. Holds the request phase, the
/// parsed suggestions / measurements, and the acceptance state the user
/// builds up by checking rows.
@MainActor
@Observable
final class AIExtractStore {
    enum Phase: Equatable {
        case waitingForUploads(complete: Int, total: Int)
        case extracting
        case ready(Result)
        case failed(message: String)
    }

    /// Snapshot of what came back from the extract endpoint, in a
    /// view-friendly shape.
    struct Result: Equatable {
        let entries: [FieldSuggestionEntry]
        let measurements: [Measurement]
        let conditionSummary: String?
    }

    struct Measurement: Identifiable, Equatable, Codable {
        let id: String   // field key, e.g. "chest"
        let key: String
        let valueInches: Double
    }

    // MARK: - The two bars (US-2267)
    //
    // This used to be ONE number doing two jobs that pull in opposite directions:
    // what gets WRITTEN to the item without asking, and what starts TICKED in the
    // review. Set low (0.5) it filled more of the listing but wrote
    // medium-confidence guesses to the database before the seller had seen them —
    // which the web never does, it writes nothing until Apply. Set high it stopped
    // guessing but left every row unticked, making a perfectly good fill a
    // row-by-row chore to accept.
    //
    // Splitting them gets both: only near-certain values are written unasked, and
    // everything from medium up is pre-ticked so accepting it is one tap.

    /// Confidence at/above which a field is written to the item WITHOUT asking.
    /// High deliberately — this is the only value the seller doesn't see first.
    /// Composed with the never-overwrite rule in ``buildFillReview``: even a
    /// confident value won't clobber something the seller already filled in.
    static let autoApplyConfidenceThreshold = 0.8

    /// Confidence at/above which an opt-in row starts TICKED in the review. Below
    /// the write bar, so these are shown-then-accepted rather than written — but a
    /// medium read is still worth one tap rather than a hunt. Mirrors the web
    /// panel's "Med" tier (`confidenceTier` in ai-fill-panel.tsx).
    static let defaultAcceptConfidenceThreshold = 0.5

    /// The placeholder title a photo-first capture creates the row with
    /// (``PhotoIntakeView.startIntakeFlow``). `title` is NOT NULL, so a brand-new
    /// item's title is this string rather than empty — and treating it as "already
    /// filled" would make the never-overwrite rule below refuse to name the item,
    /// which is the exact "Untitled item" dead end US-682 exists to prevent.
    static let placeholderTitle = "Untitled item"

    /// Whether a column currently holds nothing the seller would miss. Blank, or
    /// the placeholder title.
    static func isUnset(_ value: String?, field: String) -> Bool {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty { return true }
        return field == "title" && trimmed == placeholderTitle
    }

    var phase: Phase = .waitingForUploads(complete: 0, total: 0)
    /// Field names the user has checked for acceptance.
    var acceptedFields: Set<String> = []
    /// All-or-nothing toggle for measurements — they're brand-spec
    /// estimates so the user either trusts the batch or not, per the AC.
    var acceptMeasurements: Bool = true
    /// True iff the on-device Live Text fallback produced at least one
    /// suggestion (brand or size that Claude missed). The review screen
    /// surfaces a small banner so the user knows where those values came
    /// from.
    var liveTextFallbackUsed: Bool = false
    /// eBay category + item-specifics the server resolved AND persisted onto
    /// the item during extraction. Display-only here — the specifics editor
    /// reads the saved values.
    var ebayPrep: AIExtractEbayBlock?
    /// US-821 canonical attributes captured this pass (department, size_type,
    /// vintage, …). Drives the US-826 high-value confirm chips.
    var attributes: [String: AttributeSuggestion] = [:]
    /// US-1527: the research-tier product identification, when one cleared the
    /// server-side confidence floor. Its rationale rides into the review so
    /// the user can verify the named product before accepting.
    var research: ResearchIdentification?
    /// US-1531: the ai_enrichment_log row for this extraction, so the review
    /// can report acceptance + corrections back to PATCH /ai/log/:id.
    var logId: String?

    /// US-826: true when the AI produced at least one of the high-value
    /// attributes (department / size_type / vintage / condition tier) worth
    /// confirming before we land on the item.
    var hasAttributesToConfirm: Bool {
        AIAttributeConfirm.keys.contains { key in
            guard let first = attributes[key]?.values.first else { return false }
            return !first.isEmpty
        }
    }

    // MARK: - Lifecycle

    func setWaiting(complete: Int, total: Int) {
        phase = .waitingForUploads(complete: complete, total: total)
    }

    func beginExtract() {
        phase = .extracting
    }

    /// Merges Live Text fallback suggestions (US-177) on top of the
    /// already-loaded extract result, filling brand / size when Claude
    /// missed them. Confidence stamp matches the AC (0.4) so the rows
    /// render under the orange-tier styling — visible but obviously
    /// less trustworthy than a Claude-sourced suggestion.
    func mergeLiveTextSuggestions(brand: String?, size: String?) {
        guard case let .ready(result) = phase else { return }
        var entries = result.entries
        var added = false

        func merge(field: String, value: String) {
            if entries.contains(where: { $0.field == field }) { return }
            let suggestion = FieldSuggestion(
                value: value,
                confidence: 0.4,
                source: "live-text"
            )
            entries.append(FieldSuggestionEntry(
                id: field,
                field: field,
                suggestion: suggestion
            ))
            added = true
        }

        if let brand, !brand.isEmpty { merge(field: "brand", value: brand) }
        if let size, !size.isEmpty { merge(field: "size", value: size) }

        guard added else { return }
        entries.sort { $0.field < $1.field }
        phase = .ready(Result(
            entries: entries,
            measurements: result.measurements,
            conditionSummary: result.conditionSummary
        ))
        liveTextFallbackUsed = true
        // Don't auto-accept fallback suggestions — 0.4 confidence is below the
        // default-accept threshold. The user can opt in explicitly.
    }

    /// US-1217: high-error fields whose text-vs-photo disagreement must NEVER be
    /// silently resolved — when the extract surfaces a conflict on one of these,
    /// the tag (text) candidate is forced into the opt-in review at lowered
    /// confidence so the user explicitly chooses instead of inheriting whichever
    /// value happened to land in `suggestions`.
    static let conflictReviewFields: Set<String> = ["size", "brand", "department"]

    /// US-1217: confidence stamp for a conflict-derived review row. Matches the
    /// Live Text fallback tier (0.4) so the row renders under the low-confidence
    /// (amber) styling and stays BELOW the auto-apply bar — it's a candidate to
    /// pick, never an auto-fill.
    static let conflictReviewConfidence = 0.4

    func applyResponse(_ response: AIExtractResponse) {
        var entries = response.suggestions
            // Stable order: alphabetize so two runs don't shuffle rows
            // between renders.
            .sorted { $0.key < $1.key }
            .map { (field, suggestion) in
                FieldSuggestionEntry(
                    id: field,
                    field: field,
                    suggestion: suggestion
                )
            }

        // US-1217: surface text-vs-photo conflicts on high-error fields
        // (size/brand/department) as opt-in review rows instead of dropping
        // `response.conflicts`. We prefer the TAG (text) candidate — OCR off the
        // care/size label is the more authoritative reading for these fields —
        // and stamp it at the low-confidence tier so it lands in the review's
        // opt-in list (never the silent auto-apply path). When `suggestions`
        // already resolved to the tag value, we lower its confidence below the
        // bar so the disagreement still demands a choice; otherwise we inject a
        // fresh row for the field.
        // US-1530: a conflicted field must NEVER auto-apply, whatever its
        // confidence — the photos disagreed, so the user decides. Fields
        // outside the US-1217 forced-tag set keep their suggested value but
        // get clamped below the auto-apply bar and re-sourced so the review
        // row says why ("Photos disagree on this").
        let conflictedFields = Set(response.conflicts.map(\.field))
        for (idx, entry) in entries.enumerated()
        where conflictedFields.contains(entry.field) &&
            !Self.conflictReviewFields.contains(entry.field) {
            entries[idx] = FieldSuggestionEntry(
                id: entry.field,
                field: entry.field,
                suggestion: FieldSuggestion(
                    value: entry.value,
                    confidence: min(entry.confidence, Self.conflictReviewConfidence),
                    source: "conflict:photo"
                )
            )
        }

        for conflict in response.conflicts {
            guard Self.conflictReviewFields.contains(conflict.field) else { continue }
            let tagValue = conflict.textValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !tagValue.isEmpty else { continue }
            let suggestion = FieldSuggestion(
                value: tagValue,
                confidence: Self.conflictReviewConfidence,
                source: "conflict:tag"
            )
            if let idx = entries.firstIndex(where: { $0.field == conflict.field }) {
                // Re-key the existing row to the tag value at lowered confidence so
                // it can't auto-apply silently — the user must opt in.
                entries[idx] = FieldSuggestionEntry(
                    id: conflict.field,
                    field: conflict.field,
                    suggestion: suggestion
                )
            } else {
                entries.append(FieldSuggestionEntry(
                    id: conflict.field,
                    field: conflict.field,
                    suggestion: suggestion
                ))
            }
        }
        entries.sort { $0.field < $1.field }

        let measurements = (response.measurements ?? [:])
            .sorted { $0.key < $1.key }
            .map { Measurement(id: $0.key, key: $0.key, valueInches: $0.value) }

        // Default-accept medium-and-up rows. This is the PRE-TICK bar, not the
        // write bar (US-2267) — checking a row here still requires an Apply.
        acceptedFields = Set(
            entries
                .filter { $0.confidence >= Self.defaultAcceptConfidenceThreshold }
                .map(\.field)
        )
        // Measurements default-on per AC.
        acceptMeasurements = !measurements.isEmpty
        ebayPrep = response.ebay
        attributes = response.attributes
        research = response.research
        logId = response.logId

        phase = .ready(Result(
            entries: entries,
            measurements: measurements,
            conditionSummary: response.conditionSummary
        ))
    }

    func fail(_ message: String) {
        phase = .failed(message: message)
    }

    /// Best-effort listing title from the extraction, IGNORING the auto-apply
    /// confidence bar, so a successful extract never lands the user on a bare
    /// "Untitled item" — even when nothing cleared the auto-apply threshold.
    /// That happens when the capture has no readable care/brand tag: the extract
    /// prompt is told to return brand/size with LOW confidence rather than guess,
    /// so the core fields can land below the bar and none auto-apply.
    /// Prefers an explicit `title` suggestion, else composes brand + style/size.
    /// Returns nil only when the extraction surfaced nothing nameable.
    func bestTitleSeed() -> String? {
        guard case let .ready(result) = phase else { return nil }
        func value(_ field: String) -> String? {
            guard let raw = result.entries.first(where: { $0.field == field })?.value else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let title = value("title") { return title }
        let seed = [value("brand"), value("style") ?? value("size")]
            .compactMap { $0 }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        return seed.isEmpty ? nil : seed
    }

    // MARK: - Auto-fill review (US-686)

    /// Partitions the ready result into an auto-applied set (confidence ≥
    /// ``autoApplyConfidenceThreshold``) and the low-confidence remainder
    /// surfaced for opt-in, so the intake can write the confident fields and
    /// hand a reversible review to the item canvas. `snapshot` provides the
    /// pre-fill column values used to make each applied field's undo restore the
    /// prior value. Returns nil when the store isn't in the ready phase.
    func buildFillReview(itemId: String, snapshot: AIItemFieldWriter.Snapshot) -> AIFillReview? {
        guard case let .ready(result) = phase else { return nil }
        // US-2267: a field is written unasked only when it clears the write bar
        // AND the column is EMPTY. The second half is the web's core promise —
        // "AI never silently overwrites something the user already filled" — which
        // iOS didn't keep: a 0.9-confidence brand read overwrote a brand the seller
        // had typed, and the only trace was an undo buried in the review.
        // Everything else becomes an opt-in row, whatever its confidence.
        func isAutoApplicable(_ entry: FieldSuggestionEntry) -> Bool {
            guard entry.confidence >= Self.autoApplyConfidenceThreshold else { return false }
            return Self.isUnset(snapshot.value(for: entry.field), field: entry.field)
        }
        let applied = result.entries
            .filter(isAutoApplicable)
            .map { entry in
                AppliedAIField(
                    field: entry.field,
                    value: entry.value,
                    previousValue: snapshot.value(for: entry.field),
                    confidence: entry.confidence,
                    source: entry.source
                )
            }
        let lowConfidence = result.entries.filter { !isAutoApplicable($0) }
        let measurementsApplied = acceptMeasurements && !result.measurements.isEmpty
        return AIFillReview(
            itemId: itemId,
            applied: applied,
            lowConfidence: lowConfidence,
            measurements: result.measurements,
            measurementsApplied: measurementsApplied,
            conditionSummary: result.conditionSummary,
            usedLiveTextFallback: liveTextFallbackUsed,
            // US-822: the eBay category + specifics the server resolved AND
            // persisted server-side during this extract pass, surfaced read-only
            // in the review so "selected eBay category / required info" is
            // visible right after intake (it's already saved on the item).
            ebayCategory: AIFillReview.EbaySummary(from: ebayPrep),
            // US-1527: the identification rationale for research-tier rows.
            researchRationale: research?.identificationRationale,
            // US-1531: lets the review report acceptance + corrections.
            logId: logId
        )
    }

    // MARK: - Acceptance helpers

    func isAccepted(_ field: String) -> Bool { acceptedFields.contains(field) }

    func toggle(_ field: String) {
        if acceptedFields.contains(field) {
            acceptedFields.remove(field)
        } else {
            acceptedFields.insert(field)
        }
    }

    func acceptAll() {
        if case let .ready(result) = phase {
            acceptedFields = Set(result.entries.map(\.field))
            acceptMeasurements = !result.measurements.isEmpty
        }
    }

    func acceptNone() {
        acceptedFields.removeAll()
        acceptMeasurements = false
    }

    var acceptedCount: Int {
        acceptedFields.count + (acceptMeasurements && measurementCount > 0 ? measurementCount : 0)
    }

    private var measurementCount: Int {
        if case let .ready(result) = phase { return result.measurements.count }
        return 0
    }
}
