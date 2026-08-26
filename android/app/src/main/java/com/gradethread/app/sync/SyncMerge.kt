// ktlint's filename rule wants this file called SyncMerger.kt. detekt already
// carries the same finding as a BASELINED exception
// (MatchingDeclarationName:SyncMerge.kt$SyncMerger in config/detekt/baseline.xml),
// so the rename is a decision that has already been made and recorded --
// re-making it as a side effect of an unrelated change would move a core sync
// file out from under every open branch. spotless is RATCHETED against
// origin/main, so this only surfaced when the file was next touched.
@file:Suppress("ktlint:standard:filename")

package com.gradethread.app.sync

import androidx.room.withTransaction
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.PayoutEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
import com.gradethread.app.sync.db.SourcerEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * US-1318: applies [ConflictPolicy] per field-class when a pulled server row
 * lands on a cached local row, then upserts everything in ONE Room
 * transaction off the main thread.
 *
 * Rules carried from iOS:
 *  - `hasLocalChanges` is the ONLY editedness truth; a dirty concurrent edit
 *    keeps the local user-owned fields and breadcrumbs the conflict;
 *  - sales/expenses are NEVER pruned during a delta pull (delta can't see
 *    server-side deletes — reconciliation is a separate explicit pass);
 *  - the merged row keeps the local dirty flag (the mutation queue clears it
 *    after a successful replay, never the pull).
 */
class SyncMerger(private val db: GradeThreadDb) {

    /** Field-level item merge (pure; unit-tested). */
    fun mergeItem(local: InventoryItemEntity?, server: InventoryItemEntity): InventoryItemEntity {
        if (local == null) return server
        val dirty = local.hasLocalChanges

        if (dirty && userOwnedDiffers(local, server)) {
            // Keep local, but make the conflict visible in crash context.
            Telemetry.breadcrumb(
                "sync conflict: dirty local item kept over server (${local.id})",
                category = "sync",
            )
        }

        return InventoryItemEntity(
            id = server.id,
            userId = server.userId,
            // ── user-owned-if-dirty ──
            title = ConflictPolicy.resolveUserOwned(local.title, server.title, dirty),
            brand = ConflictPolicy.resolveUserOwned(local.brand, server.brand, dirty),
            sku = ConflictPolicy.resolveUserOwned(local.sku, server.sku, dirty),
            size = ConflictPolicy.resolveUserOwned(local.size, server.size, dirty),
            color = ConflictPolicy.resolveUserOwned(local.color, server.color, dirty),
            material = ConflictPolicy.resolveUserOwned(local.material, server.material, dirty),
            itemCategory = ConflictPolicy.resolveUserOwned(local.itemCategory, server.itemCategory, dirty),
            garmentType = ConflictPolicy.resolveUserOwned(local.garmentType, server.garmentType, dirty),
            garmentCategory = ConflictPolicy.resolveUserOwned(local.garmentCategory, server.garmentCategory, dirty),
            itemDescription = ConflictPolicy.resolveUserOwned(local.itemDescription, server.itemDescription, dirty),
            style = ConflictPolicy.resolveUserOwned(local.style, server.style, dirty),
            conditionNotes = ConflictPolicy.resolveUserOwned(local.conditionNotes, server.conditionNotes, dirty),
            measurementsJson = ConflictPolicy.resolveUserOwned(local.measurementsJson, server.measurementsJson, dirty),
            targetPrice = ConflictPolicy.resolveUserOwned(local.targetPrice, server.targetPrice, dirty),
            acquiredPrice = ConflictPolicy.resolveUserOwned(local.acquiredPrice, server.acquiredPrice, dirty),
            locationBin = ConflictPolicy.resolveUserOwned(local.locationBin, server.locationBin, dirty),
            container = ConflictPolicy.resolveUserOwned(local.container, server.container, dirty),
            // ── server-owned (pipeline/marketplace/grading authored) ──
            status = ConflictPolicy.resolveServerOwned(local.status, server.status),
            listingPrice = ConflictPolicy.resolveServerOwned(local.listingPrice, server.listingPrice),
            gradeValue = ConflictPolicy.resolveServerOwned(local.gradeValue, server.gradeValue),
            gradeLabel = ConflictPolicy.resolveServerOwned(local.gradeLabel, server.gradeLabel),
            certificateUrl = ConflictPolicy.resolveServerOwned(local.certificateUrl, server.certificateUrl),
            gradeReportId = ConflictPolicy.resolveServerOwned(local.gradeReportId, server.gradeReportId),
            disputeStatus = ConflictPolicy.resolveServerOwned(local.disputeStatus, server.disputeStatus),
            compSetJson = ConflictPolicy.resolveServerOwned(local.compSetJson, server.compSetJson),
            primaryPhotoUrl = ConflictPolicy.resolveServerOwned(local.primaryPhotoUrl, server.primaryPhotoUrl),
            // ── neutral: newest row wins ──
            sourcedBy = neutral(local, server, local.sourcedBy, server.sourcedBy),
            acquiredDate = neutral(local, server, local.acquiredDate, server.acquiredDate),
            sourceId = neutral(local, server, local.sourceId, server.sourceId),
            consignorId = neutral(local, server, local.consignorId, server.consignorId),
            consignmentSplitPct = neutral(local, server, local.consignmentSplitPct, server.consignmentSplitPct),
            createdAt = server.createdAt,
            updatedAt = maxOf(local.updatedAt, server.updatedAt),
            // The mutation queue clears dirtiness after replay — never the pull.
            hasLocalChanges = local.hasLocalChanges,
        )
    }

    /**
     * US-1351: field-level listing merge (iOS SyncMergeActor.mergeListings).
     *
     * Price, status and quantity are eBay-OWNED EDITABLE fields, so they go
     * through the provenance policy rather than being overwritten: an
     * eBay-originated listing always takes the server value (eBay is the source
     * of truth), while a GradeThread-originated one carrying a pending local
     * edit keeps its local value until the mutation queue replays it. A null
     * origin on the delta falls back to the cached marker, then to gradethread.
     *
     * Everything else about the listing is platform identity or server-owned
     * bookkeeping and refreshes every pass. Pure; unit-tested.
     */
    fun mergeListing(local: ListingEntity?, server: ListingEntity): ListingEntity {
        if (local == null) return server
        val dirty = local.hasLocalChanges
        val origin = server.listingOrigin ?: local.listingOrigin

        fun <T> ebayOwned(localValue: T, serverValue: T): T =
            ConflictPolicy.resolveEbayOwnedListingField(localValue, serverValue, dirty, origin)

        return ListingEntity(
            id = server.id,
            inventoryItemId = server.inventoryItemId,
            // ── platform identity: server-authoritative every pass ──
            platform = server.platform,
            platformListingId = server.platformListingId,
            platformOfferId = server.platformOfferId,
            externalUrl = server.externalUrl,
            listedAt = server.listedAt,
            endedAt = server.endedAt,
            viewsTotal = server.viewsTotal,
            watchersCount = server.watchersCount,
            // ── eBay-owned editable: provenance decides ──
            listingPrice = ebayOwned(local.listingPrice, server.listingPrice),
            listingStatus = ebayOwned(local.listingStatus, server.listingStatus),
            // A server null means "never observed", not "set it to nothing" —
            // keep what we already had rather than blanking the card.
            quantity = server.quantity?.let { ebayOwned(local.quantity ?: it, it) }
                ?: local.quantity,
            // ── server-owned ──
            listingOrigin = server.listingOrigin ?: local.listingOrigin,
            publishError = server.publishError,
            createdAt = server.createdAt,
            updatedAt = maxOf(local.updatedAt, server.updatedAt),
            // The mutation queue clears dirtiness after replay — never the pull.
            hasLocalChanges = local.hasLocalChanges,
        )
    }

    private fun <T> neutral(
        local: InventoryItemEntity,
        server: InventoryItemEntity,
        localValue: T,
        serverValue: T,
    ): T = ConflictPolicy.resolveByTimestamp(
        localValue,
        serverValue,
        localUpdatedAtMs = local.updatedAt,
        serverUpdatedAtMs = server.updatedAt,
    )

    /** Any user-owned field differing while dirty = a real conflict. */
    internal fun userOwnedDiffers(a: InventoryItemEntity, b: InventoryItemEntity): Boolean = a.title != b.title ||
        a.brand != b.brand ||
        a.sku != b.sku ||
        a.conditionNotes != b.conditionNotes ||
        a.measurementsJson != b.measurementsJson ||
        a.targetPrice != b.targetPrice ||
        a.itemDescription != b.itemDescription

    // ── Transactional apply (off-main; AC3) ──────────────────────────────────

    data class PulledBatch(
        val items: List<InventoryItemEntity> = emptyList(),
        val photos: List<ItemPhotoEntity> = emptyList(),
        val sales: List<SaleEntity> = emptyList(),
        val expenses: List<ExpenseEntity> = emptyList(),
        val listings: List<ListingEntity> = emptyList(),
        val sources: List<SourceEntity> = emptyList(),
        val sourcers: List<SourcerEntity> = emptyList(),
        val payouts: List<PayoutEntity> = emptyList(),
    )

    /** US-1321: a realtime DELETE is server-authoritative — remove the local
     *  row (the FK cascade drops its photos). */
    suspend fun deleteItemLocally(id: String) = withContext(Dispatchers.IO) {
        db.items().delete(id)
    }

    /**
     * Merge + upsert a pulled batch in one transaction on IO. Delta NEVER
     * prunes: rows absent from a delta page aren't deletions (the delta can't
     * see deletes); sales/expenses in particular are append-authoritative.
     */
    suspend fun apply(batch: PulledBatch) = withContext(Dispatchers.IO) {
        db.withTransaction {
            if (batch.items.isNotEmpty()) {
                val merged = batch.items.map { server ->
                    mergeItem(db.items().byId(server.id), server)
                }
                db.items().upsert(merged)
            }
            if (batch.photos.isNotEmpty()) db.photos().upsert(batch.photos)
            if (batch.sales.isNotEmpty()) db.sales().upsert(batch.sales)
            if (batch.expenses.isNotEmpty()) db.expenses().upsert(batch.expenses)
            if (batch.listings.isNotEmpty()) {
                // US-1351: merged, not blind-upserted. A plain upsert threw away
                // the local side of every eBay-owned editable field, so a pull
                // racing a just-made price or out-of-stock edit silently undid
                // it — and re-published the old number on the next push.
                val cached = db.listings()
                    .byIds(batch.listings.map { it.id })
                    .associateBy { it.id }
                db.listings().upsert(batch.listings.map { mergeListing(cached[it.id], it) })
            }
            if (batch.sources.isNotEmpty()) db.sources().upsert(batch.sources)
            if (batch.sourcers.isNotEmpty()) db.sourcers().upsert(batch.sourcers)
            // US-1365: payouts are wholly server-authored — there is no local
            // edit to protect, so a plain upsert is correct here.
            if (batch.payouts.isNotEmpty()) db.payouts().upsert(batch.payouts)
        }
    }
}
