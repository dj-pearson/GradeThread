import XCTest
@testable import GradeThread

/// US-1261: the pure home-surface decision. An existing user opening the app
/// offline before the cache populates must NOT see the first-run Welcome (it
/// looks like their inventory vanished) — they get an unavailable/retry state.
/// Like the other Dashboard tests, this runs without a `ModelContainer`.
final class DashboardHomeDisplayTests: XCTestCase {

    // MARK: - The bug: offline cold launch, empty cache

    func test_offlineColdLaunch_emptyCache_isUnavailable_notWelcome() {
        let display = DashboardView.display(hasItems: false, hasSales: false, phase: .offline)
        XCTAssertEqual(display, .unavailable)
        XCTAssertNotEqual(display, .welcome, "An offline existing user must not see the first-run Welcome")
    }

    // MARK: - First-run Welcome only when genuinely empty AND online/synced

    func test_emptyCache_idle_showsWelcome() {
        XCTAssertEqual(DashboardView.display(hasItems: false, hasSales: false, phase: .idle), .welcome)
    }

    func test_emptyCache_pending_showsWelcome() {
        // Online with queued local changes is still "online/synced" enough to
        // distinguish a genuinely-new user.
        XCTAssertEqual(DashboardView.display(hasItems: false, hasSales: false, phase: .pending), .welcome)
    }

    // MARK: - In-flight sync shows the loading skeleton, never Welcome (US-693)

    func test_emptyCache_syncing_showsLoading() {
        XCTAssertEqual(DashboardView.display(hasItems: false, hasSales: false, phase: .syncing), .loading)
    }

    func test_emptyCache_reconnecting_showsLoading() {
        XCTAssertEqual(DashboardView.display(hasItems: false, hasSales: false, phase: .reconnecting), .loading)
    }

    // MARK: - Any cached data wins regardless of phase

    func test_withItems_showsContent_evenOffline() {
        XCTAssertEqual(DashboardView.display(hasItems: true, hasSales: false, phase: .offline), .content)
    }

    func test_withSales_showsContent_evenOffline() {
        XCTAssertEqual(DashboardView.display(hasItems: false, hasSales: true, phase: .offline), .content)
    }

    func test_withItems_showsContent_whileSyncing() {
        XCTAssertEqual(DashboardView.display(hasItems: true, hasSales: true, phase: .syncing), .content)
    }
}
