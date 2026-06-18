import Foundation
import Observation

/// Drives the eBay returns / cancellations / payment-disputes surface
/// (US-1043 / US-1049).
@MainActor
@Observable
final class PostSaleStore {
    enum Phase: Equatable { case loading, ready, failed(String) }

    private let service: PostSaleProviding

    var returnsPhase: Phase = .loading
    var cancellationsPhase: Phase = .loading
    var disputesPhase: Phase = .loading
    private(set) var returns: [EbayReturn] = []
    private(set) var cancellations: [EbayCancellation] = []
    private(set) var disputes: [EbayPaymentDispute] = []
    var actionError: String?
    var actionBanner: String?

    init(service: PostSaleProviding = PostSaleService()) {
        self.service = service
    }

    func loadAll() async {
        await loadDisputes()
        await loadReturns()
        await loadCancellations()
    }

    func loadReturns() async {
        returnsPhase = .loading
        do {
            returns = try await service.returns()
            returnsPhase = .ready
        } catch {
            returnsPhase = .failed(error.localizedDescription)
        }
    }

    func loadCancellations() async {
        cancellationsPhase = .loading
        do {
            cancellations = try await service.cancellations()
            cancellationsPhase = .ready
        } catch {
            cancellationsPhase = .failed(error.localizedDescription)
        }
    }

    func loadDisputes() async {
        disputesPhase = .loading
        do {
            disputes = try await service.disputes()
            disputesPhase = .ready
        } catch {
            disputesPhase = .failed(error.localizedDescription)
        }
    }

    // MARK: - Returns

    func approveReturn(_ r: EbayReturn) async { await decide(r, decision: "approve") }
    func declineReturn(_ r: EbayReturn) async { await decide(r, decision: "decline") }

    private func decide(_ r: EbayReturn, decision: String) async {
        do {
            try await service.decideReturn(returnId: r.returnId, decision: decision, orderId: r.orderId)
            actionBanner = "Return \(decision)d."
            await loadReturns()
        } catch {
            actionError = error.localizedDescription
        }
    }

    func refundReturn(_ r: EbayReturn) async {
        do {
            try await service.refundReturn(returnId: r.returnId, orderId: r.orderId)
            returns.removeAll { $0.returnId == r.returnId }
            actionBanner = "Refund issued."
            await loadReturns()
        } catch {
            actionError = error.localizedDescription
        }
    }

    // MARK: - Cancellations

    func approveCancellation(_ ca: EbayCancellation) async { await cancel(ca, action: "approve") }
    func rejectCancellation(_ ca: EbayCancellation) async { await cancel(ca, action: "reject") }

    private func cancel(_ ca: EbayCancellation, action: String) async {
        do {
            try await service.decideCancellation(cancelId: ca.cancelId, action: action, orderId: ca.orderId)
            cancellations.removeAll { $0.cancelId == ca.cancelId }
            actionBanner = action == "approve" ? "Cancellation approved." : "Cancellation rejected."
            await loadCancellations()
        } catch {
            actionError = error.localizedDescription
        }
    }

    // MARK: - Disputes

    func acceptDispute(_ d: EbayPaymentDispute) async { await resolve(d, action: "accept", note: nil) }
    func contestDispute(_ d: EbayPaymentDispute, note: String?) async {
        await resolve(d, action: "contest", note: note)
    }

    private func resolve(_ d: EbayPaymentDispute, action: String, note: String?) async {
        do {
            try await service.resolveDispute(
                disputeId: d.paymentDisputeId, action: action, note: note, orderId: d.orderId
            )
            disputes.removeAll { $0.paymentDisputeId == d.paymentDisputeId }
            actionBanner = action == "accept" ? "Dispute accepted (buyer refunded)." : "Dispute contested."
            await loadDisputes()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Uploads a supporting-evidence image (e.g. a delivery scan) to eBay and
    /// attaches it to the dispute. The seller can attach evidence and then
    /// contest.
    func uploadDisputeEvidence(_ d: EbayPaymentDispute, imageData: Data) async {
        do {
            try await service.addDisputeEvidence(
                disputeId: d.paymentDisputeId,
                imageData: imageData,
                fileName: "evidence.jpg",
                evidenceType: nil
            )
            actionBanner = "Evidence uploaded to eBay."
        } catch {
            actionError = error.localizedDescription
        }
    }
}
