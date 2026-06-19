import XCTest
@testable import GradeThread

/// US-749: the shell-level Reconcile affordance must (a) reflect the live orphan
/// count, (b) hide when zero, and (c) preserve the last known count on a failed
/// refresh — a transient network error is not "all reconciled".
@MainActor
final class ReconcileBadgeStoreTests: XCTestCase {

    private struct CountError: Error {}

    func test_refresh_setsCount_andShowsAffordance() async {
        let store = ReconcileBadgeStore(fetchCount: { _ in 3 })
        XCTAssertFalse(store.hasOrphans)
        await store.refresh(userId: "u1")
        XCTAssertEqual(store.orphanCount, 3)
        XCTAssertTrue(store.hasOrphans)
    }

    func test_refresh_zero_hidesAffordance() async {
        let store = ReconcileBadgeStore(fetchCount: { _ in 0 })
        await store.refresh(userId: "u1")
        XCTAssertEqual(store.orphanCount, 0)
        XCTAssertFalse(store.hasOrphans)
    }

    func test_refresh_failure_preservesLastKnownCount() async {
        var shouldThrow = false
        let store = ReconcileBadgeStore(fetchCount: { _ in
            if shouldThrow { throw CountError() }
            return 5
        })
        // First, a good read.
        await store.refresh(userId: "u1")
        XCTAssertEqual(store.orphanCount, 5)
        // Then a failing read must NOT zero the banner.
        shouldThrow = true
        await store.refresh(userId: "u1")
        XCTAssertEqual(store.orphanCount, 5)
        XCTAssertTrue(store.hasOrphans)
    }

    func test_reset_clearsCount() async {
        let store = ReconcileBadgeStore(fetchCount: { _ in 4 })
        await store.refresh(userId: "u1")
        XCTAssertEqual(store.orphanCount, 4)
        store.reset()
        XCTAssertEqual(store.orphanCount, 0)
        XCTAssertFalse(store.hasOrphans)
    }
}
