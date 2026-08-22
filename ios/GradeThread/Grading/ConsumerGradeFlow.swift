import Foundation
import Observation

/// US-2016 — the consumer grade journey as a state machine.
///
/// submit -> pay -> poll -> result, with two states that must say the money
/// part FIRST. The walk-around screen already learned that lesson and its
/// comment says why: "we couldn't grade it" reads like a wasted purchase until
/// you know it was not one. An abstain and a credits prompt are both
/// no-charge states, and both are commonly mistaken for failures.
///
/// A STATE MACHINE RATHER THAN A VIEW WITH FLAGS, because the flow has a real
/// order and two of its steps can bounce back: paying can send you to buy
/// credits and return, and an abstain sends you back to the camera. Booleans
/// for "isSubmitting / isPaying / isPolling" make those legal transitions look
/// like edge cases.
@MainActor
@Observable
final class ConsumerGradeFlow {
    enum Step: Equatable {
        case ready
        /// Bytes moving. `fraction` is the upload only.
        case uploading(fraction: Double)
        /// Uploaded; charging against included grades or credits.
        case paying(submissionId: String)
        /// Neither covered it. NOT an error - an offer, and the pack is the one
        /// the route named.
        case needsCredits(submissionId: String, offer: PhotoGradePayment.PackOffer?)
        /// The purchase went through and the server has not credited the account
        /// YET.
        ///
        /// ⚠ THIS STATE IS THE WHOLE POINT OF THE TOP-UP FLOW. An Apple purchase
        /// completing on the device does not mean the balance has moved: the
        /// grant arrives through the server, and there is a gap. Paying again
        /// during that gap returns "out of credits" a SECOND time - the same
        /// wall the customer just paid to clear.
        case awaitingCredits(submissionId: String)
        /// The grant did not appear inside the poll window. NOT a failure and
        /// NOT a refusal: it may still land, so the user gets "check again"
        /// rather than an error.
        case creditsDelayed(submissionId: String)
        /// Paid, grading. The server sends nothing until it is done, so the UI
        /// must render this indeterminately rather than invent a number.
        case grading(submissionId: String, statusText: String)
        /// The gate abstained. Nothing was charged.
        case needsPhotos(submissionId: String, messages: [String], slots: [String])
        case graded(submissionId: String)
        case failed(String)
    }

    private(set) var step: Step = .ready

    // `@escaping` on the progress callback, because that is what the thing it is
    // handed to requires: `PhotoGradeUploadService.submit` takes
    // `@MainActor @escaping (Double) -> Void` and holds it across the upload.
    // A closure parameter of a closure TYPE is non-escaping by default, so
    // without this the default `submit` below cannot forward its own argument.
    private let submit: ([PhotoGradeImage], PhotoGradeRequest, @MainActor @escaping (Double) -> Void) async throws -> PhotoGradeOutcome
    private let pay: (String) async throws -> PhotoGradePayment.Outcome
    private let status: (String) async throws -> PhotoGradeStatus
    private let sleep: (Double) async -> Void

    /// THE SAME top-up flow ``GradeRequestStore`` uses, not a second one.
    ///
    /// It polls the billing snapshot until the balance rises above the
    /// pre-purchase baseline, tolerating a failed read, and it re-checks once
    /// more on timeout because the grant may land between the last poll and
    /// giving up. Two answers to "have the credits arrived yet" would drift, and
    /// the one that drifts is the one that tells a paying customer no.
    let creditTopUp: CreditTopUpFlow

    /// Seams injected so the whole journey is testable without a network. The
    /// defaults are the real calls.
    init(
        submit: (([PhotoGradeImage], PhotoGradeRequest, @MainActor @escaping (Double) -> Void) async throws -> PhotoGradeOutcome)? = nil,
        pay: ((String) async throws -> PhotoGradePayment.Outcome)? = nil,
        status: ((String) async throws -> PhotoGradeStatus)? = nil,
        sleep: ((Double) async -> Void)? = nil,
        creditTopUp: CreditTopUpFlow? = nil
    ) {
        // Built in the init body, not as a default argument: a default is
        // evaluated in a nonisolated context and PaywallStore is @MainActor -
        // the same reason GradeRequestStore constructs its own here.
        self.creditTopUp = creditTopUp ?? CreditTopUpFlow(
            fetchBalance: { await PaywallStore.liveBillingFetcher()?.credits })
        self.submit = submit ?? { images, request, onProgress in
            try await PhotoGradeUploadService.submit(
                images: images, request: request, onProgress: onProgress)
        }
        self.pay = pay ?? { submissionId in
            let response: PhotoGradePayResponse = try await EdgeAPI.shared.postJSON(
                "/api/grade/pay/\(submissionId)",
                body: PhotoGradePayRequest(tier: "standard"))
            return response.outcome()
        }
        self.status = status ?? { submissionId in
            try await EdgeAPI.shared.getJSON("/api/grade/status/\(submissionId)")
        }
        self.sleep = sleep ?? { seconds in
            try? await Task.sleep(for: .seconds(seconds))
        }
    }

    func start(images: [PhotoGradeImage], request: PhotoGradeRequest) async {
        step = .uploading(fraction: 0)
        let submissionId: String
        do {
            let outcome = try await submit(images, request) { [weak self] fraction in
                guard let self else { return }
                // Never backwards, never past 1. A retried body segment can
                // report a lower cumulative count, and a bar that jumps back
                // reads as a failure.
                if case let .uploading(current) = self.step {
                    self.step = .uploading(fraction: max(current, min(1, fraction)))
                }
            }
            guard case let .submitted(id, alreadyPaid) = outcome else { return }
            submissionId = id
            if alreadyPaid {
                await poll(submissionId: submissionId)
                return
            }
        } catch {
            step = .failed(message(for: error))
            return
        }
        await charge(submissionId: submissionId)
    }

    /// Called when the credit purchase completes.
    ///
    /// ⚠ WAITS FOR THE GRANT BEFORE RETRYING, which my first version did not.
    /// The purchase succeeding on the device is not the balance moving; the
    /// grant comes through the server and there is a gap. Charging inside that
    /// gap answers "out of credits" again and shows the customer the same wall
    /// they just paid to clear.
    ///
    /// `baseline` is the balance BEFORE the purchase. The grant is detected as a
    /// strict increase over it, which tolerates a failed read and does not
    /// assume the pack size arrived exactly.
    ///
    /// Retrying the charge itself is safe: the route enforces one debit per
    /// submission in the database (US-2298, after batch grading charged up to
    /// five times for one garment).
    func creditsPurchased(submissionId: String, baseline: Int) async {
        step = .awaitingCredits(submissionId: submissionId)
        await creditTopUp.awaitGrant(baseline: baseline) { [weak self] in
            guard let self else { return }
            if case .granted = self.creditTopUp.state {
                await self.charge(submissionId: submissionId)
            }
        }
        // timedOut is not a refusal - the grant may still land, so offer
        // "check again" rather than an error. awaitGrant already re-checks once
        // more before reporting it.
        if case .timedOut = creditTopUp.state, case .awaitingCredits = step {
            step = .creditsDelayed(submissionId: submissionId)
        }
    }

    /// The "check again" affordance on ``Step/creditsDelayed``.
    func recheckCredits(submissionId: String, baseline: Int) async {
        await creditsPurchased(submissionId: submissionId, baseline: baseline)
    }

    private func charge(submissionId: String) async {
        step = .paying(submissionId: submissionId)
        do {
            switch try await pay(submissionId) {
            case .paidFromIncluded, .paidFromCredits:
                await poll(submissionId: submissionId)
            case let .needsCredits(offer):
                step = .needsCredits(submissionId: submissionId, offer: offer)
            }
        } catch {
            step = .failed(message(for: error))
        }
    }

    private func poll(submissionId: String) async {
        var attempt = 0
        step = .grading(submissionId: submissionId, statusText: "Grading your photos…")
        while !Task.isCancelled {
            do {
                let current = try await status(submissionId)
                if current.isTerminal {
                    step = terminalStep(for: current, submissionId: submissionId)
                    return
                }
                step = .grading(
                    submissionId: submissionId,
                    statusText: PhotoGradeStatusRules.waitingText(for: current.status))
            } catch {
                // A transient read failure is not a failed grade. The grade is
                // running server-side either way, so keep polling rather than
                // telling the user their submission died.
                step = .grading(
                    submissionId: submissionId,
                    statusText: "Still working…")
            }
            await sleep(PhotoGradeStatusRules.nextDelaySeconds(attempt: attempt))
            attempt += 1
        }
    }

    private func terminalStep(for status: PhotoGradeStatus, submissionId: String) -> Step {
        if status.isGraded { return .graded(submissionId: submissionId) }
        if status.needsPhotos {
            return .needsPhotos(
                submissionId: submissionId,
                messages: PhotoGradeStatusRules.retakeMessages(status.quality_feedback),
                slots: PhotoGradeStatusRules.blockingSlots(status.quality_feedback))
        }
        // expired / failed / disputed. Named rather than swallowed into
        // "something went wrong", because each has a different next move.
        return .failed(ConsumerGradeCopy.terminalMessage(for: status.status))
    }

    private func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription
            ?? "We couldn't send that for grading."
    }
}

struct PhotoGradePayRequest: Encodable {
    let tier: String
}

enum ConsumerGradeCopy {
    /// A terminal status that is not a grade and not an abstain.
    static func terminalMessage(for status: String) -> String {
        switch status {
        case "expired":
            return "This grade expired before it was paid for. Start it again when you're ready."
        case "failed":
            return "Grading didn't finish. You weren't charged - try again, and tell support if it repeats."
        case "disputed":
            return "This grade is under dispute. We'll update you when it's reviewed."
        default:
            return "That grade didn't finish."
        }
    }

    /// The headline for a no-charge state. Said BEFORE the reason, because
    /// "we couldn't grade it" reads like a wasted purchase until you know it
    /// was not one - the walk-around screen's own lesson.
    static let noChargeHeadline = "You weren't charged for this."
}
