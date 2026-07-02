import XCTest
@testable import GradeThread

/// US-1497: irreversible, money-moving return decisions (approve / decline /
/// refund) carry a per-return re-entry guard, so a double-tap (or a re-tap after
/// the confirmation dialog) can't fire the same decision twice. The guard is
/// keyed per returnId, so two *different* returns can still be decided at once.
@MainActor
final class PostSaleReentryTests: XCTestCase {

    func test_approveReturn_reentryGuard_dropsConcurrentSecondCall() async {
        let fake = BlockingPostSale()
        let store = PostSaleStore(service: fake)
        let r = EbayReturn(returnId: "r1", orderId: "o1")

        // First approve starts and suspends inside the (blocked) service call.
        async let first: Void = store.approveReturn(r)
        await fake.waitUntilDeciding()   // deterministic: the 1st reached the await

        // A second approve for the SAME return while the first is in flight must
        // be dropped by the guard — no second service call.
        await store.approveReturn(r)
        XCTAssertEqual(fake.decideCount, 1)

        fake.release()                   // let the first finish
        await first
        XCTAssertEqual(fake.decideCount, 1)
    }

    func test_decide_differentReturns_areNotBlockedByEachOther() async {
        let fake = BlockingPostSale()
        let store = PostSaleStore(service: fake)

        // rA parks on the gate…
        async let first: Void = store.approveReturn(EbayReturn(returnId: "rA"))
        await fake.waitUntilDeciding()

        // …a DIFFERENT return is keyed separately, so its decision proceeds.
        await store.declineReturn(EbayReturn(returnId: "rB"))
        XCTAssertEqual(fake.decideCount, 2)

        fake.release()
        await first
    }
}

/// Stub that blocks only the FIRST `decideReturn` on a continuation gate so a
/// test can hold one decision in flight while it fires a second.
private final class BlockingPostSale: PostSaleProviding {
    private(set) var decideCount = 0
    private var gate: CheckedContinuation<Void, Never>?
    private var reached: CheckedContinuation<Void, Never>?
    private var blockedOnce = false

    /// Suspends until the first `decideReturn` has entered its blocked await.
    func waitUntilDeciding() async {
        await withCheckedContinuation { reached = $0 }
    }

    /// Releases the parked first `decideReturn`.
    func release() { gate?.resume(); gate = nil }

    func decideReturn(returnId: String, decision: String, orderId: String?) async throws {
        decideCount += 1
        if !blockedOnce {
            blockedOnce = true
            reached?.resume(); reached = nil
            await withCheckedContinuation { gate = $0 }
        }
    }

    func refundReturn(returnId: String, orderId: String?) async throws {
        decideCount += 1
        if !blockedOnce {
            blockedOnce = true
            reached?.resume(); reached = nil
            await withCheckedContinuation { gate = $0 }
        }
    }

    // Unused protocol surface for these tests.
    func returns() async throws -> [EbayReturn] { [] }
    func cancellations() async throws -> [EbayCancellation] { [] }
    func decideCancellation(cancelId: String, action: String, orderId: String?) async throws {}
    func disputes() async throws -> [EbayPaymentDispute] { [] }
    func resolveDispute(disputeId: String, action: String, note: String?, orderId: String?) async throws {}
    func addDisputeEvidence(
        disputeId: String, imageData: Data, fileName: String, evidenceType: String?
    ) async throws {}
}
