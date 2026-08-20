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
        /// Paid, grading. The server sends nothing until it is done, so the UI
        /// must render this indeterminately rather than invent a number.
        case grading(submissionId: String, statusText: String)
        /// The gate abstained. Nothing was charged.
        case needsPhotos(submissionId: String, messages: [String], slots: [String])
        case graded(submissionId: String)
        case failed(String)
    }

    private(set) var step: Step = .ready

    private let submit: ([PhotoGradeImage], PhotoGradeRequest, @MainActor (Double) -> Void) async throws -> PhotoGradeOutcome
    private let pay: (String) async throws -> PhotoGradePayment.Outcome
    private let status: (String) async throws -> PhotoGradeStatus
    private let sleep: (Double) async -> Void

    /// Seams injected so the whole journey is testable without a network. The
    /// defaults are the real calls.
    init(
        submit: (([PhotoGradeImage], PhotoGradeRequest, @MainActor (Double) -> Void) async throws -> PhotoGradeOutcome)? = nil,
        pay: ((String) async throws -> PhotoGradePayment.Outcome)? = nil,
        status: ((String) async throws -> PhotoGradeStatus)? = nil,
        sleep: ((Double) async -> Void)? = nil
    ) {
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

    /// Called again after a credit purchase completes. Retrying pay is safe:
    /// the route refuses to double-charge a submission (US-2298 enforces one
    /// debit per submission in the database).
    func retryPayment(submissionId: String) async {
        await charge(submissionId: submissionId)
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
