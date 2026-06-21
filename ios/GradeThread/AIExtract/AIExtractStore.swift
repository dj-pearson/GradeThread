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
        // Don't auto-accept fallback suggestions — 0.4 confidence is
        // below the default-accept threshold (0.8). The user can opt in
        // explicitly.
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

        // Default-accept high-confidence rows (≥0.8). The user can flip any
        // off before tapping Apply.
        acceptedFields = Set(entries.filter { $0.confidence >= 0.8 }.map(\.field))
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

    // MARK: - Auto-fill review (US-686)

    /// Partitions the ready result into an auto-applied set (high-confidence,
    /// >=0.8) and the low-confidence remainder surfaced for opt-in, so the
    /// intake can write the confident fields and hand a reversible review to
    /// the item canvas. `snapshot` provides the pre-fill column values used to
    /// make each applied field's undo restore the prior value. Returns nil when
    /// the store isn't in the ready phase.
    func buildFillReview(itemId: String, snapshot: AIItemFieldWriter.Snapshot) -> AIFillReview? {
        guard case let .ready(result) = phase else { return nil }
        let applied = result.entries
            .filter { $0.confidence >= 0.8 }
            .map { entry in
                AppliedAIField(
                    field: entry.field,
                    value: entry.value,
                    previousValue: snapshot.value(for: entry.field),
                    confidence: entry.confidence,
                    source: entry.source
                )
            }
        let lowConfidence = result.entries.filter { $0.confidence < 0.8 }
        let measurementsApplied = acceptMeasurements && !result.measurements.isEmpty
        return AIFillReview(
            itemId: itemId,
            applied: applied,
            lowConfidence: lowConfidence,
            measurements: result.measurements,
            measurementsApplied: measurementsApplied,
            conditionSummary: result.conditionSummary,
            usedLiveTextFallback: liveTextFallbackUsed
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
