import XCTest
@testable import GradeThread

/// US-2557: the unread count behind the tab badge and the app-icon badge.
///
/// Modelled on ``ReconcileBadgeStoreTests`` because the store is modelled on
/// ``ReconcileBadgeStore``. The cases that matter here are the ones where the
/// two DIFFER, and each is a decision the store's own header states rather than
/// an implementation detail:
///
/// - a failed refresh keeps the last count AND leaves the icon untouched,
/// - the icon and the in-app number are written from the same value, so a push
///   and the badge cannot disagree,
/// - reset() clears both, and is not a latch.
///
/// The re-entrancy guard is NOT covered, and the reason is written where that
/// test would have gone rather than left as an absence.
///
/// ⚠ NOT COMPILED LOCALLY. iOS cannot be built from the Windows checkout; the
/// iOS CI lane on macOS runners is the gate, which is US-2557 AC5. This file is
/// written against the store's signatures and is unverified until that lane
/// runs.
@MainActor
final class UnreadBadgeStoreTests: XCTestCase {

    private struct CountError: Error {}

    // MARK: - The happy path

    func test_refresh_setsCount_andShowsBadge() async {
        let store = UnreadBadgeStore(fetchCount: { 3 }, setIconBadge: { _ in })
        XCTAssertFalse(store.hasUnread)
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 3)
        XCTAssertTrue(store.hasUnread)
    }

    func test_refresh_zero_hidesBadge() async {
        let store = UnreadBadgeStore(fetchCount: { 0 }, setIconBadge: { _ in })
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertFalse(store.hasUnread)
    }

    // MARK: - The icon and the number cannot disagree

    func test_refresh_writesTheSameCountToTheIcon() async {
        // The store's stated reason for reading the edge route rather than the
        // table: the number on the icon and the number in a push come from one
        // counter. If these two could differ, that guarantee is gone.
        var written: [Int] = []
        let store = UnreadBadgeStore(fetchCount: { 7 }, setIconBadge: { written.append($0) })
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 7)
        XCTAssertEqual(written, [7])
    }

    // MARK: - A blip is not "no unread mail"

    func test_refresh_failure_preservesLastKnownCount() async {
        var shouldThrow = false
        let store = UnreadBadgeStore(
            fetchCount: {
                if shouldThrow { throw CountError() }
                return 5
            },
            setIconBadge: { _ in }
        )
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 5)

        shouldThrow = true
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 5, "a failed read must not clear the badge")
        XCTAssertTrue(store.hasUnread)
    }

    func test_refresh_failure_leavesTheIconAlone() async {
        // Distinct from the case above and the sharper half of it. Writing 0 on
        // a failed read would clear an icon showing five unread because the
        // network hiccupped — which is exactly why the route answers 503 rather
        // than 0. Preserving the in-app number while still zeroing the icon
        // would be the same bug wearing a disguise.
        var shouldThrow = false
        var written: [Int] = []
        let store = UnreadBadgeStore(
            fetchCount: {
                if shouldThrow { throw CountError() }
                return 5
            },
            setIconBadge: { written.append($0) }
        )
        await store.refresh()
        XCTAssertEqual(written, [5])

        shouldThrow = true
        await store.refresh()
        XCTAssertEqual(written, [5], "a failed read must not touch the app icon at all")
    }

    // MARK: - Refusals

    func test_refresh_clampsANegativeCountToZero() async {
        // The route should never send one; a negative badge is not a thing iOS
        // can render, and max(0,) is what stops a bad payload becoming a crash
        // or a nonsense icon.
        var written: [Int] = []
        let store = UnreadBadgeStore(fetchCount: { -4 }, setIconBadge: { written.append($0) })
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertEqual(written, [0])
        XCTAssertFalse(store.hasUnread)
    }

    // ⚠ THE RE-ENTRANCY GUARD IS DELIBERATELY NOT TESTED HERE, and that is a
    // gap rather than a decision that it does not matter.
    //
    // `isRefreshing` exists because MainShell refreshes on appear AND on every
    // foreground, so a user flicking between apps could queue a fetch per
    // switch. Exercising it needs two refreshes genuinely overlapping, and both
    // the store and this test are @MainActor — whether the second call arrives
    // while the first is suspended depends on actor reentrancy and on where the
    // stub yields, not on the guard.
    //
    // A test that passes for the wrong reason is worse than an absent one, and
    // I cannot run this suite from the Windows checkout to find out which I
    // wrote. Whoever next opens this on a Mac: drive it with an explicit
    // continuation the stub waits on, so the overlap is caused rather than
    // hoped for.

    func test_secondRefreshAfterTheFirstCompletes_readsAgain() async {
        // What CAN be asserted without scheduling games: the guard is not a
        // latch. It must swallow a concurrent call and still allow the next
        // sequential one, or the badge freezes at its first value.
        var calls = 0
        let store = UnreadBadgeStore(
            fetchCount: {
                calls += 1
                return calls
            },
            setIconBadge: { _ in }
        )
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(calls, 2, "isRefreshing must clear once a refresh finishes")
        XCTAssertEqual(store.unreadCount, 2)
    }

    // MARK: - Clearing

    func test_reset_clearsCountAndIcon() async {
        // The server only ever RAISES the badge — a push cannot know a
        // notification was read on another device — so clearing is the app's job
        // on the same signal that marks rows read.
        var written: [Int] = []
        let store = UnreadBadgeStore(fetchCount: { 9 }, setIconBadge: { written.append($0) })
        await store.refresh()
        XCTAssertEqual(store.unreadCount, 9)

        await store.reset()
        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertFalse(store.hasUnread)
        XCTAssertEqual(written, [9, 0], "reset must clear the icon, not only the tab")
    }

    func test_reset_thenRefresh_readsTheServerAgain() async {
        // reset() is not a latch. Signing back in, or a new notification after
        // marking all read, must be able to raise the badge again.
        var written: [Int] = []
        let store = UnreadBadgeStore(fetchCount: { 4 }, setIconBadge: { written.append($0) })
        await store.reset()
        XCTAssertEqual(store.unreadCount, 0)

        await store.refresh()
        XCTAssertEqual(store.unreadCount, 4)
        XCTAssertEqual(written, [0, 4])
    }
}
