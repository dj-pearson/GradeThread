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

    /// Confidence at/above which an extracted field is APPLIED automatically;
    /// below it the field is surfaced for opt-in in the (now auto-presenting)
    /// review. Lowered from 0.8 to 0.5 — "medium and up", matching the web's
    /// confidence tiers — so a no-tag / moderate-confidence capture actually
    /// fills the listing instead of landing on a near-empty item. Safe because
    /// the review sheet now pops automatically and every applied field is
    /// one-tap reversible there.
    static let autoApplyConfidenceThreshold = 0.5

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

    func applyResponse(_ response: AIExtractResponse) {
        let entries = response.suggestions
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
        let measurements = (response.measurements ?? [:])
            .sorted { $0.key < $1.key }
            .map { Measurement(id: $0.key, key: $0.key, valueInches: $0.value) }

        // Default-accept medium-and-up rows (≥ threshold). The user can flip any
        // off before tapping Apply.
        acceptedFields = Set(entries.filter { $0.confidence >= Self.autoApplyConfidenceThreshold }.map(\.field))
        // Measurements default-on per AC.
        acceptMeasurements = !measurements.isEmpty
        ebayPrep = response.ebay
        attributes = response.attributes

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
        let threshold = Self.autoApplyConfidenceThreshold
        let applied = result.entries
            .filter { $0.confidence >= threshold }
            .map { entry in
                AppliedAIField(
                    field: entry.field,
                    value: entry.value,
                    previousValue: snapshot.value(for: entry.field),
                    confidence: entry.confidence,
                    source: entry.source
                )
            }
        let lowConfidence = result.entries.filter { $0.confidence < threshold }
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
            ebayCategory: AIFillReview.EbaySummary(from: ebayPrep)
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
