import XCTest
@testable import GradeThread

@MainActor
final class EbaySyncTests: XCTestCase {

    // MARK: - ListingsPullStarted decoding

    func test_listingsPullStarted_decodesOkAndMessage() throws {
        let json = #"""
        {"ok": true, "message": "Sync started in background."}
        """#
        let parsed = try JSONDecoder().decode(ListingsPullStarted.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.ok)
        XCTAssertEqual(parsed.message, "Sync started in background.")
    }

    func test_listingsPullStarted_messageOptional() throws {
        let json = #"""
        {"ok": true}
        """#
        let parsed = try JSONDecoder().decode(ListingsPullStarted.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.ok)
        XCTAssertNil(parsed.message)
    }

    // MARK: - EbaySyncService.didAdvance

    func test_didAdvance_returnsTrueForFirstEverSync() {
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0, lastSyncedAt: nil
        )
        XCTAssertTrue(svc.didAdvance(baseline: baseline, current: "2026-05-27T14:00:00Z"))
    }

    func test_didAdvance_returnsFalseWhenCurrentIsNil() {
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0,
            lastSyncedAt: "2026-05-27T14:00:00Z"
        )
        XCTAssertFalse(svc.didAdvance(baseline: baseline, current: nil))
    }

    func test_didAdvance_returnsFalseWhenSameTimestamp() {
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0,
            lastSyncedAt: "2026-05-27T14:00:00Z"
        )
        XCTAssertFalse(svc.didAdvance(baseline: baseline, current: "2026-05-27T14:00:00Z"))
    }

    func test_didAdvance_returnsTrueWhenCurrentIsNewer() {
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0,
            lastSyncedAt: "2026-05-27T14:00:00.000Z"
        )
        XCTAssertTrue(svc.didAdvance(
            baseline: baseline,
            current: "2026-05-27T14:05:30.000Z"
        ))
    }

    func test_didAdvance_handlesMixedPrecisionISOStrings() {
        // Baseline has fractional seconds; current doesn't — date parser
        // should still treat the newer one as advanced.
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0,
            lastSyncedAt: "2026-05-27T14:00:00.000Z"
        )
        XCTAssertTrue(svc.didAdvance(
            baseline: baseline,
            current: "2026-05-27T14:05:00Z"
        ))
    }

    func test_didAdvance_returnsFalseWhenCurrentIsOlder() {
        // US-1007: the parse path (now backed by hoisted static formatters)
        // must order an OLDER current strictly before the baseline.
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0,
            lastSyncedAt: "2026-05-27T14:05:00.000Z"
        )
        XCTAssertFalse(svc.didAdvance(
            baseline: baseline,
            current: "2026-05-27T14:00:00Z"
        ))
    }

    func test_didAdvance_isStableAcrossManyCalls() {
        // US-1007: hoisting the ISO8601 formatters to cached statics must not
        // change behavior under repeated reuse (the poll loop calls this every
        // tick). Hammer it and assert a consistent verdict each time.
        let svc = EbaySyncService()
        let baseline = EbaySyncBaseline(
            listings: 0, activeListings: 0, sales: 0,
            lastSyncedAt: "2026-05-27T14:00:00.000Z"
        )
        for _ in 0..<500 {
            XCTAssertTrue(svc.didAdvance(
                baseline: baseline,
                current: "2026-05-27T14:05:30.250Z"
            ))
            XCTAssertFalse(svc.didAdvance(
                baseline: baseline,
                current: "2026-05-27T13:59:59Z"
            ))
        }
    }

    // MARK: - EbaySyncStore phase transitions

    func test_store_initial_idle() {
        let store = EbaySyncStore()
        XCTAssertEqual(store.phase, .idle)
        XCTAssertNil(store.phase.stageLabel)
    }

    func test_store_beginSync_flipsToStartingThenSyncing() {
        let store = EbaySyncStore()
        store.beginSync()
        // beginSync immediately enters .syncing(stageIndex: 0) so the
        // first stage label is visible before the timer rotates.
        XCTAssertEqual(store.phase, .syncing(stageIndex: 0))
        XCTAssertEqual(store.phase.stageLabel, EbaySyncStore.stages[0])
    }

    func test_store_apply_completion_movesToCompleted() {
        let store = EbaySyncStore()
        store.beginSync()
        let summary = EbaySyncSummary(
            listingsCount: 12, activeListingsCount: 5, salesCount: 3,
            listingsDelta: 2, salesDelta: 1
        )
        store.apply(.completed(summary))
        XCTAssertEqual(store.phase, .completed(summary))
    }

    func test_store_apply_timeout_movesToTimedOut() {
        let store = EbaySyncStore()
        store.beginSync()
        store.apply(.timedOut)
        XCTAssertEqual(store.phase, .timedOut)
    }

    func test_store_apply_connectionFlagged_carriesMessage() {
        let store = EbaySyncStore()
        store.beginSync()
        store.apply(.connectionFlagged(message: "invalid_grant"))
        XCTAssertEqual(store.phase, .connectionFlagged(message: "invalid_grant"))
    }

    func test_store_reset_returnsToIdle() {
        let store = EbaySyncStore()
        store.beginSync()
        store.apply(.timedOut)
        store.reset()
        XCTAssertEqual(store.phase, .idle)
    }

    func test_store_stageLabel_nilWhenNotSyncing() {
        let store = EbaySyncStore()
        store.beginSync()
        store.apply(.completed(EbaySyncSummary()))
        XCTAssertNil(store.phase.stageLabel)
    }

    // MARK: - EbaySyncSummary defaults

    func test_summary_zeroDefaults() {
        let summary = EbaySyncSummary()
        XCTAssertEqual(summary.listingsCount, 0)
        XCTAssertEqual(summary.salesCount, 0)
        XCTAssertEqual(summary.listingsDelta, 0)
    }
}
