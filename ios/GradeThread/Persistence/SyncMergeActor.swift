import Foundation
import SwiftData

/// Background ``ModelActor`` that owns a single private ``ModelContext`` off
/// the main actor (US-634). Every bulk merge + single-row Realtime apply runs
/// here, so a 1000+ row sync never blocks the UI the way the previous
/// `await MainActor.run { ModelContext(container) … }` merge did.
///
/// The context is created once (by the `@ModelActor` macro) and reused across
/// calls — Realtime no longer spins up a fresh `ModelContext` per event.
///
/// SwiftData `@Model` instances are not `Sendable`, so this actor never hands a
/// `Local*` row across its isolation boundary; callers pass in the decoded
/// wire DTOs (`SyncEngine.Remote*`, which are value types) and read back only
/// `Sendable` value snapshots (e.g. ``WidgetSnapshot``).
@ModelActor
actor SyncMergeActor {

    /// Test instrumentation: rows materialized by the most recent merge call's
    /// fetches. Lets a test assert that a delta pulls only a handful of rows
    /// (the ones the payload touches) instead of the whole table.
    private(set) var lastMergeFetchedRowCount = 0

    /// Fetch + tally for the row-count instrumentation. Every merge fetch goes
    /// through here so `lastMergeFetchedRowCount` reflects the true cost.
    private func fetchCounting<T: PersistentModel>(_ descriptor: FetchDescriptor<T>) -> [T] {
        let rows = (try? modelContext.fetch(descriptor)) ?? []
        lastMergeFetchedRowCount += rows.count
        return rows
    }

    // MARK: - Bulk merge (foreground / background pull)

    /// Upserts a delta (or full backfill) of inventory rows + caches each
    /// item's primary photo URL. Runs entirely on the actor's background
    /// executor.
    /// - Parameters:
    ///   - prune: true ONLY on a full item backfill (no watermark). When true,
    ///     local items the server no longer returns are deleted — this is what
    ///     clears the stale "listed" rows that made the listed count
    ///     (e.g. 922) exceed the real inventory size. In delta mode `items` is
    ///     just the changed rows, so pruning would wrongly wipe the catalog.
    ///
    /// US-1221: each merged item's market `listingPrice` is now derived from the
    /// cached `LocalListing` rows (``applyLatestListingPrices(forItemIds:items:)``)
    /// instead of a price map built from a whole-table listings fetch every pass.
    /// A listing-only change (no item edit) refreshes the price via
    /// ``mergeListings(_:)``'s sibling call, so the cache no longer needs the
    /// item's `updated_at` to bump for a price change to land.
    /// US-1515: returns whether the SwiftData save SUCCEEDED, so pull() can skip
    /// advancing this table's watermark when the merge didn't persist (a swallowed
    /// save failure previously advanced the cursor anyway, permanently losing the
    /// unsaved rows below it). @discardableResult so non-pull callers are unchanged.
    @discardableResult
    func mergeItems(
        _ items: [SyncEngine.RemoteInventoryItem],
        primaryPhotos: [String: SyncEngine.RemoteItemPhoto],
        prune: Bool
    ) -> Bool {
        guard !items.isEmpty || prune else { return true }
        lastMergeFetchedRowCount = 0
        let remoteIds = Set(items.map(\.id))
        // Delta (prune == false): fetch only the rows this payload touches, so a
        // 1-row pull doesn't materialize the whole inventory table. Full backfill
        // (prune == true) still needs every row to delete locals the server
        // dropped.
        let existing: [LocalInventoryItem]
        if prune {
            existing = fetchCounting(FetchDescriptor<LocalInventoryItem>())
        } else {
            let ids = Array(remoteIds)
            existing = fetchCounting(
                FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { ids.contains($0.id) })
            )
        }
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        // US-1147: count genuine concurrent-edit conflicts (a locally-dirty row
        // whose server copy is newer) so the dirty-wins resolution is auditable
        // for support — breadcrumbed once per pass, not per field.
        var dirtyConflicts = 0

        for remote in items {
            let createdAt = SyncEngine.parseDate(remote.created_at)
            let updatedAt = SyncEngine.parseDate(remote.updated_at)
            let primary = primaryPhotos[remote.id]
            let primaryURL = primary?.thumbnail_url ?? primary?.photo_url

            if let local = existingById[remote.id] {
                if local.hasLocalChanges && updatedAt > local.updatedAt { dirtyConflicts += 1 }
                Self.applyServerWins(to: local, remote: remote)
                // Only overwrite the cached primary when the delta actually
                // carried this item's photos; a thin item-only delta leaves
                // the existing thumbnail intact instead of blanking it.
                if primary != nil { local.primaryPhotoURL = primaryURL }
                local.updatedAt = updatedAt
            } else {
                let local = LocalInventoryItem(
                    id: remote.id,
                    userId: remote.user_id,
                    title: remote.title,
                    status: remote.status,
                    createdAt: createdAt,
                    updatedAt: updatedAt,
                    hasLocalChanges: false
                )
                Self.applyServerWins(to: local, remote: remote)
                local.primaryPhotoURL = primaryURL
                modelContext.insert(local)
                existingById[remote.id] = local
            }
        }

        // US-1221: derive the market price for the items this delta touched from
        // their cached listings (bounded to the delta ids, never the catalog).
        applyLatestListingPrices(forItemIds: Array(remoteIds), items: existingById)

        if prune {
            // Don't delete rows still awaiting their first push to the server
            // (offline-created intake) — they legitimately aren't in the
            // server response yet.
            for stale in existing
            where !remoteIds.contains(stale.id) && !stale.hasLocalChanges {
                modelContext.delete(stale)
            }
        }
        if dirtyConflicts > 0 {
            Telemetry.backgroundBreadcrumb(
                "Sync kept \(dirtyConflicts) locally-edited item(s) over a newer server row (dirty-wins)",
                category: "sync")
        }
        return modelContext.saveOrLog("mergeItems")
    }

    /// US-1495: clears the sticky `hasLocalChanges` flag on the given items after
    /// their last pending create/update mutation flushed to the server. Until this
    /// ran, an offline edit left the flag set forever — `applyServerWins` then kept
    /// the local value for every user-owned field on every pull, so web/member/AI
    /// edits never reached the device and the row was exempt from backfill prune
    /// (an immortal ghost if the server row was deleted). Bounded to the passed ids.
    func clearItemDirtyFlags(itemIds: Set<String>) {
        guard !itemIds.isEmpty else { return }
        let ids = Array(itemIds)
        let rows = (try? modelContext.fetch(
            FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { ids.contains($0.id) })
        )) ?? []
        var cleared = 0
        for row in rows where row.hasLocalChanges {
            row.hasLocalChanges = false
            cleared += 1
        }
        if cleared > 0 { modelContext.saveOrLog("clearItemDirtyFlags") }
    }

    /// Upserts item photos. `prune` is true ONLY on a full backfill — in delta
    /// mode `remotePhotos` is just the new rows, so pruning locals not in the
    /// set would wrongly wipe the whole strip. US-1515: returns save success.
    @discardableResult
    func mergePhotos(_ remotePhotos: [SyncEngine.RemoteItemPhoto], prune: Bool) -> Bool {
        lastMergeFetchedRowCount = 0
        let remoteIds = Set(remotePhotos.map(\.id))
        // Delta: only the photo rows this payload touches; full backfill needs
        // the whole strip so absent locals can be pruned.
        let existing: [LocalItemPhoto]
        if prune {
            existing = fetchCounting(FetchDescriptor<LocalItemPhoto>())
        } else {
            let ids = Array(remoteIds)
            existing = fetchCounting(
                FetchDescriptor<LocalItemPhoto>(predicate: #Predicate { ids.contains($0.id) })
            )
        }
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        // US-994: resolve each photo's owning item so the @Relationship (and its
        // cascade-delete) is populated, not just the loose FK string. mergeItems
        // runs before mergePhotos in `pull()`, so the items are already present.
        // Scope the lookup to the items these photos reference — even on a full
        // backfill we only need the owners named in this payload.
        let referencedItemIds = Array(Set(remotePhotos.map(\.inventory_item_id)))
        let items = fetchCounting(
            FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { referencedItemIds.contains($0.id) })
        )
        let itemsById = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        for remote in remotePhotos {
            if let local = existingById[remote.id] {
                local.photoType = remote.photo_type
                local.photoURL = remote.photo_url
                local.thumbnailURL = remote.thumbnail_url
                local.storagePath = remote.storage_path
                local.sortOrder = remote.sort_order
                local.bytes = remote.bytes
                // Heal the relationship on rows that predate US-994 (or whose
                // item arrived after the photo) without clobbering a good link.
                local.item = itemsById[remote.inventory_item_id] ?? local.item
            } else {
                let local = LocalItemPhoto(
                    id: remote.id,
                    inventoryItemId: remote.inventory_item_id,
                    photoType: remote.photo_type,
                    photoURL: remote.photo_url,
                    sortOrder: remote.sort_order,
                    createdAt: SyncEngine.parseDate(remote.created_at)
                )
                local.thumbnailURL = remote.thumbnail_url
                local.storagePath = remote.storage_path
                local.bytes = remote.bytes
                modelContext.insert(local)
                local.item = itemsById[remote.inventory_item_id]
                existingById[remote.id] = local
            }
        }

        if prune {
            // US-1249: after a full backfill prune the ONLY surviving photos are
            // the server-returned rows, so an item that loses a photo and isn't
            // referenced by any surviving photo now has none — clear its cached
            // cover thumbnail. Computed from the surviving set (not a post-delete
            // re-fetch) so it never depends on pending-delete fetch semantics.
            let survivingItemIds = Set(remotePhotos.map(\.inventory_item_id))
            var deletedItemIds = Set<String>()
            for stale in existing where !remoteIds.contains(stale.id) {
                deletedItemIds.insert(stale.inventoryItemId)
                modelContext.delete(stale)
            }
            clearCoversForEmptiedItems(deletedItemIds.subtracting(survivingItemIds))
        }
        return modelContext.saveOrLog("mergePhotos")
    }

    /// US-1249: drops the cached `primaryPhotoURL` of every item in `itemIds`.
    /// Callers pass ONLY items proven to have no photos left after a removal
    /// (full backfill prune / delta delete reconcile), so the cover cache — a
    /// render hint, not a presence signal (US-994) — is cleared along with the
    /// last photo and the grid never shows a dead thumbnail.
    private func clearCoversForEmptiedItems(_ itemIds: Set<String>) {
        guard !itemIds.isEmpty else { return }
        let ids = Array(itemIds)
        let items = (try? modelContext.fetch(
            FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { ids.contains($0.id) })
        )) ?? []
        for item in items { item.primaryPhotoURL = nil }
    }

    /// Upserts the user's sales. No pruning — a sale that disappears
    /// server-side is rare and harmless to keep locally.
    @discardableResult
    func mergeSales(_ remoteSales: [SyncEngine.RemoteSaleRow]) -> Bool {
        guard !remoteSales.isEmpty else { return true }
        lastMergeFetchedRowCount = 0
        // Sales never prune, so this is always a delta: fetch only the rows the
        // payload touches instead of every sale the user has ever made.
        let ids = Array(Set(remoteSales.map(\.id)))
        let existing = fetchCounting(
            FetchDescriptor<LocalSale>(predicate: #Predicate { ids.contains($0.id) })
        )
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        for remote in remoteSales {
            let local: LocalSale
            if let existing = existingById[remote.id] {
                local = existing
            } else {
                local = LocalSale(
                    id: remote.id,
                    inventoryItemId: remote.inventory_item_id,
                    salePrice: remote.sale_price,
                    saleDate: SyncEngine.parseDate(remote.sale_date),
                    platformFees: remote.platform_fees,
                    createdAt: remote.created_at.isEmpty ? .now : SyncEngine.parseDate(remote.created_at)
                )
                modelContext.insert(local)
                existingById[remote.id] = local
            }
            // Server-authoritative money + lifecycle fields (refresh every sync).
            local.salePrice = remote.sale_price
            local.platformFees = remote.platform_fees
            local.paymentProcessingFees = remote.payment_processing_fees
            local.shippingCollected = remote.shipping_collected
            local.tax = remote.tax
            local.status = remote.status
            local.saleDate = SyncEngine.parseDate(remote.sale_date)
            local.buyerUsername = remote.buyer_username

            // US-1249: the seller-entered cost fields (label/shipping cost,
            // grading cost, misc costs) are user-editable bookkeeping. Guard them
            // with the local-dirty flag so a server pull doesn't clobber a pending
            // local edit; a clean row still takes the server value.
            local.shippingCost = ConflictPolicy.resolveUserOwned(
                local: local.shippingCost, server: Optional(remote.shipping_cost),
                hasLocalChanges: local.hasLocalChanges)
            local.gradingCost = ConflictPolicy.resolveUserOwned(
                local: local.gradingCost, server: Optional(remote.grading_cost),
                hasLocalChanges: local.hasLocalChanges)
            local.otherCosts = ConflictPolicy.resolveUserOwned(
                local: local.otherCosts, server: Optional(remote.other_costs),
                hasLocalChanges: local.hasLocalChanges)

            // US-1249: standardize the cached net on component math (the mirror of
            // SalePnL / web computePnl) instead of trusting the server's stored
            // net_profit, so the cached value can never drift from this row's own
            // money fields. Cost basis lives on the item, not the sale, so the
            // sale-level net excludes it (costBasis: 0).
            local.netProfit = SalePnL.net(local, costBasis: 0)
        }
        return modelContext.saveOrLog("mergeSales")
    }

    /// Upserts the local mirror of `flipdesk_expenses` (US-750) so the Money tab
    /// reads expenses from the same SwiftData cache as everything else. Server is
    /// authoritative for amount/category/date and the 00266 attribution links.
    /// Like sales, expenses never prune, so this is always a delta over the rows
    /// the payload touches.
    @discardableResult
    func mergeExpenses(_ remoteExpenses: [SyncEngine.RemoteExpenseRow]) -> Bool {
        guard !remoteExpenses.isEmpty else { return true }
        lastMergeFetchedRowCount = 0
        let ids = Array(Set(remoteExpenses.map(\.id)))
        let existing = fetchCounting(
            FetchDescriptor<LocalExpense>(predicate: #Predicate { ids.contains($0.id) })
        )
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        for remote in remoteExpenses {
            let local: LocalExpense
            if let existing = existingById[remote.id] {
                local = existing
            } else {
                local = LocalExpense(
                    id: remote.id,
                    category: remote.category,
                    amount: remote.amount,
                    spentOn: remote.spentOnDate,
                    createdAt: remote.created_at.isEmpty ? .now : SyncEngine.parseDate(remote.created_at)
                )
                modelContext.insert(local)
                existingById[remote.id] = local
            }
            // Server-authoritative fields (refresh every sync).
            local.category = remote.category
            local.amount = remote.amount
            // US-1494: use the date-only-aware helper (matches the insert path).
            // parseDate handles only ISO date-TIME and falls back to `.now` for a
            // date-only "yyyy-MM-dd" spent_on, so every delta-pulled expense was
            // being clobbered to today — corrupting Money month totals.
            local.spentOn = remote.spentOnDate
            local.expenseDescription = remote.description
            local.inventoryItemId = remote.inventory_item_id
            local.listingId = remote.listing_id
        }
        return modelContext.saveOrLog("mergeExpenses")
    }

    /// Upserts the local mirror of `listings` so the item canvas can resolve a
    /// live eBay listing and decide between in-place revise (Sell offer present)
    /// and an Edit-on-eBay link. Server is authoritative for marketplace fields
    /// (status, price, offer id). Not pruned: the listings fetch is bounded per
    /// pass, so deleting locals absent from one page could wrongly drop rows.
    @discardableResult
    func mergeListings(_ remoteListings: [SyncEngine.RemoteListing]) -> Bool {
        guard !remoteListings.isEmpty else { return true }
        lastMergeFetchedRowCount = 0
        // US-1221: listings now delta on `updated_at` (no longer a whole-table
        // pull every pass). Deletes propagate via the periodic id-reconciliation
        // (``reconcileDeletes(...)``), not a prune here.
        let ids = Array(Set(remoteListings.map(\.id)))
        let existing = fetchCounting(
            FetchDescriptor<LocalListing>(predicate: #Predicate { ids.contains($0.id) })
        )
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        for remote in remoteListings {
            let local: LocalListing
            if let existing = existingById[remote.id] {
                local = existing
            } else {
                local = LocalListing(
                    id: remote.id,
                    inventoryItemId: remote.inventory_item_id,
                    platform: remote.platform ?? "ebay",
                    listingPrice: remote.listing_price ?? 0,
                    listingStatus: remote.listing_status ?? "active",
                    createdAt: remote.created_at.map(SyncEngine.parseDate) ?? .now
                )
                modelContext.insert(local)
                existingById[remote.id] = local
            }
            // Server-authoritative platform-identity fields (refresh every sync).
            local.platform = remote.platform ?? local.platform
            local.platformListingId = remote.platform_listing_id
            local.platformOfferId = remote.platform_offer_id
            local.externalURL = remote.listing_url
            local.listedAt = remote.listed_at.map(SyncEngine.parseDate)
            // listings has no ended_at column; LocalListing.endedAt stays nil.

            // US-1249: price + status are eBay-OWNED editable fields. Route them
            // through the provenance policy instead of overwriting unconditionally
            // — a GradeThread-originated listing carrying a pending local edit keeps
            // its local value; an eBay-originated listing always takes the server
            // value (eBay is the source of truth). `listings` carries no title
            // column on iOS, so only price/status are resolved here. The origin is
            // the freshly-synced marker, falling back to the cached one when this
            // delta omits it; a nil origin (legacy row) is treated as gradethread.
            let origin = remote.listing_origin ?? local.listingOrigin
            if let price = remote.listing_price {
                local.listingPrice = ConflictPolicy.resolveEbayOwnedListingField(
                    local: local.listingPrice, server: price,
                    hasLocalChanges: local.hasLocalChanges, listingOrigin: origin)
            }
            if let status = remote.listing_status {
                local.listingStatus = ConflictPolicy.resolveEbayOwnedListingField(
                    local: local.listingStatus, server: status,
                    hasLocalChanges: local.hasLocalChanges, listingOrigin: origin)
            }
            local.listingOrigin = remote.listing_origin
            local.updatedAt = remote.updated_at.map(SyncEngine.parseDate) ?? .now
        }

        // US-1221: a listing change (price/relist) refreshes its item's market
        // price even when the item itself didn't change this pass — derived from
        // ALL cached listings for the affected items, so the latest wins.
        applyLatestListingPrices(forItemIds: remoteListings.map(\.inventory_item_id))

        return modelContext.saveOrLog("mergeListings")
    }

    /// US-1221: derives each item's market listing price from the cached
    /// `LocalListing` rows and writes it onto the `LocalInventoryItem`, bounded to
    /// `itemIds` (the delta) — never the whole catalog. `items` may be supplied by
    /// the caller (mergeItems already loaded them) to avoid a redundant fetch;
    /// otherwise the affected items are fetched here.
    ///
    /// US-1244: the price is selected from the item's LIVE (active/relisted)
    /// listing when one exists, falling back to the latest of any status only when
    /// none is live — so a relisted/ended listing carrying a newer timestamp can't
    /// drive a stale "inventory value". Reuses the unit-tested
    /// ``SyncEngine/selectListingPrices(_:)`` (US-1221 moved derivation here from
    /// the former fetch-time map, where US-1244 originally lived).
    private func applyLatestListingPrices(
        forItemIds itemIds: [String],
        items preloaded: [String: LocalInventoryItem]? = nil
    ) {
        let ids = Array(Set(itemIds))
        guard !ids.isEmpty else { return }
        let listings = fetchCounting(
            FetchDescriptor<LocalListing>(predicate: #Predicate { ids.contains($0.inventoryItemId) })
        )
        guard !listings.isEmpty else { return }

        let latestPrice = SyncEngine.selectListingPrices(
            listings.map { listing in
                (
                    itemId: listing.inventoryItemId,
                    price: listing.listingPrice,
                    at: listing.listedAt ?? listing.createdAt,
                    isLive: SyncEngine.liveListingStatuses.contains(listing.listingStatus.lowercased())
                )
            }
        )
        guard !latestPrice.isEmpty else { return }

        let items: [LocalInventoryItem]
        if let preloaded {
            items = ids.compactMap { preloaded[$0] }
        } else {
            items = fetchCounting(
                FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { ids.contains($0.id) })
            )
        }
        for item in items {
            if let price = latestPrice[item.id] { item.listingPrice = price }
        }
    }

    /// US-819: stamps each item's `disputeStatus` from the synced `disputes`
    /// delta so the Grades list can badge a disputed grade. Disputes are keyed
    /// by `grade_report_id`; we reduce to the latest dispute per report (by
    /// updated_at, created_at fallback), then write its status onto the matching
    /// item — looked up by the indexed `gradeReportId`. Bounded by the number of
    /// CHANGED disputes in this delta (usually 0), never by the grades-list size,
    /// so there is no per-row N+1.
    @discardableResult
    func mergeDisputes(_ remoteDisputes: [SyncEngine.RemoteDispute]) -> Bool {
        guard !remoteDisputes.isEmpty else { return true }
        lastMergeFetchedRowCount = 0

        // Latest status per grade_report_id within this delta. A report can carry
        // more than one dispute over its life (00150 supersede); the most-recent
        // activity is what the badge should reflect.
        var latestByReport: [String: (date: Date, status: String)] = [:]
        for dispute in remoteDisputes {
            let ts = SyncEngine.parseDate(dispute.updated_at ?? dispute.created_at ?? "")
            if let prev = latestByReport[dispute.grade_report_id], prev.date >= ts { continue }
            latestByReport[dispute.grade_report_id] = (ts, dispute.status)
        }

        for (reportId, latest) in latestByReport {
            // Optional on both sides so the predicate macro's `==` type-matches
            // the optional `gradeReportId` column cleanly.
            let target: String? = reportId
            let descriptor = FetchDescriptor<LocalInventoryItem>(
                predicate: #Predicate { $0.gradeReportId == target }
            )
            for item in fetchCounting(descriptor) {
                item.disputeStatus = latest.status
            }
        }
        return modelContext.saveOrLog("mergeDisputes")
    }

    // MARK: - Delete reconciliation (US-1221)

    /// Prunes local sales / expenses / listings / photos the server no longer
    /// has. The watermark-driven delta only ever returns rows that still exist
    /// (with a newer cursor), so a row deleted server-side — on the web, by
    /// another device, or by a background job — would otherwise linger in the
    /// local mirror forever, inflating Money totals, dashboard rollups and the
    /// widget snapshot. ``SyncEngine`` fetches each table's surviving id set
    /// (id column only) and hands them here.
    ///
    /// A `nil` set means "that table's id fetch failed / wasn't run" → its
    /// locals are left untouched (never prune on an incomplete view). Rows whose
    /// id is in `protectedIds` are never pruned — those are offline creates /
    /// staged photo uploads whose server row legitimately doesn't exist yet.
    /// - Parameters:
    ///   - itemIds: surviving `inventory_items` id set (US-1495). A `nil` means
    ///     the fetch failed → items are left untouched.
    ///   - protectedItemIds: ids the inventory-item prune must never remove —
    ///     pending creates PLUS rows with a genuinely-pending local edit
    ///     (`hasLocalChanges`), so an offline edit isn't dropped mid-flush.
    func reconcileDeletes(
        itemIds: Set<String>? = nil,
        saleIds: Set<String>?,
        expenseIds: Set<String>?,
        listingIds: Set<String>?,
        photoIds: Set<String>?,
        protectedIds: Set<String>,
        protectedItemIds: Set<String>? = nil
    ) {
        var pruned = 0
        if let itemIds {
            // US-1495: items deleted on the web (or another device) previously
            // lingered on iOS forever — a later iOS edit then UPDATE'd 0 rows,
            // reported success, and dequeued ('my edit disappeared'). Prune them,
            // but never a pending-create target or a row with unflushed local
            // changes (belt-and-suspenders: also skip `hasLocalChanges` rows).
            let guardIds = protectedItemIds ?? protectedIds
            let rows = (try? modelContext.fetch(FetchDescriptor<LocalInventoryItem>())) ?? []
            for row in rows
            where !itemIds.contains(row.id) && !guardIds.contains(row.id) && !row.hasLocalChanges {
                modelContext.delete(row)
                pruned += 1
            }
        }
        if let saleIds {
            pruned += pruneAbsent(FetchDescriptor<LocalSale>(), keep: saleIds, protected: protectedIds) { $0.id }
        }
        if let expenseIds {
            pruned += pruneAbsent(FetchDescriptor<LocalExpense>(), keep: expenseIds, protected: protectedIds) { $0.id }
        }
        if let listingIds {
            pruned += pruneAbsent(FetchDescriptor<LocalListing>(), keep: listingIds, protected: protectedIds) { $0.id }
        }
        if let photoIds {
            // US-1249: a photo removed via the delta (server-side delete) clears
            // its item's cover cache when it was the item's last photo. An item
            // stays "covered" if ANY of its photos survives — either kept by the
            // server set or protected (an offline-staged upload) — so subtract the
            // surviving items from the ones that lost a photo.
            let rows = (try? modelContext.fetch(FetchDescriptor<LocalItemPhoto>())) ?? []
            let survivingItemIds = Set(
                rows.filter { photoIds.contains($0.id) || protectedIds.contains($0.id) }
                    .map(\.inventoryItemId)
            )
            var deletedItemIds = Set<String>()
            for row in rows where !photoIds.contains(row.id) && !protectedIds.contains(row.id) {
                deletedItemIds.insert(row.inventoryItemId)
                modelContext.delete(row)
                pruned += 1
            }
            clearCoversForEmptiedItems(deletedItemIds.subtracting(survivingItemIds))
        }
        guard pruned > 0 else { return }
        Telemetry.backgroundBreadcrumb(
            "Sync reconciled \(pruned) server-deleted row(s) out of the local mirror",
            category: "sync")
        modelContext.saveOrLog("reconcileDeletes")
    }

    /// Deletes every fetched row whose id is absent from `keep` and not in
    /// `protected`. Returns the count removed. Does NOT save — the caller batches
    /// the save across all tables.
    private func pruneAbsent<T: PersistentModel>(
        _ descriptor: FetchDescriptor<T>,
        keep serverIds: Set<String>,
        protected: Set<String>,
        id: (T) -> String
    ) -> Int {
        let rows = (try? modelContext.fetch(descriptor)) ?? []
        var deleted = 0
        for row in rows {
            let rid = id(row)
            if !serverIds.contains(rid) && !protected.contains(rid) {
                modelContext.delete(row)
                deleted += 1
            }
        }
        return deleted
    }

    // MARK: - Realtime single-row apply (US-198, reuses this shared context)

    func mergeSingleInventory(_ remote: SyncEngine.RemoteInventoryItem) {
        let id = remote.id
        let descriptor = FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { $0.id == id })
        let updatedAt = SyncEngine.parseDate(remote.updated_at)

        if let local = try? modelContext.fetch(descriptor).first {
            Self.applyServerWins(to: local, remote: remote)
            local.updatedAt = updatedAt
        } else {
            let local = LocalInventoryItem(
                id: remote.id,
                userId: remote.user_id,
                title: remote.title,
                status: remote.status,
                createdAt: SyncEngine.parseDate(remote.created_at),
                updatedAt: updatedAt,
                hasLocalChanges: false
            )
            Self.applyServerWins(to: local, remote: remote)
            modelContext.insert(local)
        }
        modelContext.saveOrLog("mergeSingleInventory")
    }

    func deleteInventory(id: String) {
        let descriptor = FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { $0.id == id })
        if let row = try? modelContext.fetch(descriptor).first {
            modelContext.delete(row)
            modelContext.saveOrLog("deleteInventory")
        }
    }

    // MARK: - Widget rollup (US-637, computed off the main thread)

    /// Fetches listings + sales on the background context and returns the pure
    /// rollup. Returning a `Sendable` ``WidgetSnapshot`` (not the `@Model`
    /// rows) keeps the actor boundary clean.
    func widgetSnapshot(isSignedIn: Bool, now: Date = .now) -> WidgetSnapshot {
        let listings = (try? modelContext.fetch(FetchDescriptor<LocalListing>())) ?? []
        let sales = (try? modelContext.fetch(FetchDescriptor<LocalSale>())) ?? []
        return WidgetSnapshotPublisher.compute(
            listings: listings,
            sales: sales,
            now: now,
            isSignedIn: isSignedIn
        )
    }

    // MARK: - Field-level merge helpers (moved off SyncEngine for actor use)

    /// Field-level merge that defers to ``ConflictPolicy`` per column.
    private static func applyServerWins(
        to local: LocalInventoryItem,
        remote: SyncEngine.RemoteInventoryItem
    ) {
        local.title = ConflictPolicy.resolveUserOwned(local: local.title, server: remote.title, hasLocalChanges: local.hasLocalChanges)
        local.brand = ConflictPolicy.resolveUserOwned(local: local.brand, server: remote.brand, hasLocalChanges: local.hasLocalChanges)
        local.sku = ConflictPolicy.resolveUserOwned(local: local.sku, server: remote.sku, hasLocalChanges: local.hasLocalChanges)
        local.size = ConflictPolicy.resolveUserOwned(local: local.size, server: remote.size, hasLocalChanges: local.hasLocalChanges)
        local.color = ConflictPolicy.resolveUserOwned(local: local.color, server: remote.color, hasLocalChanges: local.hasLocalChanges)
        local.material = ConflictPolicy.resolveUserOwned(local: local.material, server: remote.material, hasLocalChanges: local.hasLocalChanges)
        local.itemCategory = ConflictPolicy.resolveUserOwned(local: local.itemCategory, server: remote.item_category, hasLocalChanges: local.hasLocalChanges)
        local.garmentType = ConflictPolicy.resolveUserOwned(local: local.garmentType, server: remote.garment_type, hasLocalChanges: local.hasLocalChanges)
        local.garmentCategory = ConflictPolicy.resolveUserOwned(local: local.garmentCategory, server: remote.garment_category, hasLocalChanges: local.hasLocalChanges)
        local.itemDescription = ConflictPolicy.resolveUserOwned(local: local.itemDescription, server: remote.description, hasLocalChanges: local.hasLocalChanges)
        local.style = ConflictPolicy.resolveUserOwned(local: local.style, server: remote.style, hasLocalChanges: local.hasLocalChanges)
        local.sourcedBy = ConflictPolicy.resolveUserOwned(local: local.sourcedBy, server: remote.sourced_by, hasLocalChanges: local.hasLocalChanges)
        local.container = ConflictPolicy.resolveUserOwned(local: local.container, server: remote.container, hasLocalChanges: local.hasLocalChanges)
        local.acquiredDate = ConflictPolicy.resolveUserOwned(local: local.acquiredDate, server: parseAcquiredDate(remote.acquired_date), hasLocalChanges: local.hasLocalChanges)
        local.compSetJSON = serializeCompSet(remote.comp_set, fallback: local.compSetJSON)
        local.sourceId = ConflictPolicy.resolveUserOwned(local: local.sourceId, server: remote.source_id, hasLocalChanges: local.hasLocalChanges)
        local.locationBin = ConflictPolicy.resolveUserOwned(local: local.locationBin, server: remote.location_bin, hasLocalChanges: local.hasLocalChanges)
        local.consignorId = ConflictPolicy.resolveUserOwned(local: local.consignorId, server: remote.consignor_id, hasLocalChanges: local.hasLocalChanges)
        local.consignmentSplitPct = ConflictPolicy.resolveUserOwned(local: local.consignmentSplitPct, server: remote.consignment_split_pct, hasLocalChanges: local.hasLocalChanges)
        local.conditionNotes = ConflictPolicy.resolveUserOwned(local: local.conditionNotes, server: remote.condition_notes, hasLocalChanges: local.hasLocalChanges)
        local.targetPrice = ConflictPolicy.resolveUserOwned(local: local.targetPrice, server: remote.target_price, hasLocalChanges: local.hasLocalChanges)
        local.measurementsJSON = serializeMeasurements(remote.measurements, fallback: local.measurementsJSON)
        local.acquiredPrice = remote.acquired_price
        local.gradeValue = remote.grade_value
        local.gradeLabel = remote.grade_label
        local.certificateURL = remote.certificate_url
        // US-819: server-owned link; powers the disputes → item mapping. Don't
        // touch `disputeStatus` here — that's owned by `mergeDisputes`.
        local.gradeReportId = remote.grade_report_id
        local.status = ConflictPolicy.resolveServerOwned(local: local.status, server: remote.status)
    }

    private static func serializeMeasurements(_ remote: [String: Double]?, fallback: String?) -> String? {
        guard let remote, !remote.isEmpty else { return fallback }
        return (try? JSONSerialization.data(withJSONObject: remote))
            .flatMap { String(data: $0, encoding: .utf8) }
            ?? fallback
    }

    /// Serialize the server `comp_set` array back to the raw JSON string the
    /// local cache stores. Keeps the local value when the server sends nothing
    /// (mirrors `serializeMeasurements`).
    private static func serializeCompSet(_ remote: [ItemComp]?, fallback: String?) -> String? {
        guard let remote, !remote.isEmpty else { return fallback }
        return ItemComp.encodeList(remote) ?? fallback
    }

    /// Parse `inventory_items.acquired_date` (a "YYYY-MM-DD" date, possibly with
    /// a time/zone suffix) into a Date at UTC midnight. Lenient — nil on failure.
    private static let acquiredDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func parseAcquiredDate(_ raw: String?) -> Date? {
        guard let raw, raw.count >= 10 else { return nil }
        return acquiredDateFormatter.date(from: String(raw.prefix(10)))
    }
}
