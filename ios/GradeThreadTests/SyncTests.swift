import XCTest
import SwiftData
@testable import GradeThread

@MainActor
final class SyncTests: XCTestCase {

    // MARK: - ConflictPolicy

    func test_serverOwned_alwaysReturnsServerValue() {
        XCTAssertEqual(ConflictPolicy.resolveServerOwned(local: 10.0, server: 25.0), 25.0)
        XCTAssertEqual(ConflictPolicy.resolveServerOwned(local: "draft", server: "active"), "active")
    }

    func test_userOwned_keepsLocalWhenDirty() {
        let result = ConflictPolicy.resolveUserOwned(
            local: "Linen blazer (edited)",
            server: "Linen blazer",
            hasLocalChanges: true
        )
        XCTAssertEqual(result, "Linen blazer (edited)")
    }

    func test_userOwned_acceptsServerWhenClean() {
        let result = ConflictPolicy.resolveUserOwned(
            local: "Linen blazer",
            server: "Linen blazer (server-updated)",
            hasLocalChanges: false
        )
        XCTAssertEqual(result, "Linen blazer (server-updated)")
    }

    func test_byTimestamp_pickserverWhenNewer() {
        let local = "old-notes"
        let server = "new-notes"
        let localUpdate = Date(timeIntervalSince1970: 100)
        let serverUpdate = Date(timeIntervalSince1970: 200)

        let result = ConflictPolicy.resolveByTimestamp(
            local: local,
            server: server,
            localUpdatedAt: localUpdate,
            serverUpdatedAt: serverUpdate
        )
        XCTAssertEqual(result, server)
    }

    func test_byTimestamp_pickslocalWhenNewer() {
        let result = ConflictPolicy.resolveByTimestamp(
            local: "local-latest",
            server: "server-stale",
            localUpdatedAt: Date(timeIntervalSince1970: 200),
            serverUpdatedAt: Date(timeIntervalSince1970: 100)
        )
        XCTAssertEqual(result, "local-latest")
    }

    // MARK: - Listing provenance (US-1086)

    func test_ebayOwnedListingField_ebayOriginated_serverAlwaysWins() {
        // eBay-originated: server wins even when the local row is dirty.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "My Title", server: "eBay Title",
            hasLocalChanges: true, listingOrigin: "ebay"
        )
        XCTAssertEqual(result, "eBay Title")
    }

    func test_ebayOwnedListingField_gtOriginated_clientWinsWhenDirty() {
        // GradeThread-originated: local wins while dirty.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "My Edit", server: "eBay Value",
            hasLocalChanges: true, listingOrigin: "gradethread"
        )
        XCTAssertEqual(result, "My Edit")
    }

    func test_ebayOwnedListingField_gtOriginated_serverWinsWhenClean() {
        // GradeThread-originated clean row defers to server.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "Stale", server: "Server Updated",
            hasLocalChanges: false, listingOrigin: "gradethread"
        )
        XCTAssertEqual(result, "Server Updated")
    }

    func test_ebayOwnedListingField_nilOrigin_treatedAsGradethread() {
        // Nil origin (legacy row) falls through to userOwned rules, not locked.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "Local Edit", server: "Server",
            hasLocalChanges: true, listingOrigin: nil
        )
        XCTAssertEqual(result, "Local Edit")
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
        XCTAssertEqual(SyncWatermark.Table.inventoryItems.cursorColumn, "updated_at")
        XCTAssertEqual(SyncWatermark.Table.itemPhotos.cursorColumn, "created_at")
        XCTAssertEqual(SyncWatermark.Table.sales.cursorColumn, "created_at")
        // US-819: disputes carry an updated_at (status change bumps it).
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
            listingPrices: [:],
            prune: false
        )
        var rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.title, "Linen blazer")

        // Re-merge the same id with a new title → upsert, not duplicate.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Linen blazer (updated)", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:],
            listingPrices: [:],
            prune: false
        )
        rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.title, "Linen blazer (updated)")
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
            primaryPhotos: [:], listingPrices: [:], prune: false
        )
        XCTAssertEqual(
            try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>()).count, 2
        )

        // Full backfill (prune) that only returns "a" → "b" is removed.
        await actor.mergeItems(
            [Self.remoteItem(id: "a", title: "Keep", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], listingPrices: ["a": 42], prune: true
        )
        let rows = try ModelContext(container).fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.id, "a")
        XCTAssertEqual(rows.first?.listingPrice, 42)
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
            primaryPhotos: [:], listingPrices: [:], prune: true
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
        await actor.mergeItems(seed, primaryPhotos: [:], listingPrices: [:], prune: false)

        // A 1-row delta against the large store must materialize only a handful
        // of rows, not all 50.
        await actor.mergeItems(
            [Self.remoteItem(id: "item-7", title: "Item 7 (updated)", updated: "2026-06-02T00:00:00Z")],
            primaryPhotos: [:], listingPrices: [:], prune: false
        )
        let deltaFetched = await actor.lastMergeFetchedRowCount
        XCTAssertLessThanOrEqual(deltaFetched, 5, "delta merge should fetch only the touched row")

        // Full backfill (prune) still scans the whole table so stale locals can
        // be deleted.
        await actor.mergeItems(seed, primaryPhotos: [:], listingPrices: [:], prune: true)
        let backfillFetched = await actor.lastMergeFetchedRowCount
        XCTAssertGreaterThanOrEqual(backfillFetched, 50, "full backfill must fetch the whole table to prune")
    }

    func test_mergePhotos_deltaFetchesOnlyAffectedRows() async throws {
        let container = try inMemoryContainer()
        let actor = SyncMergeActor(modelContainer: container)

        let items = (0..<30).map {
            Self.remoteItem(id: "item-\($0)", title: "Item \($0)", updated: "2026-06-01T00:00:00Z")
        }
        await actor.mergeItems(items, primaryPhotos: [:], listingPrices: [:], prune: false)
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
            primaryPhotos: [:], listingPrices: [:], prune: false
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
        await actor.mergeItems(seed, primaryPhotos: [:], listingPrices: [:], prune: false)

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
            primaryPhotos: [:], listingPrices: [:], prune: false
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

    // MARK: - Helpers

    private func inMemoryContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(for: schema, configurations: config)
    }
}

/// Thread-safe call counter for the ``ConnectivityDebouncer`` tests — the
/// debounced action runs off the test's main actor, so the tally needs its own
/// isolation.
private actor DebounceCallCounter {
    private(set) var value = 0
    func bump() { value += 1 }
}
