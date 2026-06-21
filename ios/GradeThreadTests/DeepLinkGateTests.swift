import XCTest
@testable import GradeThread

/// US-1156: inbound deep links are rate-limited (anti-flood) and a link that
/// arrives before sign-in is queued and replayed rather than dropped.
final class DeepLinkGateTests: XCTestCase {

    // MARK: - Rate limiting

    func test_gate_acceptsFirstLink() {
        XCTAssertTrue(DeepLinkGate.shouldAccept(last: nil, now: Date()))
    }

    func test_gate_rejectsRapidBurst() {
        let t0 = Date(timeIntervalSince1970: 1000)
        // 50ms later — inside the min interval → dropped.
        let t1 = t0.addingTimeInterval(0.05)
        XCTAssertFalse(DeepLinkGate.shouldAccept(last: t0, now: t1))
    }

    func test_gate_acceptsAfterInterval() {
        let t0 = Date(timeIntervalSince1970: 1000)
        let t1 = t0.addingTimeInterval(DeepLinkGate.minInterval + 0.01)
        XCTAssertTrue(DeepLinkGate.shouldAccept(last: t0, now: t1))
    }

    // MARK: - Pending queue (route-during-auth)

    func test_pending_takeReturnsNilWhenEmpty() {
        var pending = PendingDeepLink()
        XCTAssertNil(pending.take())
    }

    func test_pending_queueThenTake_replaysOnce() {
        var pending = PendingDeepLink()
        pending.queue(.gradesList)
        XCTAssertEqual(pending.take(), .gradesList)
        XCTAssertNil(pending.take(), "Taken route is cleared so it replays only once")
    }

    func test_pending_newerRouteSupersedes() {
        var pending = PendingDeepLink()
        pending.queue(.marketplacesTab)
        pending.queue(.inventoryItem(id: "abc"))
        XCTAssertEqual(pending.take(), .inventoryItem(id: "abc"))
    }
}
