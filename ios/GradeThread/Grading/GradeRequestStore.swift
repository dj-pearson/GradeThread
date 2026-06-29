import Foundation
import SwiftUI

/// Drives the certified-grade request for a single inventory item:
/// validate → (pick tier) → submit → poll until the grade lands.
///
/// Owned by ``GradeRequestSheet`` as `@State`. All mutation happens on the
/// main actor so the SwiftUI bindings stay coherent.
@MainActor
@Observable
final class GradeRequestStore {

    enum Phase: Equatable {
        /// Initial readiness/plan check in flight.
        case loading
        /// Validation came back — show readiness, tier picker, submit.
        case ready
        /// Submit in flight.
        case submitting
        /// Submitted; polling the bridge for the finished grade.
        case processing
        /// Grade landed — `report` is populated.
        case completed
        /// Grade produced but withheld for mandatory human review before it goes
        /// official. Terminal for this poll; finalization arrives via sync.
        /// `report` holds the provisional score when the edge returned it.
        case pendingReview
        /// Grading is taking longer than the poll window. Not an error: the
        /// grade will still arrive via the next inventory sync.
        case stillProcessing
        /// Hard failure with a user-facing message.
        case failed(String)
    }

    // Inputs
    let inventoryItemId: String
    private let service: GradingService

    // State
    private(set) var phase: Phase = .loading
    var tier: GradeTierOption = .standard
    private(set) var validation: GradingValidateResponse?
    private(set) var report: GradeReportDTO?
    private(set) var certificateURL: URL?

    /// US-809: in-flow credit top-up (poll the async grant → re-validate →
    /// unblock submit) after the seller buys a credit pack from the blocked
    /// banner. Observable so the sheet reflects awaitingGrant/timedOut.
    let creditTopUp: CreditTopUpFlow

    /// The bridge submission id we poll on after submit.
    private var submissionRef: String?

    /// US-1229: the in-flight submit→poll task, tracked so the sheet can cancel
    /// it on dismissal. Without this the poll loop keeps hitting the network for
    /// the full ~2-minute window after the user has left (its `Task.isCancelled`
    /// guard never trips because nothing ever cancels the fire-and-forget task).
    private var submitTask: Task<Void, Never>?

    // Polling cadence: ~2 minutes total. Standard SLA is hours, but the AI
    // pipeline usually finishes in seconds — we poll for the common fast path
    // and fall back to `.stillProcessing` (sync delivers the rest).
    // US-638: poll cadence is now exponential backoff (see Backoff) rather than
    // a constant interval.
    private let maxPolls = 40

    // `service` defaults to nil (not `GradingService()`): a default argument is
    // evaluated in a nonisolated context, but GradingService is @MainActor.
    // Construct it in the init body, which is main-actor-isolated.
    init(inventoryItemId: String, service: GradingService? = nil, creditTopUp: CreditTopUpFlow? = nil) {
        self.inventoryItemId = inventoryItemId
        self.service = service ?? GradingService()
        self.creditTopUp = creditTopUp ?? CreditTopUpFlow(
            fetchBalance: { await PaywallStore.liveBillingFetcher()?.credits })
    }

    /// The validated item for the current request, if loaded.
    var item: GradingValidatedItem? { validation?.item }

    /// Whether the chosen tier is affordable + the item is ready to submit.
    var canSubmit: Bool {
        guard let v = validation, let item = v.item else { return false }
        return item.ready && !v.limitExceeded
    }

    // MARK: - Flow

    /// Run (or re-run) validation for the current tier.
    func load() async {
        phase = .loading
        creditTopUp.reset()
        await runValidation()
    }

    /// Pick a different tier and re-validate (cost + affordability are
    /// tier-specific; readiness is not, but re-validating keeps it simple
    /// and always accurate).
    func selectTier(_ newTier: GradeTierOption) async {
        guard newTier != tier else { return }
        tier = newTier
        await runValidation()
    }

    private func runValidation() async {
        do {
            let wasBlocked = validation?.limitExceeded ?? false
            let result = try await service.validate(inventoryItemId: inventoryItemId, tier: tier)
            validation = result
            phase = .ready
            // Funnel step 1 (blocked): emit only on the transition into the
            // limit-exceeded state so a tier re-validate doesn't double-count.
            if result.limitExceeded && !wasBlocked {
                Telemetry.event("grade.credits_blocked", props: [
                    "surface": "single",
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
            "surface": "single",
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
            Telemetry.event("grade.credits_topup_granted", props: ["surface": "single", "balance": balance])
        case .timedOut:
            Telemetry.event("grade.credits_topup_timeout", props: ["surface": "single"])
        default:
            break
        }
    }

    /// Submit the item for grading, then poll until the grade lands. The work
    /// runs in a tracked task so ``stop()`` (called when the sheet is dismissed)
    /// can cancel the poll loop — its `Task.isCancelled` guard then trips and no
    /// further status requests fire. `[weak self]` avoids a store→task→store
    /// retain cycle (see `GradeRequestStore` leak test).
    func submit() {
        guard canSubmit else { return }
        submitTask?.cancel()
        submitTask = Task { @MainActor [weak self] in
            await self?.runSubmit()
        }
    }

    /// Cancel the in-flight submit/poll task. Called from the sheet's
    /// `.onDisappear` so leaving the flow stops the ~2-minute poll loop.
    func stop() {
        submitTask?.cancel()
        submitTask = nil
    }

    private func runSubmit() async {
        phase = .submitting
        Telemetry.event("grade.requested", props: ["tier": tier.rawValue])
        do {
            let response = try await service.submit(inventoryItemId: inventoryItemId, tier: tier)
            guard let result = response.results.first else {
                phase = .failed("Grading didn't start. Please try again.")
                return
            }
            if !result.ok {
                phase = .failed(result.error ?? "Grading couldn't start for this item.")
                return
            }
            guard let ref = result.flipdeskGradingSubmissionId else {
                // Submitted but we can't poll — the grade will still land via
                // sync. Treat as the soft "still processing" terminal state.
                phase = .stillProcessing
                return
            }
            submissionRef = ref
            phase = .processing
            await poll(ref: ref)
        } catch {
            phase = .failed(message(from: error))
        }
    }

    private func poll(ref: String) async {
        // US-792: tolerate transient poll blips but don't silently spin to the
        // window's end when the endpoint is unreachable — record failures and,
        // after a few in a row, surface a distinct "lost connection" state
        // instead of the ambiguous "still processing".
        var consecutiveFailures = 0
        let maxConsecutiveFailures = 4
        for attempt in 0..<maxPolls {
            // Bail if the sheet was torn down / a newer flow started.
            if Task.isCancelled { return }
            do {
                let status = try await service.status(submissionRef: ref)
                consecutiveFailures = 0 // a reachable server clears the streak
                if status.isCompleted, let report = status.gradeReport {
                    apply(report: report, item: status.item)
                    return
                }
                if status.isPendingReview {
                    applyPendingReview(report: status.gradeReport)
                    return
                }
                if status.isFailed {
                    phase = .failed(status.error ?? "Grading failed. You weren't charged — please retake the photos and try again.")
                    return
                }
            } catch {
                consecutiveFailures += 1
                Telemetry.breadcrumb(
                    "grade poll failed (\(consecutiveFailures)/\(maxConsecutiveFailures)): \(message(from: error))",
                    category: "grading"
                )
                if consecutiveFailures >= maxConsecutiveFailures {
                    phase = .failed(
                        "Lost connection while checking your grade. Your photos are saved — reopen this item to check the result."
                    )
                    return
                }
            }
            // US-638: exponential backoff (1s→2s→4s→… capped) instead of a
            // constant 3s loop, so a long grade stops hammering the endpoint.
            try? await Task.sleep(nanoseconds: Backoff.delayNanos(attempt: attempt, base: 1, cap: 8))
        }
        // Window elapsed without a terminal state.
        phase = .stillProcessing
    }

    private func apply(report: GradeReportDTO, item: GradingStatusItem) {
        self.report = report
        self.certificateURL = CertificateLink.resolve(
            explicit: item.certificateUrl,
            certificateId: report.certificateId
        )
        phase = .completed
        Telemetry.event("grade.completed", props: [
            "tier": tier.rawValue,
            "score": report.overallScore,
        ])
        HapticFeedback.success()
    }

    /// Mandatory review: the AI grade is produced but withheld until a human
    /// finalizes it. We keep the provisional report for display but DON'T resolve
    /// a certificate (held back until review clears) or stamp the item as graded —
    /// the canvas stays in its pre-grade state until finalization syncs through.
    private func applyPendingReview(report: GradeReportDTO?) {
        self.report = report
        self.certificateURL = nil
        phase = .pendingReview
        Telemetry.event("grade.pending_review", props: ["tier": tier.rawValue])
        HapticFeedback.light()
    }

    private func message(from error: Error) -> String {
        (error as? EdgeAPIError)?.errorDescription
            ?? error.localizedDescription
    }
}
