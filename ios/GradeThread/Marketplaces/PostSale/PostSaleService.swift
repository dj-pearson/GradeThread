import Foundation

/// Edge client for eBay returns, cancellations, and payment disputes
/// (US-1043 / US-1049). The edge resolves the caller's eBay token, so there's no
/// cross-tenant surface. Behind a protocol so ``PostSaleStore`` is testable.
protocol PostSaleProviding {
    func returns() async throws -> [EbayReturn]
    func decideReturn(returnId: String, decision: String, orderId: String?) async throws
    func refundReturn(returnId: String, orderId: String?) async throws
    func cancellations() async throws -> [EbayCancellation]
    func decideCancellation(cancelId: String, action: String, orderId: String?) async throws
    func disputes() async throws -> [EbayPaymentDispute]
    func resolveDispute(disputeId: String, action: String, note: String?, orderId: String?) async throws
    func addDisputeEvidence(disputeId: String, imageData: Data, fileName: String, evidenceType: String?) async throws
}

struct PostSaleService: PostSaleProviding {
    private struct ReturnsResponse: Decodable { let returns: [EbayReturn] }
    private struct CancellationsResponse: Decodable { let cancellations: [EbayCancellation] }
    private struct DisputesResponse: Decodable { let disputes: [EbayPaymentDispute] }
    private struct OKResponse: Decodable { let ok: Bool? }

    func returns() async throws -> [EbayReturn] {
        let resp: ReturnsResponse = try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/returns")
        return resp.returns
    }

    func decideReturn(returnId: String, decision: String, orderId: String?) async throws {
        struct Body: Encodable { let decision: String; let orderId: String? }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/returns/\(returnId)/decide",
            body: Body(decision: decision, orderId: orderId)
        )
    }

    func refundReturn(returnId: String, orderId: String?) async throws {
        struct Body: Encodable { let orderId: String? }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/returns/\(returnId)/refund",
            body: Body(orderId: orderId)
        )
    }

    func cancellations() async throws -> [EbayCancellation] {
        let resp: CancellationsResponse = try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/cancellations")
        return resp.cancellations
    }

    func decideCancellation(cancelId: String, action: String, orderId: String?) async throws {
        struct Body: Encodable { let orderId: String? }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/cancellations/\(cancelId)/\(action)",
            body: Body(orderId: orderId)
        )
    }

    func disputes() async throws -> [EbayPaymentDispute] {
        let resp: DisputesResponse = try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/payment-disputes")
        return resp.disputes
    }

    func resolveDispute(disputeId: String, action: String, note: String?, orderId: String?) async throws {
        struct Body: Encodable { let note: String?; let orderId: String? }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/payment-disputes/\(disputeId)/\(action)",
            body: Body(note: note, orderId: orderId)
        )
    }

    func addDisputeEvidence(
        disputeId: String, imageData: Data, fileName: String, evidenceType: String?
    ) async throws {
        struct EvidenceResponse: Decodable { let ok: Bool?; let evidenceId: String? }
        var fields: [String: String] = [:]
        if let evidenceType { fields["evidence_type"] = evidenceType }
        let _: EvidenceResponse = try await EdgeAPI.shared.postMultipartImage(
            "/api/flipdesk/ebay/payment-disputes/\(disputeId)/evidence",
            fieldName: "file",
            fileName: fileName,
            mimeType: "image/jpeg",
            data: imageData,
            fields: fields
        )
    }
}
