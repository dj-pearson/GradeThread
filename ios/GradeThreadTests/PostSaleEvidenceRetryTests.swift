import XCTest
@testable import GradeThread

/// US-1146: a failed (non-idempotent) dispute-evidence upload is surfaced as an
/// explicit, retryable failure instead of being swallowed into a dismissable
/// toast. A subsequent retry that succeeds clears the pending state.
@MainActor
final class PostSaleEvidenceRetryTests: XCTestCase {

    func test_uploadFailure_retainsRetryablePayload() async {
        let fake = FakePostSale(); fake.evidenceShouldThrow = true
        let store = PostSaleStore(service: fake)
        let dispute = EbayPaymentDispute(paymentDisputeId: "d1")

        await store.uploadDisputeEvidence(dispute, imageData: Data([0x1, 0x2]))

        XCTAssertNotNil(store.actionError)
        XCTAssertEqual(store.pendingEvidenceRetry?.dispute, dispute)
        XCTAssertEqual(store.pendingEvidenceRetry?.imageData, Data([0x1, 0x2]))
    }

    func test_retrySucceeds_clearsPendingAndShowsBanner() async {
        let fake = FakePostSale(); fake.evidenceShouldThrow = true
        let store = PostSaleStore(service: fake)
        await store.uploadDisputeEvidence(
            EbayPaymentDispute(paymentDisputeId: "d1"), imageData: Data([0x9]))
        XCTAssertNotNil(store.pendingEvidenceRetry)

        fake.evidenceShouldThrow = false      // network recovered
        await store.retryEvidenceUpload()

        XCTAssertNil(store.pendingEvidenceRetry)
        XCTAssertNil(store.actionError)
        XCTAssertEqual(store.actionBanner, "Evidence uploaded to eBay.")
        XCTAssertEqual(fake.evidenceUploadCount, 2)   // initial + retry
    }
}

private final class FakePostSale: PostSaleProviding {
    var evidenceShouldThrow = false
    var evidenceUploadCount = 0
    struct Boom: Error {}

    func returns() async throws -> [EbayReturn] { [] }
    func decideReturn(returnId: String, decision: String, orderId: String?) async throws {}
    func refundReturn(returnId: String, orderId: String?) async throws {}
    func cancellations() async throws -> [EbayCancellation] { [] }
    func decideCancellation(cancelId: String, action: String, orderId: String?) async throws {}
    func disputes() async throws -> [EbayPaymentDispute] { [] }
    func resolveDispute(disputeId: String, action: String, note: String?, orderId: String?) async throws {}
    func addDisputeEvidence(
        disputeId: String, imageData: Data, fileName: String, evidenceType: String?
    ) async throws {
        evidenceUploadCount += 1
        if evidenceShouldThrow { throw Boom() }
    }
}
