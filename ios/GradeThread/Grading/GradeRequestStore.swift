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

    /// The bridge submission id we poll on after submit.
    private var submissionRef: String?

    // Polling cadence: ~2 minutes total. Standard SLA is hours, but the AI
    // pipeline usually finishes in seconds — we poll for the common fast path
    // and fall back to `.stillProcessing` (sync delivers the rest).
    // US-638: poll cadence is now exponential backoff (see Backoff) rather than
    // a constant interval.
    private let maxPolls = 40

    // `service` defaults to nil (not `GradingService()`): a default argument is
    // evaluated in a nonisolated context, but GradingService is @MainActor.
    // Construct it in the init body, which is main-actor-isolated.
    init(inventoryItemId: String, service: GradingService? = nil) {
        self.inventoryItemId = inventoryItemId
        self.service = service ?? GradingService()
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
            let result = try await service.validate(inventoryItemId: inventoryItemId, tier: tier)
            validation = result
            phase = .ready
        } catch {
            phase = .failed(message(from: error))
        }
    }

    /// Submit the item for grading, then poll until the grade lands.
    func submit() async {
        guard canSubmit else { return }
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
                        message: "Lost connection while checking your grade. Your photos are saved — reopen this item to check the result."
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

    private func message(from error: Error) -> String {
        (error as? EdgeAPIError)?.errorDescription
            ?? error.localizedDescription
    }
}
