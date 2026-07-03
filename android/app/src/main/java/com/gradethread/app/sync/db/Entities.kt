package com.gradethread.app.sync.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * US-1316: the offline cache schema — the 7 iOS SwiftData models
 * (Persistence/Models/Local*.swift) as Room entities with the SAME field
 * sets, the US-985 composite indexes, and the item→photos cascade.
 *
 * Carried invariants:
 *  - ids are server UUIDs stored LOWERCASE (the iOS uppercase-UUID sync-dup
 *    incident — normalize at creation, never trust case);
 *  - `hasPhotos` derives from the photos RELATION, never the denormalized
 *    `primaryPhotoUrl` (US-994) — see [ItemDao.itemHasPhotos];
 *  - `hasLocalChanges` marks rows the mutation queue owns until replay.
 */
@Entity(
    tableName = "inventory_items",
    indices = [
        Index("updatedAt"),
        Index("status"),
        Index("gradeValue"),
        Index("gradeValue", "updatedAt"),
        // US-819: dispute sync maps disputes (keyed by grade_report_id) onto items.
        Index("gradeReportId"),
    ],
)
data class InventoryItemEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val title: String,
    val brand: String?,
    val sku: String?,
    val size: String?,
    val color: String?,
    val material: String?,
    val status: String,
    val itemCategory: String?,
    val garmentType: String?,
    val garmentCategory: String?,
    val itemDescription: String?,
    val style: String?,
    val sourcedBy: String?,
    val acquiredDate: Long?,
    val container: String?,
    /** jsonb on the server; round-tripped raw (comp set). */
    val compSetJson: String?,
    val sourceId: String?,
    val locationBin: String?,
    val consignorId: String?,
    val consignmentSplitPct: Double?,
    val acquiredPrice: Double?,
    val targetPrice: Double?,
    val listingPrice: Double?,
    val gradeValue: Double?,
    val gradeLabel: String?,
    val certificateUrl: String?,
    val gradeReportId: String?,
    val disputeStatus: String?,
    val conditionNotes: String?,
    /** jsonb on the server; round-tripped raw. */
    val measurementsJson: String?,
    /** Denormalized cover — DISPLAY ONLY; never photo-presence truth. */
    val primaryPhotoUrl: String?,
    val createdAt: Long,
    val updatedAt: Long,
    @ColumnInfo(defaultValue = "0") val hasLocalChanges: Boolean = false,
)

@Entity(
    tableName = "item_photos",
    indices = [
        Index("inventoryItemId"),
        Index("inventoryItemId", "sortOrder"),
    ],
    foreignKeys = [
        ForeignKey(
            entity = InventoryItemEntity::class,
            parentColumns = ["id"],
            childColumns = ["inventoryItemId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
)
data class ItemPhotoEntity(
    @PrimaryKey val id: String,
    val inventoryItemId: String,
    /** Server flipdesk_photo_type (front/back/tag/detail/defect/flatlay/internal…). */
    val photoType: String,
    val photoUrl: String,
    val thumbnailUrl: String?,
    val storagePath: String?,
    val width: Int?,
    val height: Int?,
    val bytes: Int?,
    val sortOrder: Int,
    /** Bumped on rotate/edit so image caches invalidate (iOS localCacheToken). */
    @ColumnInfo(defaultValue = "0") val localCacheToken: Int = 0,
    val createdAt: Long,
    /** A not-yet-uploaded local capture (offline intake). */
    val localBytesPath: String?,
)

@Entity(
    tableName = "sales",
    indices = [Index("saleDate"), Index("createdAt"), Index("inventoryItemId")],
)
data class SaleEntity(
    @PrimaryKey val id: String,
    val inventoryItemId: String,
    val listingId: String?,
    val salePrice: Double,
    val platformFees: Double,
    val paymentProcessingFees: Double?,
    val shippingCollected: Double?,
    val shippingCost: Double?,
    val gradingCost: Double?,
    val otherCosts: Double?,
    val tax: Double?,
    val netProfit: Double?,
    @ColumnInfo(defaultValue = "'completed'") val status: String = "completed",
    val buyerUsername: String?,
    val platformOrderId: String?,
    val payoutReference: String?,
    val saleDate: Long,
    val soldAt: Long?,
    val shippedAt: Long?,
    val trackingNumber: String?,
    @ColumnInfo(defaultValue = "0") val hasLocalChanges: Boolean = false,
    val createdAt: Long,
)

@Entity(
    tableName = "expenses",
    indices = [Index("spentOn"), Index("inventoryItemId")],
)
data class ExpenseEntity(
    @PrimaryKey val id: String,
    val category: String,
    val expenseDescription: String?,
    val amount: Double,
    val spentOn: Long,
    val inventoryItemId: String?,
    val listingId: String?,
    val createdAt: Long,
)

@Entity(
    tableName = "listings",
    indices = [Index("listingStatus"), Index("inventoryItemId")],
)
data class ListingEntity(
    @PrimaryKey val id: String,
    val inventoryItemId: String,
    val platform: String,
    val platformListingId: String?,
    val platformOfferId: String?,
    val externalUrl: String?,
    val listingPrice: Double,
    val listingStatus: String,
    val listedAt: Long?,
    val endedAt: Long?,
    val viewsTotal: Int?,
    val watchersCount: Int?,
    /** Provenance: which side authored this listing (SYNC_SOURCE_OF_TRUTH.md). */
    val listingOrigin: String?,
    val publishError: String?,
    @ColumnInfo(defaultValue = "0") val hasLocalChanges: Boolean = false,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(tableName = "sources")
data class SourceEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val name: String,
    val sourceType: String,
    val notes: String?,
    val archivedAt: Long?,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(
    tableName = "pending_mutations",
    indices = [Index("createdAt")],
)
data class PendingMutationEntity(
    @PrimaryKey val id: String,
    /** MutationKind discriminator (create_item / update_item / …). */
    val kind: String,
    /** The replay payload, serialized JSON. */
    val payload: ByteArray,
    val targetId: String?,
    @ColumnInfo(defaultValue = "0") val retryCount: Int = 0,
    val lastError: String?,
    val lastAttemptAt: Long?,
    val createdAt: Long,
) {
    // ByteArray needs manual equality for a data class.
    override fun equals(other: Any?): Boolean =
        other is PendingMutationEntity && other.id == id

    override fun hashCode(): Int = id.hashCode()
}

/**
 * US-1324: the in-flight capture session (photos map + active/revealed
 * slots as JSON) so process death/backgrounding recovers the draft.
 */
@Entity(tableName = "capture_drafts")
data class CaptureDraftEntity(
    @PrimaryKey val id: String,
    val stateJson: String,
    val updatedAt: Long,
)
