import Foundation
import SwiftUI

/// Drives bulk certified grading from an inventory multi-selection:
/// validate the whole batch → submit only the items that are ready (so a
/// few blocked items don't stop the rest) → show a result summary. Unlike
/// the single-item flow there's no polling — the grades land on each item
/// via the next inventory sync.
@MainActor
@Observable
final class BulkGradeStore {

    enum Phase: Equatable {
        case loading
        case ready
        case submitting
        case done
        case failed(String)
    }

    let itemIds: [String]
    private let service: GradingService

    private(set) var phase: Phase = .loading
    var tier: GradeTierOption = .standard
    private(set) var validation: GradingValidateResponse?
    private(set) var result: GradingSubmitResponse?

    // service defaults to nil (not GradingService()) — a default argument is
    // evaluated in a nonisolated context, but GradingService is @MainActor.
    init(itemIds: [String], service: GradingService? = nil) {
        self.itemIds = itemIds
        self.service = service ?? GradingService()
    }

    var readyItems: [GradingValidatedItem] {
        validation?.items.filter(\.ready) ?? []
    }

    var blockedItems: [GradingValidatedItem] {
        validation?.items.filter { !$0.ready } ?? []
    }

    /// We submit only the ready items, so the gate is "at least one ready
    /// AND the credits cover them" — not the all-or-nothing `can_submit`.
    var canSubmit: Bool {
        !readyItems.isEmpty && !(validation?.limitExceeded ?? true)
    }

    // MARK: - Flow

    func load() async {
        phase = .loading
        await runValidation()
    }

    func selectTier(_ newTier: GradeTierOption) async {
        guard newTier != tier else { return }
        tier = newTier
        await runValidation()
    }

    private func runValidation() async {
        guard !itemIds.isEmpty else {
            phase = .failed("No items selected.")
            return
        }
        do {
            validation = try await service.validateBatch(itemIds: itemIds, tier: tier)
            phase = .ready
        } catch {
            phase = .failed(message(from: error))
        }
    }

    func submit() async {
        guard canSubmit else { return }
        let ids = readyItems.map(\.inventoryItemId)
        phase = .submitting
        Telemetry.event("grade.bulk_requested", props: ["count": ids.count, "tier": tier.rawValue])
        do {
            let response = try await service.submitBatch(itemIds: ids, tier: tier)
            result = response
            phase = .done
            Telemetry.event("grade.bulk_submitted", props: [
                "submitted": response.submitted,
                "failed": response.failed,
                "tier": tier.rawValue,
            ])
            HapticFeedback.success()
        } catch {
            phase = .failed(message(from: error))
        }
    }

    private func message(from error: Error) -> String {
        (error as? EdgeAPIError)?.errorDescription ?? error.localizedDescription
    }
}
