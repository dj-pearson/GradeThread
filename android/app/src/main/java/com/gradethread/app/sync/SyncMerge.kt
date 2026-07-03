package com.gradethread.app.sync

import androidx.room.withTransaction
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
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
    internal fun userOwnedDiffers(a: InventoryItemEntity, b: InventoryItemEntity): Boolean =
        a.title != b.title || a.brand != b.brand || a.sku != b.sku ||
            a.conditionNotes != b.conditionNotes || a.measurementsJson != b.measurementsJson ||
            a.targetPrice != b.targetPrice || a.itemDescription != b.itemDescription

    // ── Transactional apply (off-main; AC3) ──────────────────────────────────

    data class PulledBatch(
        val items: List<InventoryItemEntity> = emptyList(),
        val photos: List<ItemPhotoEntity> = emptyList(),
        val sales: List<SaleEntity> = emptyList(),
        val expenses: List<ExpenseEntity> = emptyList(),
        val listings: List<ListingEntity> = emptyList(),
        val sources: List<SourceEntity> = emptyList(),
    )

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
            if (batch.listings.isNotEmpty()) db.listings().upsert(batch.listings)
            if (batch.sources.isNotEmpty()) db.sources().upsert(batch.sources)
        }
    }
}
