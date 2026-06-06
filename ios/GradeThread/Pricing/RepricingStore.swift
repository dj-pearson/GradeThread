import Observation
import SwiftUI

/// View-model for the Repricing inbox. Loads pending condition-aware pricing
/// suggestions, and applies / dismisses them with per-row in-flight + error
/// state so one row's failure never blocks the others.
@MainActor
@Observable
final class RepricingStore {

    enum Phase: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var suggestions: [RepricingSuggestion] = []
    /// Ids currently being applied/dismissed — disables that row's buttons.
    private(set) var inFlight: Set<String> = []
    /// Per-row error message, surfaced under the card with a retry affordance.
    private(set) var rowErrors: [String: String] = [:]
    private(set) var isScanning = false
    /// Transient success/info banner; the view clears it.
    var banner: String?

    private let service: RepricingProviding

    init(service: RepricingProviding? = nil) {
        self.service = service ?? RepricingService()
    }

    func load() async {
        // Only show the full-screen loader on first load; on refresh keep the
        // existing rows visible and fall back to a banner on failure.
        if suggestions.isEmpty { phase = .loading }
        do {
            suggestions = try await service.suggestions()
            phase = .loaded
        } catch {
            if suggestions.isEmpty {
                phase = .failed(Self.message(error))
            } else {
                banner = Self.message(error)
            }
        }
    }

    func scanThenReload() async {
        guard !isScanning else { return }
        isScanning = true
        defer { isScanning = false }
        do {
            let result = try await service.scan()
            await load()
            banner = result.actionable == 0
                ? "Scan complete — your prices look good."
                : "Found \(result.actionable) suggestion\(result.actionable == 1 ? "" : "s")."
        } catch {
            banner = Self.message(error)
        }
    }

    func apply(_ suggestion: RepricingSuggestion) async {
        guard !inFlight.contains(suggestion.id) else { return }
        inFlight.insert(suggestion.id)
        rowErrors[suggestion.id] = nil
        defer { inFlight.remove(suggestion.id) }
        do {
            let newPrice = try await service.apply(id: suggestion.id)
            suggestions.removeAll { $0.id == suggestion.id }
            banner = "Repriced to \(Self.dollars(newPrice))."
            HapticFeedback.success()
        } catch {
            rowErrors[suggestion.id] = Self.message(error)
            HapticFeedback.error()
        }
    }

    func dismiss(_ suggestion: RepricingSuggestion) async {
        guard !inFlight.contains(suggestion.id) else { return }
        inFlight.insert(suggestion.id)
        rowErrors[suggestion.id] = nil
        defer { inFlight.remove(suggestion.id) }
        do {
            try await service.dismiss(id: suggestion.id)
            suggestions.removeAll { $0.id == suggestion.id }
        } catch {
            rowErrors[suggestion.id] = Self.message(error)
        }
    }

    // MARK: - Pure helpers

    /// Counts per reason, for the header summary chips. Ordered
    /// underpriced → overpriced → stale → other for stable display.
    static func summary(_ suggestions: [RepricingSuggestion]) -> [RepricingReasonCount] {
        let counts = Dictionary(grouping: suggestions, by: \.reason).mapValues(\.count)
        let order: [RepricingReason] = [.underpriced, .overpriced, .stale, .other]
        return order.compactMap { reason in
            guard let count = counts[reason], count > 0 else { return nil }
            return RepricingReasonCount(reason: reason, count: count)
        }
    }

    static func dollars(_ amount: Double) -> String {
        "$" + String(format: "%.2f", amount)
    }

    static func centsDollars(_ cents: Int) -> String {
        "$" + String(format: "%.2f", Double(cents) / 100)
    }

    private static func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
