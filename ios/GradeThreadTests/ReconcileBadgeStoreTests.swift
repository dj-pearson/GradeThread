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

    // MARK: - US-1262 snooze

    /// Isolated defaults suite + a controllable clock so snooze tests don't touch
    /// `.standard` or wait real time.
    private func makeSnoozeStore(
        count: Int,
        clock: @escaping () -> Date
    ) -> (ReconcileBadgeStore, UserDefaults) {
        let suite = "test.reconcile.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = ReconcileBadgeStore(
            fetchCount: { _ in count },
            defaults: defaults,
            now: clock
        )
        return (store, defaults)
    }

    func test_snooze_hidesBanner_whileWindowActive() async {
        let base = Date(timeIntervalSince1970: 1_000_000)
        var nowValue = base
        let (store, _) = makeSnoozeStore(count: 3, clock: { nowValue })
        await store.refresh(userId: "u1")
        XCTAssertTrue(store.hasOrphans)

        store.snooze()
        XCTAssertTrue(store.isSnoozed)
        XCTAssertFalse(store.hasOrphans, "Snoozed banner must hide")

        // Still within the window → stays hidden.
        nowValue = base.addingTimeInterval(ReconcileBadgeStore.snoozeWindow - 1)
        XCTAssertFalse(store.hasOrphans)
    }

    func test_snooze_reappears_afterWindowElapses() async {
        let base = Date(timeIntervalSince1970: 2_000_000)
        var nowValue = base
        let (store, _) = makeSnoozeStore(count: 2, clock: { nowValue })
        await store.refresh(userId: "u1")
        store.snooze()
        XCTAssertFalse(store.hasOrphans)

        // Past the window → the reminder returns.
        nowValue = base.addingTimeInterval(ReconcileBadgeStore.snoozeWindow + 1)
        XCTAssertFalse(store.isSnoozed)
        XCTAssertTrue(store.hasOrphans)
    }

    func test_snooze_reappears_whenNewOrphansAppear() async {
        let base = Date(timeIntervalSince1970: 3_000_000)
        let nowValue = base
        // Count grows from 1 → 4 across two refreshes.
        var current = 1
        let suite = "test.reconcile.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = ReconcileBadgeStore(
            fetchCount: { _ in current },
            defaults: defaults,
            now: { nowValue }
        )
        await store.refresh(userId: "u1")
        store.snooze()
        XCTAssertFalse(store.hasOrphans, "Snoozed at 1 orphan")

        // More unmatched listings show up — the banner should override the snooze.
        current = 4
        await store.refresh(userId: "u1")
        XCTAssertFalse(store.isSnoozed)
        XCTAssertTrue(store.hasOrphans)
    }

    func test_snooze_persistsAcrossInstances() async {
        let base = Date(timeIntervalSince1970: 4_000_000)
        let nowValue = base
        let suite = "test.reconcile.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!

        let first = ReconcileBadgeStore(fetchCount: { _ in 3 }, defaults: defaults, now: { nowValue })
        await first.refresh(userId: "u1")
        first.snooze()

        // A fresh instance (e.g. next launch) reads the persisted snooze.
        let second = ReconcileBadgeStore(fetchCount: { _ in 3 }, defaults: defaults, now: { nowValue })
        await second.refresh(userId: "u1")
        XCTAssertTrue(second.isSnoozed)
        XCTAssertFalse(second.hasOrphans)
    }

    func test_reset_clearsSnooze() async {
        let base = Date(timeIntervalSince1970: 5_000_000)
        let nowValue = base
        let (store, _) = makeSnoozeStore(count: 3, clock: { nowValue })
        await store.refresh(userId: "u1")
        store.snooze()
        XCTAssertTrue(store.isSnoozed)
        store.reset()
        XCTAssertNil(store.snoozedUntil)
        XCTAssertFalse(store.isSnoozed)
    }
}
