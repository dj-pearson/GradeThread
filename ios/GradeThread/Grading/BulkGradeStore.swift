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
        // US-1184: a non-retryable terminal state (e.g. nothing selected) so the
        // sheet shows only "Close" instead of a "Try again" that re-fails forever.
        case empty(String)
    }

    let itemIds: [String]
    private let service: GradingService

    private(set) var phase: Phase = .loading
    var tier: GradeTierOption = .standard
    private(set) var validation: GradingValidateResponse?
    private(set) var result: GradingSubmitResponse?

    /// US-809: in-flow credit top-up (poll the async grant → re-validate →
    /// unblock submit) after the seller buys a credit pack from the blocked
    /// banner. Observable so the sheet reflects awaitingGrant/timedOut.
    let creditTopUp: CreditTopUpFlow

    // service defaults to nil (not GradingService()) — a default argument is
    // evaluated in a nonisolated context, but GradingService is @MainActor.
    init(itemIds: [String], service: GradingService? = nil, creditTopUp: CreditTopUpFlow? = nil) {
        self.itemIds = itemIds
        self.service = service ?? GradingService()
        self.creditTopUp = creditTopUp ?? CreditTopUpFlow(
            fetchBalance: { await PaywallStore.liveBillingFetcher()?.credits })
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
        creditTopUp.reset()
        await runValidation()
    }

    func selectTier(_ newTier: GradeTierOption) async {
        guard newTier != tier else { return }
        tier = newTier
        await runValidation()
    }

    private func runValidation() async {
        guard !itemIds.isEmpty else {
            phase = .empty("No items selected. Close this and pick at least one item to grade.")
            return
        }
        do {
            let wasBlocked = validation?.limitExceeded ?? false
            let result = try await service.validateBatch(itemIds: itemIds, tier: tier)
            validation = result
            phase = .ready
            // Funnel step 1 (blocked): emit only on the transition into the
            // limit-exceeded state so a tier re-validate doesn't double-count.
            if result.limitExceeded && !wasBlocked {
                Telemetry.event("grade.credits_blocked", props: [
                    "surface": "bulk",
                    "credits_required": result.creditsRequired,
                ])
            }
        } catch {
            phase = .failed(message(from: error))
        }
    }

    // MARK: - In-flow credit top-up (US-809)

    /// Funnel step 2 (purchased): the inline credit-pack purchase succeeded —
    /// poll the billing snapshot until the async grant lands, then re-validate
    /// so `canSubmit` reflects the new balance.
    func creditsPurchased() async {
        Telemetry.event("grade.credits_topup_started", props: [
            "surface": "bulk",
            "baseline": validation?.user.creditBalance ?? 0,
        ])
        await pollForGrant()
    }

    /// Retry the grant poll from the "Check again" affordance after a timeout.
    func recheckCredits() async {
        await pollForGrant()
    }

    private func pollForGrant() async {
        let baseline = validation?.user.creditBalance ?? 0
        await creditTopUp.awaitGrant(baseline: baseline) { [weak self] in
            await self?.runValidation()
        }
        switch creditTopUp.state {
        case let .granted(balance):
            Telemetry.event("grade.credits_topup_granted", props: ["surface": "bulk", "balance": balance])
        case .timedOut:
            Telemetry.event("grade.credits_topup_timeout", props: ["surface": "bulk"])
        default:
            break
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
            // US-1176: bulk grading doesn't poll, so kick a sync now to pull the
            // grades onto each item sooner instead of waiting for the next cycle.
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            HapticFeedback.success()
        } catch {
            phase = .failed(message(from: error))
        }
    }

    private func message(from error: Error) -> String {
        (error as? EdgeAPIError)?.errorDescription ?? error.localizedDescription
    }
}
