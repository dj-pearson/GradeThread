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
        let existing = (try? modelContext.fetch(FetchDescriptor<LocalInventoryItem>())) ?? []
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let remoteIds = Set(items.map(\.id))

        for remote in items {
            let createdAt = SyncEngine.parseDate(remote.created_at)
            let updatedAt = SyncEngine.parseDate(remote.updated_at)
            let primary = primaryPhotos[remote.id]
            let primaryURL = primary?.thumbnail_url ?? primary?.photo_url

            if let local = existingById[remote.id] {
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
        try? modelContext.save()
    }

    /// Upserts item photos. `prune` is true ONLY on a full backfill — in delta
    /// mode `remotePhotos` is just the new rows, so pruning locals not in the
    /// set would wrongly wipe the whole strip.
    func mergePhotos(_ remotePhotos: [SyncEngine.RemoteItemPhoto], prune: Bool) {
        let existing = (try? modelContext.fetch(FetchDescriptor<LocalItemPhoto>())) ?? []
        var existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let remoteIds = Set(remotePhotos.map(\.id))

        for remote in remotePhotos {
            if let local = existingById[remote.id] {
                local.photoType = remote.photo_type
                local.photoURL = remote.photo_url
                local.thumbnailURL = remote.thumbnail_url
                local.storagePath = remote.storage_path
                local.sortOrder = remote.sort_order
                local.bytes = remote.bytes
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
                existingById[remote.id] = local
            }
        }

        if prune {
            for stale in existing where !remoteIds.contains(stale.id) {
                modelContext.delete(stale)
            }
        }
        try? modelContext.save()
    }

    /// Upserts the user's sales. No pruning — a sale that disappears
    /// server-side is rare and harmless to keep locally.
    func mergeSales(_ remoteSales: [SyncEngine.RemoteSaleRow]) {
        guard !remoteSales.isEmpty else { return }
        let existing = (try? modelContext.fetch(FetchDescriptor<LocalSale>())) ?? []
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
        try? modelContext.save()
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
        try? modelContext.save()
    }

    func deleteInventory(id: String) {
        let descriptor = FetchDescriptor<LocalInventoryItem>(predicate: #Predicate { $0.id == id })
        if let row = try? modelContext.fetch(descriptor).first {
            modelContext.delete(row)
            try? modelContext.save()
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
        local.status = ConflictPolicy.resolveServerOwned(local: local.status, server: remote.status)
    }

    private static func serializeMeasurements(_ remote: [String: Double]?, fallback: String?) -> String? {
        guard let remote, !remote.isEmpty else { return fallback }
        return (try? JSONSerialization.data(withJSONObject: remote))
            .flatMap { String(data: $0, encoding: .utf8) }
            ?? fallback
    }
}
