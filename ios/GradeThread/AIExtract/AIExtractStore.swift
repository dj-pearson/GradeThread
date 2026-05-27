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

    struct Measurement: Identifiable, Equatable {
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

    // MARK: - Lifecycle

    func setWaiting(complete: Int, total: Int) {
        phase = .waitingForUploads(complete: complete, total: total)
    }

    func beginExtract() {
        phase = .extracting
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

        phase = .ready(Result(
            entries: entries,
            measurements: measurements,
            conditionSummary: response.conditionSummary
        ))
    }

    func fail(_ message: String) {
        phase = .failed(message: message)
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
