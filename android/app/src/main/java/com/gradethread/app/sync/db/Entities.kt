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
    /** US-1347: the resolved eBay leaf category this item's specifics belong to. */
    @ColumnInfo(defaultValue = "NULL") val ebayCategoryId: String? = null,
    /** US-1347: `ebay_aspects` jsonb — aspect name → values. Round-tripped raw. */
    @ColumnInfo(defaultValue = "NULL") val ebayAspectsJson: String? = null,
    /**
     * US-1347: `ebay_aspect_sources` jsonb (00184) — the PARALLEL provenance
     * map. Deliberately parallel rather than folded into the value map: the
     * value map is read on hot publish/prefill paths that require its
     * `name -> [values]` shape, and a missing key just means "source unknown".
     */
    @ColumnInfo(defaultValue = "NULL") val ebayAspectSourcesJson: String? = null,
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
    /**
     * US-2469 (migration 00587): the `item_photos.photo_role` qualifier — the
     * open-text half of the pair that says what the photo actually SHOWS. Null
     * for a type that takes no qualifier, and null on every row written before
     * 00587 backfilled them.
     *
     * Photo identity is (photoType, photoRole), not photoType: a suit holds
     * three separate `tag` photos, which is the whole reason the enum stopped
     * growing a `tag_2`.
     */
    @ColumnInfo(defaultValue = "NULL") val photoRole: String? = null,
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
    /**
     * US-1365: what this sale was actually paid out, when eBay reported it.
     * Null means unknown — reconciliation then falls back to price minus fees
     * and SAYS it estimated, rather than presenting a guess as a fact.
     */
    @ColumnInfo(defaultValue = "NULL") val payoutAmount: Double? = null,
    val saleDate: Long,
    val soldAt: Long?,
    val shippedAt: Long?,
    val trackingNumber: String?,
    @ColumnInfo(defaultValue = "0") val hasLocalChanges: Boolean = false,
    val createdAt: Long,
)

/**
 * US-1365: an eBay payout — the lump-sum bank deposit, keyed by eBay's own
 * payoutId. Sales point back at it through `payoutReference`, which is what
 * makes reconciliation possible without another network call.
 */
@Entity(
    tableName = "ebay_payouts",
    indices = [Index("payoutId", unique = true), Index("payoutDate")],
)
data class PayoutEntity(
    @PrimaryKey val id: String,
    /** eBay's id — the value `sales.payoutReference` carries. */
    val payoutId: String,
    /** Stored in CENTS, as the server does: a deposit compared in floats drifts. */
    val amountCents: Int?,
    val currency: String?,
    val status: String?,
    val payoutDate: Long?,
    val transactionCount: Int?,
    val updatedAt: Long,
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

/**
 * US-3000: a mileage trip, logged on the phone at the store.
 *
 * `tripDate` is an epoch-ms ANCHOR for a calendar date, not a moment. Every
 * read and write of it goes through CalendarDateField, because `trip_date` is
 * the same shape of column as `spent_on` and US-2339 walked that one back a day
 * per edit cycle when the parse and the format disagreed about the zone.
 *
 * `miles` is a Double holding an exact 1-dp value, converted from integer
 * tenths at the boundary in TripDraft -- the server column is numeric(8,1), and
 * a log that records 12.299999999999999 miles produces a deduction the seller
 * cannot reconcile against their own arithmetic.
 */
@Entity(
    tableName = "mileage_trips",
    indices = [Index("tripDate")],
)
data class MileageTripEntity(
    @PrimaryKey val id: String,
    val tripDate: Long,
    val miles: Double,
    val purpose: String,
    val startLocation: String?,
    val endLocation: String?,
    val roundTrip: Boolean,
    val sourceId: String?,
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
    /**
     * US-1351/US-1973: the listed available quantity, mirrored from eBay.
     * eBay-owned + editable (same class as price/status), so the merge routes
     * it through the provenance policy. `0` = out of stock: the offer stays
     * published but nothing is buyable. Null on rows synced before a pull first
     * observed the column — the card says "—" rather than inventing a 1.
     */
    @ColumnInfo(defaultValue = "NULL") val quantity: Int? = null,
    /** Provenance: which side authored this listing (vault/20-domain/sync-source-of-truth.md). */
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

/**
 * US-2886: the workspace roster of PEOPLE who source inventory.
 *
 * `inventory_items.sourcedBy` is still a NAME string — this table only decides
 * which names the "Sourced by" picker offers. The workspace owner and every
 * workspace member are added to it server-side by the 00672 triggers, so the
 * roster fills itself and the phone only has to read it.
 */
@Entity(tableName = "sourcers")
data class SourcerEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val name: String,
    /** The workspace user this entry IS, when it is one. Null for anyone else. */
    val memberUserId: String?,
    /** Set = hidden from the pickers; historical sourcedBy text is untouched. */
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
    override fun equals(other: Any?): Boolean = other is PendingMutationEntity && other.id == id

    override fun hashCode(): Int = id.hashCode()
}

/**
 * US-1324: the in-flight capture session (photos map + active/revealed
 * slots as JSON) so process death/backgrounding recovers the draft.
 */
@Entity(tableName = "capture_drafts")
data class CaptureDraftEntity(@PrimaryKey val id: String, val stateJson: String, val updatedAt: Long)

/**
 * US-1382: one batch of photos shared into the app from somewhere else.
 *
 * Rows, not files-with-a-manifest. iOS needs a manifest.json because its Share
 * Extension is a separate process writing into an App Group container it must
 * describe to the main app; the Android share target runs in this process and
 * already has Room, so the manifest IS the row. The JPEGs still live on disk —
 * the row carries their paths.
 */
/**
 * US-2408: the in-flight AutoLister session.
 *
 * One row, like [CaptureDraftEntity], because a seller can only be sorting one
 * batch at a time and a second row would mean two sessions writing to the same
 * `_staging/` shelf. The photos live in Supabase storage already — the row
 * carries their paths, the grouping, and nothing else.
 */
@Entity(tableName = "autolister_sessions")
data class AutolisterSessionEntity(@PrimaryKey val id: String, val stateJson: String, val updatedAt: Long)

@Entity(tableName = "intake_batches")
data class IntakeBatchEntity(
    @PrimaryKey val id: String,
    /** Serialized list of slot/filename/bytes entries. */
    val photosJson: String,
    val createdAt: Long,
)
