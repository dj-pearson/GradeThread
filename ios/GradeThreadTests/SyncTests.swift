import XCTest
import SwiftData
@testable import GradeThread

@MainActor
final class SyncTests: XCTestCase {

    // NOTE: the ConflictPolicy tests moved to GradeThreadCore (the package) so
    // they run on Linux via `swift test`. See
    // Packages/GradeThreadCore/Tests/GradeThreadCoreTests/ConflictPolicyTests.swift.

    // MARK: - US-1244 listing-price selection (market value from the live listing)

    func test_selectListingPrices_prefersLiveOverNewerEndedListing() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        let t1 = Date(timeIntervalSince1970: 2_000)   // newer
        // An ended listing relisted at a newer timestamp must NOT win over the
        // live (active) listing for the same item.
        let prices = SyncEngine.selectListingPrices([
            (itemId: "i1", price: 40, at: t0, isLive: true),    // active, older
            (itemId: "i1", price: 999, at: t1, isLive: false),  // ended, newer
        ])
        XCTAssertEqual(prices["i1"], 40)
    }

    func test_selectListingPrices_newestWinsWithinSameLiveness() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        let t1 = Date(timeIntervalSince1970: 2_000)
        let prices = SyncEngine.selectListingPrices([
            (itemId: "i1", price: 40, at: t0, isLive: true),
            (itemId: "i1", price: 55, at: t1, isLive: true),   // newer live wins
        ])
        XCTAssertEqual(prices["i1"], 55)
    }

    func test_selectListingPrices_fallsBackToNonLiveWhenNoneLive() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        let prices = SyncEngine.selectListingPrices([
            (itemId: "i1", price: 30, at: t0, isLive: false),  // only an ended listing
        ])
        XCTAssertEqual(prices["i1"], 30)
    }

    // MARK: - PendingMutation queue

    func test_pendingMutation_roundtripsThroughSwiftData() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)

        struct CreateItemPayload: Codable, Equatable {
            let title: String
            let brand: String?
        }

        let payload = CreateItemPayload(title: "Wool coat", brand: "Pendleton")
        let payloadData = try JSONEncoder().encode(payload)

        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: payloadData,
            targetId: nil
        )
        context.insert(mutation)
        try context.save()

        // Read back through a fresh context to verify persistence.
        let readContext = ModelContext(container)
        let descriptor = FetchDescriptor<LocalPendingMutation>()
        let rows = try readContext.fetch(descriptor)

        XCTAssertEqual(rows.count, 1)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.kindEnum, .createInventoryItem)
        XCTAssertEqual(row.retryCount, 0)
        let decoded = try JSONDecoder().decode(CreateItemPayload.self, from: row.payload)
        XCTAssertEqual(decoded, payload)
    }

    func test_pendingMutation_unknownKindIsDetectable() {
        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: Data()
        )
        // Stomp the raw storage as if a future client wrote a kind we don't
        // know yet. kindEnum should yield nil so the engine can shelve it.
        mutation.kind = "future_kind_we_dont_know"
        XCTAssertNil(mutation.kindEnum)
    }

    // MARK: - OfflineMutationQueue (US-982)

    func test_offlineQueue_enqueueCreate_injectsClientIdAndPersists() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)

        struct ExpensePayload: Encodable {
            let user_id: String
            let category: String
            let amount: Double
        }
        let id = OfflineMutationQueue.enqueueCreate(
            kind: .createExpense,
            payload: ExpensePayload(user_id: "u1", category: "other", amount: 12.5),
            in: context
        )
        let clientId = try XCTUnwrap(id)

        let rows = try ModelContext(container).fetch(FetchDescriptor<LocalPendingMutation>())
        XCTAssertEqual(rows.count, 1)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.kindEnum, .createExpense)
        // targetId mirrors the injected id so the inspector can name the row.
        XCTAssertEqual(row.targetId, clientId)
        // The payload carries the client id so replay UPSERTs idempotently.
        let dict = try JSONSerialization.jsonObject(with: row.payload) as? [String: Any]
        XCTAssertEqual(dict?["id"] as? String, clientId)
        XCTAssertEqual(dict?["category"] as? String, "other")
    }

    func test_offlineQueue_enqueueDelete_carriesTargetIdOnly() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)
        OfflineMutationQueue.enqueueDelete(kind: .deleteExpense, targetId: "exp-1", in: context)

        let row = try XCTUnwrap(
            try ModelContext(container).fetch(FetchDescriptor<LocalPendingMutation>()).first
        )
        XCTAssertEqual(row.kindEnum, .deleteExpense)
        XCTAssertEqual(row.targetId, "exp-1")
        XCTAssertTrue(row.payload.isEmpty)
    }

    func test_offlineQueue_enqueueUpdate_targetsRowAndEncodesPatch() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)
        struct Patch: Encodable { let title: String }
        let ok = OfflineMutationQueue.enqueueUpdate(
            kind: .updateInventoryItem, payload: Patch(title: "Edited"),
            targetId: "item-1", in: context
        )
        XCTAssertTrue(ok)
        let row = try XCTUnwrap(
            try ModelContext(container).fetch(FetchDescriptor<LocalPendingMutation>()).first
        )
        XCTAssertEqual(row.kindEnum, .updateInventoryItem)
        XCTAssertEqual(row.targetId, "item-1")
        let dict = try JSONSerialization.jsonObject(with: row.payload) as? [String: Any]
        XCTAssertEqual(dict?["title"] as? String, "Edited")
    }

    /// AC5: only genuine connectivity failures are queued; app-level rejections
    /// (4xx / RLS / validation) must NOT queue — they would replay forever.
    func test_offlineQueue_shouldQueue_networkYesAppRejectionNo() {
        let offline = URLError(.notConnectedToInternet)
        XCTAssertTrue(OfflineMutationQueue.shouldQueue(offline))

        let rejection = NSError(
            domain: "PostgrestError", code: 400,
            userInfo: [NSLocalizedDescriptionKey: "duplicate key value violates unique constraint"]
        )
        XCTAssertFalse(OfflineMutationQueue.shouldQueue(rejection))
    }

    // MARK: - SyncStatusStore

    func test_statusStore_promotesIdleToPendingWhenQueueGrows() {
        let store = SyncStatusStore()
        XCTAssertEqual(store.phase, .idle)
        XCTAssertEqual(store.pendingCount, 0)

        store.setPendingCount(3)
        XCTAssertEqual(store.phase, .pending)
        XCTAssertEqual(store.pendingCount, 3)
    }

    func test_statusStore_demotesPendingBackToIdleWhenQueueDrains() {
        let store = SyncStatusStore()
        store.setPendingCount(2)
        XCTAssertEqual(store.phase, .pending)

        store.setPendingCount(0)
        XCTAssertEqual(store.phase, .idle)
    }

    func test_statusStore_doesNotOverrideSyncingWhilePending() {
        let store = SyncStatusStore()
        store.set(.syncing)
        store.setPendingCount(5)
        // Mid-sync we want the spinner, not the "5 pending" banner — the
        // engine flips back to .pending explicitly when the sync ends.
        XCTAssertEqual(store.phase, .syncing)
        XCTAssertEqual(store.pendingCount, 5)
    }

    // MARK: - Backoff (US-638)

    func test_backoff_isExponentialAndCapped() {
        XCTAssertEqual(Backoff.delayNanos(attempt: 0, base: 1, cap: 8), 1_000_000_000)
        XCTAssertEqual(Backoff.delayNanos(attempt: 1, base: 1, cap: 8), 2_000_000_000)
        XCTAssertEqual(Backoff.delayNanos(attempt: 2, base: 1, cap: 8), 4_000_000_000)
        XCTAssertEqual(Backoff.delayNanos(attempt: 3, base: 1, cap: 8), 8_000_000_000)
        // Capped beyond the ceiling.
        XCTAssertEqual(Backoff.delayNanos(attempt: 9, base: 1, cap: 8), 8_000_000_000)
    }

    func test_jitteredBackoff_staysWithinHalfToFullWindow() {
        // Equal jitter: the delay is d/2 at fraction 0, d at fraction 1, and the
        // midpoint at 0.5 — always within [d/2, d], never below half the backoff.
        let ceiling = Backoff.delayNanos(attempt: 2, base: 1, cap: 8)   // 4s
        XCTAssertEqual(
            Backoff.jitteredDelayNanos(attempt: 2, base: 1, cap: 8, randomFraction: 0),
            ceiling / 2)
        XCTAssertEqual(
            Backoff.jitteredDelayNanos(attempt: 2, base: 1, cap: 8, randomFraction: 1),
            ceiling)
        XCTAssertEqual(
            Backoff.jitteredDelayNanos(attempt: 2, base: 1, cap: 8, randomFraction: 0.5),
            ceiling / 2 + ceiling / 4)
    }

    func test_jitteredBackoff_clampsOutOfRangeFraction() {
        // An out-of-range fraction can't push the delay outside [d/2, d].
        let ceiling = Backoff.delayNanos(attempt: 1, base: 1, cap: 8)   // 2s
        XCTAssertEqual(
            Backoff.jitteredDelayNanos(attempt: 1, base: 1, cap: 8, randomFraction: -5),
            ceiling / 2)
        XCTAssertEqual(
            Backoff.jitteredDelayNanos(attempt: 1, base: 1, cap: 8, randomFraction: 5),
            ceiling)
    }

    // MARK: - ConnectivityDebouncer (US-997)

    /// Five reconnects in quick succession (a Wi-Fi↔cell flap storm) must
    /// collapse into at most one flush+pull.
    func test_connectivityDebouncer_coalescesBurstIntoSingleRun() async throws {
        let counter = DebounceCallCounter()
        let debouncer = ConnectivityDebouncer(window: .milliseconds(80)) {
            await counter.bump()
        }
        for _ in 0..<5 { await debouncer.trigger() }
        // Wait well past the window for the single trailing run to fire.
        try await Task.sleep(for: .milliseconds(400))
        let runs = await counter.value
        XCTAssertEqual(runs, 1, "5 flaps within one window must coalesce to <= 1 sync")
    }

    /// Going offline (cancel) before the window elapses must drop the pending
    /// sync entirely — it would only fail offline.
    func test_connectivityDebouncer_cancelPreventsPendingRun() async throws {
        let counter = DebounceCallCounter()
        let debouncer = ConnectivityDebouncer(window: .milliseconds(80)) {
            await counter.bump()
        }
        await debouncer.trigger()
        await debouncer.cancel()
        try await Task.sleep(for: .milliseconds(300))
        let runs = await counter.value
        XCTAssertEqual(runs, 0, "a cancelled (offline) debounce must not fire")
    }

    /// Distinct bursts separated by a settled window each sync once — the
    /// debouncer defers, it doesn't permanently swallow.
    func test_connectivityDebouncer_runsAgainAfterWindowSettles() async throws {
        let counter = DebounceCallCounter()
        let debouncer = ConnectivityDebouncer(window: .milliseconds(60)) {
            await counter.bump()
        }
        await debouncer.trigger()
        try await Task.sleep(for: .milliseconds(220))
        await debouncer.trigger()
        try await Task.sleep(for: .milliseconds(220))
        let runs = await counter.value
        XCTAssertEqual(runs, 2, "two settled bursts each fire one sync")
    }

    // MARK: - SyncWatermark (US-633)

    func test_watermark_firstReadIsNil() {
        let wm = SyncWatermark(defaults: freshDefaults())
        XCTAssertNil(wm.value(for: .inventoryItems))
    }

    func test_watermark_advanceIsMonotonic() {
        let wm = SyncWatermark(defaults: freshDefaults())
        wm.advance(.inventoryItems, to: "2026-06-01T00:00:00Z")
        XCTAssertEqual(wm.value(for: .inventoryItems), "2026-06-01T00:00:00Z")
        // A stale candidate must not rewind the cursor.
        wm.advance(.inventoryItems, to: "2026-05-01T00:00:00Z")
        XCTAssertEqual(wm.value(for: .inventoryItems), "2026-06-01T00:00:00Z")
        // A newer candidate advances it.
        wm.advance(.inventoryItems, to: "2026-07-01T00:00:00Z")
        XCTAssertEqual(wm.value(for: .inventoryItems), "2026-07-01T00:00:00Z")
    }

    func test_watermark_nilOrEmptyCandidateIsIgnored() {
        let wm = SyncWatermark(defaults: freshDefaults())
        wm.advance(.sales, to: nil)
        wm.advance(.sales, to: "")
        XCTAssertNil(wm.value(for: .sales))
    }

    func test_watermark_resetClearsAllTables() {
        let wm = SyncWatermark(defaults: freshDefaults())
        wm.advance(.inventoryItems, to: "2026-06-01T00:00:00Z")
        wm.advance(.sales, to: "2026-06-01T00:00:00Z")
        wm.resetAll()
        XCTAssertNil(wm.value(for: .inventoryItems))
        XCTAssertNil(wm.value(for: .sales))
    }

    func test_watermark_cursorColumns() {
        // US-1515: sales + item_photos gained updated_at (migration 00332), so
        // EVERY table now deltas on updated_at (edits move the cursor, not just
        // inserts). flipdesk_expenses had updated_at since 00019; disputes since
        // US-819.
        XCTAssertEqual(SyncWatermark.Table.inventoryItems.cursorColumn, "updated_at")
        XCTAssertEqual(SyncWatermark.Table.itemPhotos.cursorColumn, "updated_at")
        XCTAssertEqual(SyncWatermark.Table.sales.cursorColumn, "updated_at")
        XCTAssertEqual(SyncWatermark.Table.expenses.cursorColumn, "updated_at")
        XCTAssertEqual(SyncWatermark.Table.disputes.cursorColumn, "updated_at")
    }

    // MARK: - WidgetSnapshot diff (US-637)

    func test_widgetSnapshot_sameRollupIgnoresGeneratedAt() {
        let a = WidgetSnapshot(generatedAt: Date(timeIntervalSince1970: 0), isSignedIn: true,
                               activeListings: 3, soldTodayCount: 1, soldTodayGross: 50,
                               pendingPayoutCount: 2, pendingPayoutNet: 80)
        let b = WidgetSnapshot(generatedAt: Date(timeIntervalSince1970: 9999), isSignedIn: true,
                               activeListings: 3, soldTodayCount: 1, soldTodayGross: 50,
                               pendingPayoutCount: 2, pendingPayoutNet: 80)
        XCTAssertTrue(a.hasSameRollup(as: b))
    }

    func test_widgetSnapshot_differentRollupDetected() {
        let a = WidgetSnapshot.placeholder
        let b = WidgetSnapshot(generatedAt: .now, isSignedIn: true,
                               activeListings: a.activeListings + 1, soldTodayCount: a.soldTodayCount,
                               soldTodayGross: a.soldTodayGross, pendingPayoutCount: a.pendingPayoutCount,
                               pendingPayoutNet: a.pendingPayoutNet)
        XCTAssertFalse(a.hasSameRollup(as: b))
    }

    // MARK: - SyncMergeActor off-main merge (US-634)

    func test_mergeActor_insertsThenUpdatesItems() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Linen blazer", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: [:],
            prune: false
        )
        var rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.title, "Linen blazer")

        // Re-merge the same id with a new title → upsert, not duplicate.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Linen blazer (updated)", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:],
            prune: false
        )
        rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.title, "Linen blazer (updated)")
    }

    func test_mergeActor_staleDeltaDoesNotRewindNewerRow() async throws {
        // A non-dirty row already holding the newer server state (T2) must not be
        // clobbered by an older snapshot (T1<T2) arriving in a later/racing merge —
        // e.g. a realtime apply landed T2, then a bulk delta pull carrying T1 runs.
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Fresh", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        // Stale delta for the same id arrives after — must be ignored, not applied.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Stale", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )

        let rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.title, "Fresh")   // not rewound to "Stale"
    }

    func test_mergeActor_prunesStaleItemsOnFullBackfill() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        // Seed two items.
        await actor.mergeItems(
            [
                Self.remoteItem(id: "a", title: "Keep", updated: "2026-06-01T00:00:00Z"),
                Self.remoteItem(id: "b", title: "Stale", updated: "2026-06-01T00:00:00Z"),
            ],
            primaryPhotos: [:], prune: false
        )
        XCTAssertEqual(
            try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).count, 2
        )

        // US-1221: the item's market price is now derived from its cached
        // listings, not a passed-in map — seed a listing for "a" priced 42.
        await actor.mergeListings([Self.remoteListing(id: "l-a", itemId: "a", price: 42)])

        // Full backfill (prune) that only returns "a" → "b" is removed.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Keep", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], prune: true
        )
        let rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.id, "a")
        XCTAssertEqual(rows.first?.listingPrice, 42)
    }

    // MARK: - Listing-price derivation from cache (US-1221)

    func test_mergeListings_derivesLatestPriceOntoItem() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "i1", title: "Tee", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        // Two listings for the same item; the later-listed one's price wins.
        await actor.mergeListings([
            Self.remoteListing(id: "l1", itemId: "i1", price: 20, listedAt: "2026-06-01T00:00:00Z"),
            Self.remoteListing(id: "l2", itemId: "i1", price: 35, listedAt: "2026-06-03T00:00:00Z"),
        ])

        let item = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(item?.listingPrice, 35)
    }

    func test_mergeListings_priceChangeWithoutItemDeltaUpdatesItem() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "i1", title: "Tee", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        await actor.mergeListings([Self.remoteListing(id: "l1", itemId: "i1", price: 50)])
        // A later listings-only delta (no item change) must still refresh price.
        await actor.mergeListings([Self.remoteListing(id: "l1", itemId: "i1", price: 65)])

        let item = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(item?.listingPrice, 65)
    }

    // MARK: - US-1249: listing conflict provenance + sale dirty-guard + cover clear

    func test_mergeListings_gtOriginDirtyKeepsLocalPriceAndStatus() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        let l = LocalListing(id: "l1", inventoryItemId: "i1", platform: "ebay",
                             listingPrice: 99, listingStatus: "active")
        l.listingOrigin = "gradethread"
        l.hasLocalChanges = true          // a pending local edit not yet pushed
        ctx.insert(l)
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        // Server pull carries a different price/status for the same listing.
        await actor.mergeListings([
            Self.remoteListing(id: "l1", itemId: "i1", price: 40, status: "ended",
                               origin: "gradethread"),
        ])
        let row = try ModelContext(container).fetch(FetchDescriptor<LocalListing>()).first
        XCTAssertEqual(row?.listingPrice, 99)          // GT-owned local edit preserved
        XCTAssertEqual(row?.listingStatus, "active")   // GT-owned local edit preserved
    }

    func test_mergeListings_ebayOriginServerWinsEvenWhenDirty() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        let l = LocalListing(id: "l1", inventoryItemId: "i1", platform: "ebay",
                             listingPrice: 99, listingStatus: "active")
        l.listingOrigin = "ebay"
        l.hasLocalChanges = true
        ctx.insert(l)
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        await actor.mergeListings([
            Self.remoteListing(id: "l1", itemId: "i1", price: 40, status: "ended",
                               origin: "ebay"),
        ])
        let row = try ModelContext(container).fetch(FetchDescriptor<LocalListing>()).first
        XCTAssertEqual(row?.listingPrice, 40)          // eBay is authoritative
        XCTAssertEqual(row?.listingStatus, "ended")
    }

    func test_mergeSales_netUsesComponentMathNotStoredValue() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)
        // Server sends a WRONG stored net_profit; component math must override it.
        await actor.mergeSales([
            Self.remoteSale(id: "s1", itemId: "i1", salePrice: 100, platformFees: 10,
                            paymentProcessingFees: 3, shippingCollected: 5, shippingCost: 4,
                            gradingCost: 2, otherCosts: 1, tax: 8, netProfit: 999),
        ])
        let row = try ModelContext(container).fetch(FetchDescriptor<LocalSale>()).first
        // revenue = 100 + 5 = 105; fees = 10 + 3 = 13; sellerCosts = 4 + 2 + 1 = 7
        // net = 105 − 13 − 7 = 85   (tax pass-through + cost basis both excluded)
        XCTAssertEqual(try XCTUnwrap(row?.netProfit), 85, accuracy: 0.001)
    }

    func test_mergeSales_dirtyGuardKeepsLocalSellerCosts() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        let s = LocalSale(id: "s1", inventoryItemId: "i1", salePrice: 50, saleDate: .now)
        s.gradingCost = 7
        s.shippingCost = 9
        s.otherCosts = 1
        s.hasLocalChanges = true          // pending local cost edits not yet pushed
        ctx.insert(s)
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        // Server resends the sale with the seller-cost fields zeroed.
        await actor.mergeSales([
            Self.remoteSale(id: "s1", itemId: "i1", salePrice: 50, platformFees: 5,
                            paymentProcessingFees: 0, shippingCollected: 0, shippingCost: 0,
                            gradingCost: 0, otherCosts: 0, tax: 0, netProfit: 0),
        ])
        let row = try ModelContext(container).fetch(FetchDescriptor<LocalSale>()).first
        // User-editable costs survive the pull…
        XCTAssertEqual(row?.gradingCost, 7)
        XCTAssertEqual(row?.shippingCost, 9)
        XCTAssertEqual(row?.otherCosts, 1)
        // …while server-owned money still refreshes.
        XCTAssertEqual(row?.platformFees, 5)
        // Net reflects the guarded local costs: 50 − 5 − (9+7+1) = 28.
        XCTAssertEqual(try XCTUnwrap(row?.netProfit), 28, accuracy: 0.001)
    }

    func test_mergePhotos_clearsCoverWhenLastPhotoPrunedOnBackfill() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Tee", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: ["a": Self.remotePhoto(id: "p1", itemId: "a")], prune: false
        )
        await actor.mergePhotos([Self.remotePhoto(id: "p1", itemId: "a")], prune: false)
        XCTAssertNotNil(
            try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first?.primaryPhotoURL
        )

        // Full backfill returning NO photos → p1 is stale and pruned → the item's
        // last photo is gone, so its cached cover thumbnail must be cleared.
        await actor.mergePhotos([], prune: true)
        let item = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertTrue(try ModelContext(container).fetch(FetchDescriptor<LocalItemPhoto>()).isEmpty)
        XCTAssertNil(item?.primaryPhotoURL)
    }

    func test_reconcileDeletes_clearsCoverWhenLastPhotoDeletedViaDelta() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Tee", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: ["a": Self.remotePhoto(id: "p1", itemId: "a")], prune: false
        )
        await actor.mergePhotos([Self.remotePhoto(id: "p1", itemId: "a")], prune: false)

        // Server no longer has p1 → reconcile prunes it → cover cleared.
        await actor.reconcileDeletes(
            scopeOwnerId: "u1",
            saleIds: nil, expenseIds: nil, listingIds: nil, photoIds: [], protectedIds: []
        )
        let item = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertNil(item?.primaryPhotoURL)
        XCTAssertTrue(try ModelContext(container).fetch(FetchDescriptor<LocalItemPhoto>()).isEmpty)
    }

    func test_mergeActor_pruneKeepsUnpushedLocalRows() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        // An offline-created row not yet on the server.
        let ctx = ModelContext(container)
        let localOnly = LocalInventoryItem(
            id: "local-1", userId: "u1", title: "Offline intake",
            status: "cataloged", hasLocalChanges: true
        )
        ctx.insert(localOnly)
        try ctx.save()

        // Full backfill that doesn't include it must NOT delete it.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Server", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], prune: true
        )
        let ids = try ModelContext(container)
            .fetch(FetchDescriptor<LocalInventoryItem>()).map(\.id).sorted()
        XCTAssertEqual(ids, ["a", "local-1"])
    }

    // MARK: - Delta merge fetches only affected rows (US-986)

    func test_mergeActor_deltaFetchesOnlyAffectedRows() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        // Seed a "large" store.
        let seed = (0..<50).map {
            Self.remoteItem(id: "item-\($0)", title: "Item \($0)", updated: "2026-06-01T00:00:00Z")
        }
        await actor.mergeItems(seed, primaryPhotos: [:], prune: false)

        // A 1-row delta against the large store must materialize only a handful
        // of rows, not all 50.
        await actor.mergeItems(
            [Self.remoteItem(id: "item-7", title: "Item 7 (updated)", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        let deltaFetched = await actor.lastMergeFetchedRowCount
        XCTAssertLessThanOrEqual(deltaFetched, 5, "delta merge should fetch only the touched row")

        // Full backfill (prune) still scans the whole table so stale locals can
        // be deleted.
        await actor.mergeItems(seed, primaryPhotos: [:], prune: true)
        let backfillFetched = await actor.lastMergeFetchedRowCount
        XCTAssertGreaterThanOrEqual(backfillFetched, 50, "full backfill must fetch the whole table to prune")
    }

    func test_mergePhotos_deltaFetchesOnlyAffectedRows() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        let items = (0..<30).map {
            Self.remoteItem(id: "item-\($0)", title: "Item \($0)", updated: "2026-06-01T00:00:00Z")
        }
        await actor.mergeItems(items, primaryPhotos: [:], prune: false)
        let photos = (0..<30).map { Self.remotePhoto(id: "p-\($0)", itemId: "item-\($0)") }
        await actor.mergePhotos(photos, prune: false)

        // 1-row photo delta: at most the touched photo + its one owning item.
        await actor.mergePhotos([Self.remotePhoto(id: "p-3", itemId: "item-3")], prune: false)
        let deltaFetched = await actor.lastMergeFetchedRowCount
        XCTAssertLessThanOrEqual(deltaFetched, 5, "photo delta should fetch only the touched photo + owner")
    }

    // MARK: - Dispute status sync (US-819)

    func test_mergeDisputes_stampsLatestStatusOntoItemByGradeReport() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "i1", title: "Disputed tee",
                             updated: "2026-06-01T00:00:00Z", gradeReportId: "gr-1")],
            primaryPhotos: [:], prune: false
        )

        // Two disputes for the same report → the latest (by updated_at) wins.
        await actor.mergeDisputes([
            Self.remoteDispute(id: "d1", reportId: "gr-1", status: "open",
                               updated: "2026-06-02T00:00:00Z"),
            Self.remoteDispute(id: "d2", reportId: "gr-1", status: "under_review",
                               updated: "2026-06-03T00:00:00Z"),
        ])

        let item = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(item?.gradeReportId, "gr-1")
        XCTAssertEqual(item?.disputeStatus, "under_review")
    }

    func test_mergeDisputes_touchesOnlyMatchingItem() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        // Large graded store — proves the badge sync isn't a per-row N+1 / full
        // scan: a single changed dispute fetches only its one item.
        let seed = (0..<40).map {
            Self.remoteItem(id: "i\($0)", title: "Item \($0)",
                            updated: "2026-06-01T00:00:00Z", gradeReportId: "gr-\($0)")
        }
        await actor.mergeItems(seed, primaryPhotos: [:], prune: false)

        await actor.mergeDisputes([
            Self.remoteDispute(id: "d1", reportId: "gr-7", status: "resolved",
                               updated: "2026-06-04T00:00:00Z"),
        ])
        let fetched = await actor.lastMergeFetchedRowCount
        XCTAssertLessThanOrEqual(fetched, 5, "dispute merge should fetch only the matching item")

        let disputed = try ModelContext(container)
            .fetch(FetchDescriptor<LocalInventoryItem>())
            .filter { $0.disputeStatus != nil }
        XCTAssertEqual(disputed.map(\.id), ["i7"])
        XCTAssertEqual(disputed.first?.disputeStatus, "resolved")
    }

    // MARK: - Item<->photo relationship (US-994)

    func test_deletingItem_cascadesPhotos() throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)

        let item = LocalInventoryItem(id: "i1", userId: "u1", title: "Tee")
        ctx.insert(item)
        let p1 = LocalItemPhoto(id: "p1", inventoryItemId: "i1", photoType: "front", photoURL: "u1")
        let p2 = LocalItemPhoto(id: "p2", inventoryItemId: "i1", photoType: "back", photoURL: "u2")
        ctx.insert(p1); ctx.insert(p2)
        p1.item = item; p2.item = item
        try ctx.save()

        XCTAssertEqual(item.photos.count, 2)
        XCTAssertEqual(try ctx.fetch(FetchDescriptor<LocalItemPhoto>()).count, 2)

        // Deleting the item cascades to its photos — no orphans left behind.
        ctx.delete(item)
        try ctx.save()
        XCTAssertEqual(try ctx.fetch(FetchDescriptor<LocalInventoryItem>()).count, 0)
        XCTAssertEqual(try ctx.fetch(FetchDescriptor<LocalItemPhoto>()).count, 0)
    }

    func test_mergePhotos_populatesItemRelationship() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Tee", updated: "2026-06-01T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        await actor.mergePhotos([Self.remotePhoto(id: "p1", itemId: "a")], prune: false)

        let ctx = ModelContext(container)
        let photo = try ctx.fetch(FetchDescriptor<LocalItemPhoto>()).first
        XCTAssertEqual(photo?.item?.id, "a")
        let item = try ctx.fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(item?.photos.count, 1)
        XCTAssertTrue(item?.hasPhotos ?? false)
    }

    private static func remotePhoto(id: String, itemId: String) -> SyncEngine.RemoteItemPhoto {
        let json = """
        {"id":"\(id)","inventory_item_id":"\(itemId)","photo_type":"front",
         "photo_url":"https://x/\(id).jpg","thumbnail_url":null,"storage_path":null,
         "sort_order":0,"bytes":null,"created_at":"2026-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(SyncEngine.RemoteItemPhoto.self, from: json)
    }

    private static func remoteItem(
        id: String, title: String, updated: String, gradeReportId: String? = nil
    ) -> SyncEngine.RemoteInventoryItem {
        let reportField = gradeReportId.map { "\"grade_report_id\":\"\($0)\"," } ?? ""
        let json = """
        {"id":"\(id)","user_id":"u1","title":"\(title)","status":"cataloged",
         \(reportField)
         "created_at":"2026-01-01T00:00:00Z","updated_at":"\(updated)"}
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(SyncEngine.RemoteInventoryItem.self, from: json)
    }

    private static func remoteDispute(
        id: String, reportId: String, status: String, updated: String
    ) -> SyncEngine.RemoteDispute {
        let json = """
        {"id":"\(id)","grade_report_id":"\(reportId)","status":"\(status)",
         "updated_at":"\(updated)","created_at":"2026-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(SyncEngine.RemoteDispute.self, from: json)
    }

    private static func remoteListing(
        id: String, itemId: String, price: Double,
        listedAt: String? = nil, status: String = "active", origin: String? = nil
    ) -> SyncEngine.RemoteListing {
        let listedField = listedAt.map { "\"listed_at\":\"\($0)\"," } ?? ""
        let originField = origin.map { "\"listing_origin\":\"\($0)\"," } ?? ""
        let json = """
        {"id":"\(id)","inventory_item_id":"\(itemId)","platform":"ebay",
         "listing_price":\(price),"listing_status":"\(status)",
         \(listedField)\(originField)
         "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-06-01T00:00:00Z"}
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(SyncEngine.RemoteListing.self, from: json)
    }

    // swiftlint:disable:next function_parameter_count
    private static func remoteSale(
        id: String, itemId: String, salePrice: Double, platformFees: Double,
        paymentProcessingFees: Double, shippingCollected: Double, shippingCost: Double,
        gradingCost: Double, otherCosts: Double, tax: Double, netProfit: Double?,
        status: String = "completed", saleDate: String = "2026-06-01T00:00:00Z"
    ) -> SyncEngine.RemoteSaleRow {
        let netField = netProfit.map { "\($0)" } ?? "null"
        let json = """
        {"id":"\(id)","inventory_item_id":"\(itemId)","sale_price":\(salePrice),
         "platform_fees":\(platformFees),"payment_processing_fees":\(paymentProcessingFees),
         "shipping_collected":\(shippingCollected),"shipping_cost":\(shippingCost),
         "grading_cost":\(gradingCost),"other_costs":\(otherCosts),"tax":\(tax),
         "net_profit":\(netField),"status":"\(status)","sale_date":"\(saleDate)",
         "buyer_username":null,"created_at":"2026-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(SyncEngine.RemoteSaleRow.self, from: json)
    }

    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "sync-test-\(UUID().uuidString)")!
    }

    // MARK: - Stuck-mutation surfacing (US-1147)

    func test_statusStore_stuckCount_surfacedDistinctlyFromPending() {
        let store = SyncStatusStore()
        store.setPendingCount(3, stuck: 1)
        XCTAssertEqual(store.pendingCount, 3)
        XCTAssertEqual(store.stuckCount, 1)
        XCTAssertEqual(store.phase, .pending)   // still has pending work
    }

    func test_statusStore_stuckClearsWhenDrained() {
        let store = SyncStatusStore()
        store.setPendingCount(2, stuck: 2)
        XCTAssertEqual(store.stuckCount, 2)
        store.setPendingCount(0)                // all resolved
        XCTAssertEqual(store.stuckCount, 0)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(store.phase, .idle)
    }

    // MARK: - US-1208: create-before-edit replay ordering

    private func snapshot(
        kind: MutationKind,
        targetId: String?,
        retryCount: Int = 0,
        createdAt: Date = Date(timeIntervalSince1970: 0)
    ) -> SyncEngine.PendingMutationSnapshot {
        SyncEngine.PendingMutationSnapshot(
            id: UUID().uuidString,
            kind: kind.rawValue,
            payload: Data(),
            targetId: targetId,
            retryCount: retryCount,
            lastError: nil,
            lastAttemptAt: nil,
            createdAt: createdAt
        )
    }

    func test_dependentEdit_deferredWhileCreatePending() {
        // create-then-edit-offline: the create is queued (and here failing/stuck),
        // the edit for the SAME id must NOT flush ahead of it (US-1208), or the
        // UPDATE runs against a row the server doesn't have and is lost.
        let create = snapshot(kind: .createInventoryItem, targetId: "item-1")
        let edit = snapshot(kind: .updateInventoryItem, targetId: "item-1")
        let unconfirmed = SyncEngine.unconfirmedCreateTargetIds([create, edit])
        XCTAssertTrue(unconfirmed.contains("item-1"))
        XCTAssertTrue(SyncEngine.shouldDeferDependent(edit, unconfirmedCreateIds: unconfirmed))
    }

    func test_deletePhoto_deferredWhileItsUploadPending() {
        // Offline: upload photo P, then delete P. The delete must NOT flush ahead
        // of the upload — otherwise it deletes 0 rows, dequeues, and the upload
        // replay re-creates the photo the user deleted (resurrected photo).
        let delete = snapshot(kind: .deletePhoto, targetId: "photo-1")
        XCTAssertTrue(
            SyncEngine.shouldDeferPhotoDelete(delete, unconfirmedUploadPhotoIds: ["photo-1"]))
        // A photo with no pending upload flushes normally.
        XCTAssertFalse(
            SyncEngine.shouldDeferPhotoDelete(delete, unconfirmedUploadPhotoIds: ["other"]))
        // The rule applies only to deletePhoto, not other kinds sharing an id.
        let edit = snapshot(kind: .updateInventoryItem, targetId: "photo-1")
        XCTAssertFalse(
            SyncEngine.shouldDeferPhotoDelete(edit, unconfirmedUploadPhotoIds: ["photo-1"]))
    }

    func test_unconfirmedUploadPhotoIds_extractsPhotoIdFromPayload() {
        let payload = try! JSONSerialization.data(withJSONObject: ["photo_id": "photo-9"])
        let upload = SyncEngine.PendingMutationSnapshot(
            id: UUID().uuidString, kind: MutationKind.uploadPhoto.rawValue, payload: payload,
            targetId: "item-1", retryCount: 0, lastError: nil, lastAttemptAt: nil,
            createdAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(SyncEngine.unconfirmedUploadPhotoIds([upload]), ["photo-9"])
    }

    func test_dependentEdit_stuckCreateStillBlocks() {
        // The create has exhausted its retry budget (stuck). The edit (still
        // retry-eligible) must STILL be blocked — a stuck create means the row
        // likely never reached the server, so the edit can't safely apply.
        let create = snapshot(kind: .createInventoryItem, targetId: "item-2", retryCount: 6)
        let edit = snapshot(kind: .deleteInventoryItem, targetId: "item-2")
        let unconfirmed = SyncEngine.unconfirmedCreateTargetIds([create, edit])
        XCTAssertTrue(SyncEngine.shouldDeferDependent(edit, unconfirmedCreateIds: unconfirmed))
    }

    func test_dependentEdit_flushesOnceCreateConfirmed() {
        // After the create confirms (removed from the unconfirmed set), its edit
        // is free to flush in the same pass.
        let edit = snapshot(kind: .updateInventoryItem, targetId: "item-3")
        var unconfirmed: Set<String> = ["item-3"]
        XCTAssertTrue(SyncEngine.shouldDeferDependent(edit, unconfirmedCreateIds: unconfirmed))
        unconfirmed.remove("item-3")   // create just succeeded this pass
        XCTAssertFalse(SyncEngine.shouldDeferDependent(edit, unconfirmedCreateIds: unconfirmed))
    }

    func test_independentEdit_neverDeferred() {
        // An edit whose row has no pending create flushes immediately.
        let edit = snapshot(kind: .updateInventoryItem, targetId: "item-4")
        let unconfirmed = SyncEngine.unconfirmedCreateTargetIds([edit])
        XCTAssertTrue(unconfirmed.isEmpty)
        XCTAssertFalse(SyncEngine.shouldDeferDependent(edit, unconfirmedCreateIds: unconfirmed))
    }

    // MARK: - US-1496: same-target FIFO ordering + Retry routing

    /// The A-fails/B-succeeds reorder scenario. Two full-row updates A(old)→B(new)
    /// for one item drain FIFO; if A fails transiently, B must be HELD so it can't
    /// land ahead of A (which would replay alone next pass and revert the row).
    func test_sameTargetOrdering_failedTargetHoldsLaterEdit() {
        let a = snapshot(kind: .updateInventoryItem, targetId: "item-1")
        let b = snapshot(kind: .updateInventoryItem, targetId: "item-1")
        let other = snapshot(kind: .updateInventoryItem, targetId: "item-2")

        // A applied first, no blocks yet.
        var blocked = Set<String>()
        XCTAssertFalse(SyncEngine.shouldHoldForBlockedTarget(a, blockedTargetIds: blocked))
        // A failed → its target is blocked for the rest of the pass.
        blocked.insert("item-1")
        // B (same target) is now held; an unrelated item is not.
        XCTAssertTrue(SyncEngine.shouldHoldForBlockedTarget(b, blockedTargetIds: blocked))
        XCTAssertFalse(SyncEngine.shouldHoldForBlockedTarget(other, blockedTargetIds: blocked))
    }

    /// Stuck-predecessor case: an older update A that has exhausted its retry
    /// budget is filtered out of the flush loop, so it can't block its own
    /// successor from inside the loop. Seeding `blockedTargetIds` from the stuck
    /// set holds the newer update B behind it — otherwise B flushes and dequeues,
    /// and a later manual Retry of A replays the older snapshot and reverts the row.
    func test_sameTargetOrdering_stuckPredecessorHoldsLaterEdit() {
        let stuckA = snapshot(kind: .updateInventoryItem, targetId: "item-1", retryCount: 6)
        let b = snapshot(kind: .updateInventoryItem, targetId: "item-1")
        let other = snapshot(kind: .updateInventoryItem, targetId: "item-2")

        // The blocked set is seeded from stuck mutations BEFORE the loop runs.
        let blocked = SyncEngine.stuckTargetIds([stuckA, b, other])
        XCTAssertEqual(blocked, ["item-1"])
        // B (same target as the stuck A) is held; an unrelated item is not.
        XCTAssertTrue(SyncEngine.shouldHoldForBlockedTarget(b, blockedTargetIds: blocked))
        XCTAssertFalse(SyncEngine.shouldHoldForBlockedTarget(other, blockedTargetIds: blocked))
    }

    /// A retry-eligible mutation (under the budget) does not seed the blocked set —
    /// only genuinely stuck predecessors do; in-pass failures block via the loop.
    func test_stuckTargetIds_ignoresRetryEligibleMutations() {
        let retrying = snapshot(kind: .updateInventoryItem, targetId: "item-1", retryCount: 5)
        XCTAssertTrue(SyncEngine.stuckTargetIds([retrying]).isEmpty)
    }

    /// A mutation with no targetId (e.g. a create keyed only by payload) is never
    /// held by the target-block guard.
    func test_sameTargetOrdering_nilTargetNeverHeld() {
        let noTarget = snapshot(kind: .createSale, targetId: nil)
        XCTAssertFalse(
            SyncEngine.shouldHoldForBlockedTarget(noTarget, blockedTargetIds: ["item-1"]))
    }

    /// Retry-behind-stuck-create: retryMutation now routes through flushPending(),
    /// so the create-deferral guard still applies — an UPDATE queued behind a stuck
    /// create is deferred, not applied directly against a row the server lacks
    /// (which would UPDATE 0 rows, 'succeed', and dequeue — a silent edit loss).
    func test_retryRoutesThroughDeferralGuard_forEditBehindStuckCreate() {
        let create = snapshot(kind: .createInventoryItem, targetId: "item-9", retryCount: 6)
        let edit = snapshot(kind: .updateInventoryItem, targetId: "item-9")
        let unconfirmed = SyncEngine.unconfirmedCreateTargetIds([create, edit])
        // The same guard flushPending() (and therefore retryMutation) applies.
        XCTAssertTrue(SyncEngine.shouldDeferDependent(edit, unconfirmedCreateIds: unconfirmed))
    }

    // MARK: - US-1508: offline Save & Sync revise re-push

    /// An offline Save & Sync queues the revise as a `.reviseListing` mutation whose
    /// payload round-trips through the queue, so the reconnect flush can replay it.
    func test_offlineRevise_queuesAndRoundtripsPayload() throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        let payload = OfflineRevisePayload(
            listingId: "L1", title: "New title", description: "New desc", price: 42,
            resyncFields: true, conditionNoteChanged: true, conditionNote: "Small mark"
        )
        let ok = OfflineMutationQueue.enqueueUpdate(
            kind: .reviseListing, payload: payload, targetId: "item-1", in: ctx)
        XCTAssertTrue(ok)

        let row = try XCTUnwrap(
            try ModelContext(container).fetch(FetchDescriptor<LocalPendingMutation>()).first)
        XCTAssertEqual(row.kindEnum, .reviseListing)
        XCTAssertEqual(row.targetId, "item-1")   // shares the item's target → ordered after it
        let decoded = try JSONDecoder().decode(OfflineRevisePayload.self, from: row.payload)
        XCTAssertEqual(decoded.listingId, "L1")
        XCTAssertEqual(decoded.title, "New title")
        XCTAssertEqual(decoded.description, "New desc")
        XCTAssertEqual(decoded.price, 42)
        XCTAssertTrue(decoded.resyncFields)
        XCTAssertTrue(decoded.conditionNoteChanged)
        XCTAssertEqual(decoded.conditionNote, "Small mark")
    }

    /// The queued revise shares the item's targetId, so the US-1496 same-target hold
    /// defers it when the item update fails this pass — it never pushes to eBay ahead
    /// of the item write. And it is NOT an inventory-item edit (won't touch the dirty
    /// flag / the create-deferral set).
    func test_reviseListing_orderingAndKindClassification() {
        let revise = snapshot(kind: .reviseListing, targetId: "item-1")
        XCTAssertTrue(
            SyncEngine.shouldHoldForBlockedTarget(revise, blockedTargetIds: ["item-1"]))
        XCTAssertFalse(SyncEngine.isInventoryItemEdit(MutationKind.reviseListing.rawValue))
        XCTAssertFalse(SyncEngine.isCreateKind(MutationKind.reviseListing.rawValue))
    }

    // MARK: - US-1210: drop-safe watermark

    func test_safeCursor_keepsCursorBehindDroppedLowRow() {
        // A row that failed to decode sits at an EARLIER timestamp than rows that
        // decoded cleanly. The watermark must not jump past it (the bug), so the
        // safe cursor is the latest decoded value strictly before the dropped one.
        let cursor = SyncEngine.safeCursor(
            decodedCursors: ["2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"],
            droppedCursors: ["2026-06-02T00:00:00Z"]
        )
        XCTAssertEqual(cursor, "2026-06-01T00:00:00Z")
    }

    func test_safeCursor_noDrops_advancesToMax() {
        let cursor = SyncEngine.safeCursor(
            decodedCursors: ["2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"],
            droppedCursors: []
        )
        XCTAssertEqual(cursor, "2026-06-03T00:00:00Z")
    }

    func test_safeCursor_droppedBeforeAllDecoded_doesNotAdvance() {
        // Every decoded row sits at/after the dropped row → no safe value to move
        // to without skipping it → hold the watermark (nil = don't advance).
        let cursor = SyncEngine.safeCursor(
            decodedCursors: ["2026-06-05T00:00:00Z"],
            droppedCursors: ["2026-06-04T00:00:00Z"]
        )
        XCTAssertNil(cursor)
    }

    // MARK: - US-1493: scope-epoch guard (workspace switch / sign-out mid-pull)

    /// A pull whose scope epoch is unchanged when it returns is safe to apply.
    func test_pullResultApplies_sameEpoch_applies() {
        XCTAssertTrue(SyncEngine.pullResultApplies(startEpoch: 3, currentEpoch: 3))
    }

    /// The core tenant-isolation guard: a workspace switch / sign-out that bumps
    /// the epoch mid-pull means the fetched rows belong to the PREVIOUS tenant, so
    /// the caller must NOT merge them and must NOT advance the (freshly-reset)
    /// watermarks with the old scope's cursors.
    func test_pullResultApplies_changedEpoch_discards() {
        XCTAssertFalse(SyncEngine.pullResultApplies(startEpoch: 3, currentEpoch: 4))
        // Direction doesn't matter — any change is a discard.
        XCTAssertFalse(SyncEngine.pullResultApplies(startEpoch: 4, currentEpoch: 3))
    }

    /// invalidateScope() advances the epoch, so a pull that captured the old epoch
    /// is discarded — the actor-level proof that a scope change mid-pull drops the
    /// stale-tenant payload. (Exercises the real engine's epoch bump, not just the
    /// pure helper, so the wiring can't silently regress.)
    func test_invalidateScope_movesEpoch_soCapturedPullDiscards() async throws {
        let engine = try await makeEngine()
        let captured = await engine.currentScopeEpochForTesting
        // A pull that finished with THIS epoch would apply… (hoist the awaits out
        // of the XCTAssert autoclosures — they don't support concurrency).
        let before = await engine.currentScopeEpochForTesting
        XCTAssertTrue(SyncEngine.pullResultApplies(startEpoch: captured, currentEpoch: before))
        // …but after a scope change it must be discarded.
        await engine.invalidateScope()
        let after = await engine.currentScopeEpochForTesting
        XCTAssertFalse(SyncEngine.pullResultApplies(startEpoch: captured, currentEpoch: after))
    }

    private func makeEngine() async throws -> SyncEngine {
        let container = try inMemoryContainer()
        return SyncEngine(
            container: container,
            statusStore: SyncStatusStore(),
            networkMonitor: NetworkMonitor()
        )
    }

    // MARK: - Delete reconciliation (US-1221)

    func test_reconcileDeletes_prunesAbsentButKeepsProtected() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        for sid in ["s1", "s2", "s3"] {
            ctx.insert(LocalSale(id: sid, inventoryItemId: "i", salePrice: 10, saleDate: .now))
        }
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        // s1 survives server-side; s2 was deleted; s3 is an offline create still
        // pending push (protected) so it must NOT be pruned.
        await actor.reconcileDeletes(
            scopeOwnerId: "u1",
            saleIds: ["s1"], expenseIds: nil, listingIds: nil, photoIds: nil,
            protectedIds: ["s3"]
        )
        let remaining = try ModelContext(container)
            .fetch(FetchDescriptor<LocalSale>()).map(\.id).sorted()
        XCTAssertEqual(remaining, ["s1", "s3"])
    }

    func test_reconcileDeletes_nilSetLeavesTableUntouched() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalListing(
            id: "l1", inventoryItemId: "i", platform: "ebay",
            listingPrice: 10, listingStatus: "active"
        ))
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        // listingIds nil → that table's id fetch failed; never prune on a
        // partial view, even though other sets are present.
        await actor.reconcileDeletes(
            scopeOwnerId: "u1",
            saleIds: [], expenseIds: nil, listingIds: nil, photoIds: nil, protectedIds: []
        )
        XCTAssertEqual(try ModelContext(container).fetch(FetchDescriptor<LocalListing>()).count, 1)
    }

    func test_protectedReconcileIds_includesCreatesAndUploadPhotoIds() throws {
        let createSale = snapshot(kind: .createSale, targetId: "sale-1")
        let uploadPayload = try JSONSerialization.data(
            withJSONObject: ["photo_id": "photo-9", "inventory_item_id": "i1"]
        )
        let upload = SyncEngine.PendingMutationSnapshot(
            id: "m", kind: MutationKind.uploadPhoto.rawValue, payload: uploadPayload,
            targetId: "i1", retryCount: 0, lastError: nil, lastAttemptAt: nil,
            createdAt: Date(timeIntervalSince1970: 0)
        )
        let protected = SyncEngine.protectedReconcileIds([createSale, upload])
        XCTAssertTrue(protected.contains("sale-1"))   // pending create's target row
        XCTAssertTrue(protected.contains("photo-9"))  // staged upload's photo row id
        // The upload's targetId is the parent ITEM id, not a sale/photo row id —
        // it must not leak into the protected set.
        XCTAssertFalse(protected.contains("i1"))
    }

    // MARK: - US-1495: dirty-flag clearing + inventory-item delete reconcile

    /// The pending-edit id set drives both the dirty-flag clear (on flush) and the
    /// item delete-reconcile guard: only inventory-item create/update mutations
    /// count; sales/photos/deletes/unknown kinds do not.
    func test_itemIdsWithPendingEdits_onlyInventoryCreateAndUpdate() {
        let queue = [
            snapshot(kind: .createInventoryItem, targetId: "i-create"),
            snapshot(kind: .updateInventoryItem, targetId: "i-update"),
            snapshot(kind: .deleteInventoryItem, targetId: "i-delete"),
            snapshot(kind: .createSale, targetId: "sale-1"),
            snapshot(kind: .uploadPhoto, targetId: "i-photo"),
        ]
        let ids = SyncEngine.itemIdsWithPendingEdits(queue)
        XCTAssertEqual(ids, ["i-create", "i-update"])
    }

    /// AC#3: once the dirty flag is cleared (its last pending edit flushed), the
    /// next pull's `applyServerWins` stops shadowing the server value — a server
    /// edit made after the offline edit flushed becomes visible on the device.
    func test_clearItemDirtyFlags_unfreezesRowSoServerEditApplies() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        let item = LocalInventoryItem(
            id: "a", userId: "u1", title: "Local offline edit",
            status: "cataloged", hasLocalChanges: true
        )
        ctx.insert(item)
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)

        // While dirty, a newer server row is shadowed (dirty-wins keeps local).
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Server v1", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        var fetched = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(fetched?.title, "Local offline edit")

        // Flush clears the flag (no pending edit remains for this item)…
        await actor.clearItemDirtyFlags(itemIds: ["a"])
        fetched = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(fetched?.hasLocalChanges, false)

        // …so the next pull now applies the server edit instead of freezing.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Server v2", updated: "2026-06-03T00:00:00Z")],
            primaryPhotos: [:], prune: false
        )
        fetched = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).first
        XCTAssertEqual(fetched?.title, "Server v2")
    }

    /// clearItemDirtyFlags is bounded to the passed ids — an item still dirty (its
    /// edit hasn't flushed) is untouched even though the actor was invoked.
    func test_clearItemDirtyFlags_leavesUnlistedDirtyItemsAlone() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalInventoryItem(id: "flushed", userId: "u1", title: "A",
                                      status: "cataloged", hasLocalChanges: true))
        ctx.insert(LocalInventoryItem(id: "stillPending", userId: "u1", title: "B",
                                      status: "cataloged", hasLocalChanges: true))
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        await actor.clearItemDirtyFlags(itemIds: ["flushed"])

        let byId = Dictionary(uniqueKeysWithValues: try ModelContext(container)
            .fetch(FetchDescriptor<LocalInventoryItem>()).map { ($0.id, $0.hasLocalChanges) })
        XCTAssertEqual(byId["flushed"], false)
        XCTAssertEqual(byId["stillPending"], true)  // its edit is still queued
    }

    /// AC#2/#4: an item deleted server-side is pruned from the local mirror, but a
    /// pending-create target and a row with genuinely-pending local changes are
    /// both protected from the prune.
    func test_reconcileDeletes_prunesServerDeletedItemsButKeepsProtectedAndDirty() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalInventoryItem(id: "keep", userId: "u1", title: "Survives",
                                      status: "cataloged"))
        ctx.insert(LocalInventoryItem(id: "gone", userId: "u1", title: "Deleted on web",
                                      status: "cataloged"))
        ctx.insert(LocalInventoryItem(id: "dirty", userId: "u1", title: "Pending edit",
                                      status: "cataloged", hasLocalChanges: true))
        ctx.insert(LocalInventoryItem(id: "creating", userId: "u1", title: "Offline create",
                                      status: "cataloged"))
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        // Server still has only "keep". "creating" is a pending create (protected);
        // "dirty" has an unflushed local edit (protected via hasLocalChanges).
        await actor.reconcileDeletes(
            scopeOwnerId: "u1",
            itemIds: ["keep"],
            saleIds: nil, expenseIds: nil, listingIds: nil, photoIds: nil,
            protectedIds: ["creating"],
            protectedItemIds: ["creating"]
        )
        let remaining = try ModelContext(container)
            .fetch(FetchDescriptor<LocalInventoryItem>()).map(\.id).sorted()
        XCTAssertEqual(remaining, ["creating", "dirty", "keep"])
    }

    /// A nil item id set (fetch failed / offline) never prunes items — same
    /// partial-view guard the other tables already have.
    func test_reconcileDeletes_nilItemSetLeavesItemsUntouched() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalInventoryItem(id: "a", userId: "u1", title: "A", status: "cataloged"))
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        await actor.reconcileDeletes(
            scopeOwnerId: "u1",
            itemIds: nil,
            saleIds: [], expenseIds: nil, listingIds: nil, photoIds: nil,
            protectedIds: []
        )
        XCTAssertEqual(try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).count, 1)
    }

    // MARK: - US-2337 unresolved tenant scope never prunes

    /// The bug, stated as a test: a transient session read failure left the owner
    /// id nil, the id-scans ran unfiltered, RLS handed back zero rows to an
    /// unauthenticated request, and an EMPTY surviving-id set pruned every local
    /// row. Empty is a legitimate answer for a genuinely empty account, so the
    /// thing that has to stop the prune is the missing scope, not the empty set.
    func test_reconcileDeletes_unresolvedScopeLeavesEveryTableIntact() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalInventoryItem(id: "i1", userId: "u1", title: "Tee", status: "cataloged"))
        ctx.insert(LocalSale(id: "s1", inventoryItemId: "i1", salePrice: 10, saleDate: .now))
        ctx.insert(LocalListing(
            id: "l1", inventoryItemId: "i1", platform: "ebay",
            listingPrice: 10, listingStatus: "active"
        ))
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        // Every set is EMPTY — "the server has nothing" — but the scope is blank,
        // so the sets prove nothing and nothing may be pruned.
        await actor.reconcileDeletes(
            scopeOwnerId: "   ",
            itemIds: [], saleIds: [], expenseIds: [], listingIds: [], photoIds: [],
            protectedIds: []
        )
        let read = ModelContext(container)
        XCTAssertEqual(try read.fetch(FetchDescriptor<LocalInventoryItem>()).count, 1)
        XCTAssertEqual(try read.fetch(FetchDescriptor<LocalSale>()).count, 1)
        XCTAssertEqual(try read.fetch(FetchDescriptor<LocalListing>()).count, 1)
    }

    /// Control for the test above: with a resolved scope the same empty sets DO
    /// prune, so the guard is refusing the unscoped case specifically rather than
    /// disabling reconciliation.
    func test_reconcileDeletes_resolvedScopeStillPrunesOnEmptySets() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalInventoryItem(id: "i1", userId: "u1", title: "Tee", status: "cataloged"))
        try ctx.save()

        let actor = SyncMergeActor(modelContainer: container)
        await actor.reconcileDeletes(
            scopeOwnerId: "u1",
            itemIds: [], saleIds: nil, expenseIds: nil, listingIds: nil, photoIds: nil,
            protectedIds: []
        )
        XCTAssertTrue(try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).isEmpty)
    }

    /// A failed session read (nil `sessionUserId`) abandons the pass even when a
    /// workspace is selected: the request goes out unauthenticated either way, so
    /// a workspace id would scope a query that returns nothing regardless.
    func test_resolveScopeOwnerId_failedSessionAbandonsPassEvenWithWorkspace() {
        XCTAssertNil(SyncEngine.resolveScopeOwnerId(
            workspaceOwnerId: "workspace-owner", sessionUserId: nil))
        XCTAssertNil(SyncEngine.resolveScopeOwnerId(
            workspaceOwnerId: nil, sessionUserId: nil))
        // Blank is absent, not present: `.eq("user_id", "")` matches nothing.
        XCTAssertNil(SyncEngine.resolveScopeOwnerId(
            workspaceOwnerId: "workspace-owner", sessionUserId: "  "))
    }

    func test_resolveScopeOwnerId_prefersWorkspaceThenSelf() {
        XCTAssertEqual(
            SyncEngine.resolveScopeOwnerId(workspaceOwnerId: "owner", sessionUserId: "self"),
            "owner")
        XCTAssertEqual(
            SyncEngine.resolveScopeOwnerId(workspaceOwnerId: nil, sessionUserId: "self"),
            "self")
        // A blank workspace id falls through to the session id rather than
        // becoming an empty filter.
        XCTAssertEqual(
            SyncEngine.resolveScopeOwnerId(workspaceOwnerId: "", sessionUserId: "self"),
            "self")
    }

    // MARK: - PendingMutationActor off-main queue (US-1165)

    func test_pendingActor_snapshotReturnsFifoOrder() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalPendingMutation(
            id: "m2", kind: .updateInventoryItem, payload: Data(), targetId: "i2",
            createdAt: Date(timeIntervalSince1970: 200)))
        ctx.insert(LocalPendingMutation(
            id: "m1", kind: .createInventoryItem, payload: Data(), targetId: "i1",
            createdAt: Date(timeIntervalSince1970: 100)))
        try ctx.save()

        let actor = PendingMutationActor(modelContainer: container)
        let snapshot = await actor.snapshot()
        // Oldest createdAt first (FIFO drain order).
        XCTAssertEqual(snapshot.map(\.id), ["m1", "m2"])
        XCTAssertEqual(snapshot.first?.kind, MutationKind.createInventoryItem.rawValue)
    }

    func test_pendingActor_deleteRemovesRow() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalPendingMutation(id: "m1", kind: .createSale, payload: Data()))
        try ctx.save()

        let actor = PendingMutationActor(modelContainer: container)
        await actor.delete(id: "m1")
        // Hoist the await out of XCTAssertEqual's (non-async) autoclosure.
        let pendingAfterDelete = await actor.pendingCount()
        XCTAssertEqual(pendingAfterDelete, 0)
    }

    func test_pendingActor_markFailedBumpsRetryAndStampsError() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalPendingMutation(id: "m1", kind: .createInventoryItem, payload: Data()))
        try ctx.save()

        let actor = PendingMutationActor(modelContainer: container)
        await actor.markFailed(id: "m1", error: "boom", maxRetries: 6)
        let snapRows = await actor.snapshot()
        let snap = try XCTUnwrap(snapRows.first)
        XCTAssertEqual(snap.retryCount, 1)
        XCTAssertEqual(snap.lastError, "boom")
        XCTAssertNotNil(snap.lastAttemptAt)
        // Not yet at the ceiling → not stuck.
        let stuckAfterFail = await actor.stuckCount(maxRetries: 6)
        XCTAssertEqual(stuckAfterFail, 0)
    }

    func test_pendingActor_markStuckPinsToCeilingAndSurfacesAsStuck() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        ctx.insert(LocalPendingMutation(id: "m1", kind: .deleteInventoryItem, payload: Data(), targetId: "i1"))
        try ctx.save()

        let actor = PendingMutationActor(modelContainer: container)
        await actor.markStuck(id: "m1", error: "missing target", maxRetries: 6)
        let snapRows = await actor.snapshot()
        let snap = try XCTUnwrap(snapRows.first)
        XCTAssertEqual(snap.retryCount, 6)        // pinned to ceiling, not stepped
        XCTAssertEqual(snap.lastError, "missing target")
        let stuckAfterPin = await actor.stuckCount(maxRetries: 6)
        XCTAssertEqual(stuckAfterPin, 1)
    }

    func test_pendingActor_clearErrorAndResetRetry() async throws {
        let container = try inMemoryContainer()
        let ctx = ModelContext(container)
        let row = LocalPendingMutation(id: "m1", kind: .createInventoryItem, payload: Data())
        row.retryCount = 4
        row.lastError = "earlier failure"
        ctx.insert(row)
        try ctx.save()

        let actor = PendingMutationActor(modelContainer: container)
        await actor.clearErrorAndResetRetry(id: "m1")
        let snapRows = await actor.snapshot()
        let snap = try XCTUnwrap(snapRows.first)
        XCTAssertEqual(snap.retryCount, 0)
        XCTAssertNil(snap.lastError)
    }

    // MARK: - Helpers

    private func inMemoryContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalSourcer.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(for: schema, configurations: config)
    }

    // MARK: - US-1515: delta cursor column

    func test_allSyncTables_deltaOnUpdatedAt() {
        // US-1515: every synced table deltas on updated_at so a server EDIT (sale
        // correction, photo retag/reorder) reaches iOS, not just inserts. sales +
        // item_photos gained updated_at in migration 00332.
        for table in SyncWatermark.Table.allCases {
            XCTAssertEqual(
                table.cursorColumn, "updated_at",
                "\(table.rawValue) must delta on updated_at (US-1515)"
            )
        }
    }
}

/// Thread-safe call counter for the ``ConnectivityDebouncer`` tests — the
/// debounced action runs off the test's main actor, so the tally needs its own
/// isolation.
private actor DebounceCallCounter {
    private(set) var value = 0
    func bump() { value += 1 }
}
