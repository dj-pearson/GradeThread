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
    ///   - listingPrices: inventoryItemId → latest listing price, applied to
    ///     each item's cached `listingPrice` so "inventory value" reflects the
    ///     market (listed) price, not cost basis.
    ///   - prune: true ONLY on a full item backfill (no watermark). When true,
    ///     local items the server no longer returns are deleted — this is what
    ///     clears the stale "listed" rows that made the listed count
    ///     (e.g. 922) exceed the real inventory size. In delta mode `items` is
    ///     just the changed rows, so pruning would wrongly wipe the catalog.
    func mergeItems(
        _ items: [SyncEngine.RemoteInventoryItem],
        primaryPhotos: [String: SyncEngine.RemoteItemPhoto],
        listingPrices: [String: Double],
        prune: Bool
    ) {
        guard !items.isEmpty || prune else { return }
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
                if let price = listingPrices[remote.id] { local.listingPrice = price }
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
                if let price = listingPrices[remote.id] { local.listingPrice = price }
                modelContext.insert(local)
                existingById[remote.id] = local
            }
        }

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
        modelContext.saveOrLog("mergeItems")
    }

    /// Upserts item photos. `prune` is true ONLY on a full backfill — in delta
    /// mode `remotePhotos` is just the new rows, so pruning locals not in the
    /// set would wrongly wipe the whole strip.
    func mergePhotos(_ remotePhotos: [SyncEngine.RemoteItemPhoto], prune: Bool) {
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
            for stale in existing where !remoteIds.contains(stale.id) {
                modelContext.delete(stale)
            }
        }
        modelContext.saveOrLog("mergePhotos")
    }

    /// Upserts the user's sales. No pruning — a sale that disappears
    /// server-side is rare and harmless to keep locally.
    func mergeSales(_ remoteSales: [SyncEngine.RemoteSaleRow]) {
        guard !remoteSales.isEmpty else { return }
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
            local.shippingCost = remote.shipping_cost
            local.gradingCost = remote.grading_cost
            local.otherCosts = remote.other_costs
            local.tax = remote.tax
            local.netProfit = remote.net_profit
            local.status = remote.status
            local.saleDate = SyncEngine.parseDate(remote.sale_date)
            local.buyerUsername = remote.buyer_username
        }
        modelContext.saveOrLog("mergeSales")
    }

    /// Upserts the local mirror of `flipdesk_expenses` (US-750) so the Money tab
    /// reads expenses from the same SwiftData cache as everything else. Server is
    /// authoritative for amount/category/date and the 00266 attribution links.
    /// Like sales, expenses never prune, so this is always a delta over the rows
    /// the payload touches.
    func mergeExpenses(_ remoteExpenses: [SyncEngine.RemoteExpenseRow]) {
        guard !remoteExpenses.isEmpty else { return }
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
            local.spentOn = SyncEngine.parseDate(remote.spent_on)
            local.expenseDescription = remote.description
            local.inventoryItemId = remote.inventory_item_id
            local.listingId = remote.listing_id
        }
        modelContext.saveOrLog("mergeExpenses")
    }

    /// Upserts the local mirror of `listings` so the item canvas can resolve a
    /// live eBay listing and decide between in-place revise (Sell offer present)
    /// and an Edit-on-eBay link. Server is authoritative for marketplace fields
    /// (status, price, offer id). Not pruned: the listings fetch is bounded per
    /// pass, so deleting locals absent from one page could wrongly drop rows.
    func mergeListings(_ remoteListings: [SyncEngine.RemoteListing]) {
        guard !remoteListings.isEmpty else { return }
        lastMergeFetchedRowCount = 0
        // Listings aren't pruned (the fetch is bounded per pass), so this is a
        // delta: fetch only the rows the payload touches.
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
            // Server-authoritative marketplace fields (refresh every sync).
            local.platform = remote.platform ?? local.platform
            local.platformListingId = remote.platform_listing_id
            local.platformOfferId = remote.platform_offer_id
            local.externalURL = remote.listing_url
            if let price = remote.listing_price { local.listingPrice = price }
            local.listingStatus = remote.listing_status ?? local.listingStatus
            local.listedAt = remote.listed_at.map(SyncEngine.parseDate)
            // listings has no ended_at column; LocalListing.endedAt stays nil.
            local.listingOrigin = remote.listing_origin
            local.updatedAt = remote.updated_at.map(SyncEngine.parseDate) ?? .now
        }
        modelContext.saveOrLog("mergeListings")
    }

    /// US-819: stamps each item's `disputeStatus` from the synced `disputes`
    /// delta so the Grades list can badge a disputed grade. Disputes are keyed
    /// by `grade_report_id`; we reduce to the latest dispute per report (by
    /// updated_at, created_at fallback), then write its status onto the matching
    /// item — looked up by the indexed `gradeReportId`. Bounded by the number of
    /// CHANGED disputes in this delta (usually 0), never by the grades-list size,
    /// so there is no per-row N+1.
    func mergeDisputes(_ remoteDisputes: [SyncEngine.RemoteDispute]) {
        guard !remoteDisputes.isEmpty else { return }
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
        modelContext.saveOrLog("mergeDisputes")
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
}
