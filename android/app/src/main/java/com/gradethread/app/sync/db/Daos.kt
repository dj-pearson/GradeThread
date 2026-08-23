package com.gradethread.app.sync.db

import androidx.room.Dao
import androidx.room.Embedded
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Relation
import androidx.room.Transaction

/**
 * US-1316: base DAOs — the sync-engine stories add their delta/merge queries
 * on top; these cover the shared shapes (upsert, lookups, the photos
 * relation, and per-table wipe for the sign-out contract).
 */

/** An item with its photos loaded via the RELATION (US-994: photo presence
 *  truth is this list, never the denormalized cover URL). */
data class ItemWithPhotos(
    @Embedded val item: InventoryItemEntity,
    @Relation(parentColumn = "id", entityColumn = "inventoryItemId")
    val photos: List<ItemPhotoEntity>,
) {
    val hasPhotos: Boolean get() = photos.isNotEmpty()
}

@Dao
interface ItemDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(items: List<InventoryItemEntity>)

    @Query("SELECT * FROM inventory_items WHERE id = :id")
    suspend fun byId(id: String): InventoryItemEntity?

    @Transaction
    @Query("SELECT * FROM inventory_items WHERE id = :id")
    suspend fun withPhotos(id: String): ItemWithPhotos?

    @Transaction
    @Query("SELECT * FROM inventory_items ORDER BY updatedAt DESC")
    suspend fun allWithPhotos(): List<ItemWithPhotos>

    /**
     * US-1342: the reactive backing for the inventory list. Room re-emits on
     * any write to the table, so sync pulls reach the screen without the UI
     * polling.
     */
    @Query("SELECT * FROM inventory_items")
    fun observeAll(): kotlinx.coroutines.flow.Flow<List<InventoryItemEntity>>

    /** US-1320: reconcile support — ids + dirty ids + bulk delete. */
    @Query("SELECT id FROM inventory_items")
    suspend fun allIds(): List<String>

    @Query("SELECT id FROM inventory_items WHERE hasLocalChanges = 1")
    suspend fun dirtyIds(): List<String>

    @Query("DELETE FROM inventory_items WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    /** US-994: presence via the relation — EXISTS, not primaryPhotoUrl. */
    @Query("SELECT EXISTS(SELECT 1 FROM item_photos WHERE inventoryItemId = :itemId)")
    suspend fun itemHasPhotos(itemId: String): Boolean

    @Query("DELETE FROM inventory_items WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM inventory_items")
    suspend fun clearAll()
}

@Dao
interface PhotoDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(photos: List<ItemPhotoEntity>)

    @Query("SELECT * FROM item_photos WHERE inventoryItemId = :itemId ORDER BY sortOrder")
    suspend fun forItem(itemId: String): List<ItemPhotoEntity>

    /** US-1344: reactive backing for the canvas photo strip. */
    @Query("SELECT * FROM item_photos WHERE inventoryItemId = :itemId ORDER BY sortOrder")
    fun observeForItem(itemId: String): kotlinx.coroutines.flow.Flow<List<ItemPhotoEntity>>

    @Query("SELECT * FROM item_photos WHERE id = :id")
    suspend fun forItemPhoto(id: String): ItemPhotoEntity?

    @Query("DELETE FROM item_photos WHERE id = :id")
    suspend fun delete(id: String)

    @Query("SELECT id FROM item_photos")
    suspend fun allIds(): List<String>

    /**
     * US-1342/US-1520: item ids that HAVE photo rows.
     *
     * One id-level query rather than faulting each item's photo relation —
     * that per-item walk was a main-thread stall on a large inventory. Only
     * read when the photo facet is active.
     */
    @Query("SELECT DISTINCT inventoryItemId FROM item_photos")
    fun observeItemIdsWithPhotos(): kotlinx.coroutines.flow.Flow<List<String>>

    /** Local captures not yet uploaded — never reconcile-pruned. */
    @Query("SELECT id FROM item_photos WHERE localBytesPath IS NOT NULL")
    suspend fun localOnlyIds(): List<String>

    @Query("DELETE FROM item_photos WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM item_photos")
    suspend fun clearAll()
}

@Dao
interface SaleDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(sales: List<SaleEntity>)

    @Query("SELECT * FROM sales ORDER BY saleDate DESC")
    suspend fun all(): List<SaleEntity>

    /**
     * US-1363/US-1371: reactive backing for Money + the sales list.
     *
     * Deliberately UNFILTERED by status: the rollups exclude non-completed
     * sales themselves (via `SalePnL.isCompleted`), while the sales list must
     * SHOW refunded and cancelled orders. Filtering here would make the list
     * silently lie about what happened.
     */
    @Query("SELECT * FROM sales ORDER BY saleDate DESC")
    fun observeAll(): kotlinx.coroutines.flow.Flow<List<SaleEntity>>

    @Query("SELECT id FROM sales")
    suspend fun allIds(): List<String>

    /** US-1351: the eBay-sync summary's sales total. */
    @Query("SELECT COUNT(*) FROM sales")
    suspend fun count(): Int

    @Query("SELECT id FROM sales WHERE hasLocalChanges = 1")
    suspend fun dirtyIds(): List<String>

    @Query("DELETE FROM sales WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM sales")
    suspend fun clearAll()
}

/** US-1365: the payout side of reconciliation. */
@Dao
interface PayoutDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(payouts: List<PayoutEntity>)

    @Query("SELECT * FROM ebay_payouts ORDER BY payoutDate DESC")
    fun observeAll(): kotlinx.coroutines.flow.Flow<List<PayoutEntity>>

    @Query("SELECT * FROM ebay_payouts ORDER BY payoutDate DESC")
    suspend fun all(): List<PayoutEntity>

    @Query("DELETE FROM ebay_payouts")
    suspend fun clearAll()
}

@Dao
interface ExpenseDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(expenses: List<ExpenseEntity>)

    @Query("SELECT * FROM expenses ORDER BY spentOn DESC")
    suspend fun all(): List<ExpenseEntity>

    /** US-1363/US-1364: reactive backing for the cash-flow panel + list. */
    @Query("SELECT * FROM expenses ORDER BY spentOn DESC")
    fun observeAll(): kotlinx.coroutines.flow.Flow<List<ExpenseEntity>>

    @Query("SELECT * FROM expenses WHERE id = :id")
    suspend fun byId(id: String): ExpenseEntity?

    @Query("SELECT id FROM expenses")
    suspend fun allIds(): List<String>

    @Query("DELETE FROM expenses WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM expenses")
    suspend fun clearAll()
}

@Dao
interface ListingDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(listings: List<ListingEntity>)

    @Query("SELECT * FROM listings WHERE inventoryItemId = :itemId")
    suspend fun forItem(itemId: String): List<ListingEntity>

    /**
     * US-2494: the FlipDesk item behind a marketplace listing id.
     *
     * The negotiation inbox works in eBay's ids — an offer names the listing,
     * not the item — while the AI routes take an `inventory_items` id. Without
     * this hop the client would post eBay's id into a UUID column and read the
     * resulting 404 as "the item is missing".
     */
    @Query(
        "SELECT inventoryItemId FROM listings " +
            "WHERE platform = :platform AND platformListingId = :platformListingId LIMIT 1",
    )
    suspend fun itemIdForPlatformListing(platformListingId: String, platform: String): String?

    /** US-1349: the whole table, for global search. */
    @Query("SELECT * FROM listings")
    suspend fun all(): List<ListingEntity>

    /**
     * US-1351: the cached rows a pulled batch lands on, in ONE query — the
     * per-row lookup [ItemDao.byId] does is fine for items but would be a
     * query per listing on a full eBay pull.
     */
    @Query("SELECT * FROM listings WHERE id IN (:ids)")
    suspend fun byIds(ids: List<String>): List<ListingEntity>

    /** US-1351: reactive backing for the listings surface. */
    @Query("SELECT * FROM listings ORDER BY listedAt DESC, createdAt DESC")
    fun observeAll(): kotlinx.coroutines.flow.Flow<List<ListingEntity>>

    @Query("SELECT COUNT(*) FROM listings")
    suspend fun count(): Int

    /** Live listings — the statuses in `ConflictPolicy.liveListingStatuses`. */
    @Query("SELECT COUNT(*) FROM listings WHERE listingStatus IN (:statuses)")
    suspend fun countByStatus(statuses: Collection<String>): Int

    @Query("SELECT id FROM listings")
    suspend fun allIds(): List<String>

    @Query("SELECT id FROM listings WHERE hasLocalChanges = 1")
    suspend fun dirtyIds(): List<String>

    @Query("DELETE FROM listings WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM listings")
    suspend fun clearAll()
}

@Dao
interface SourceDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(sources: List<SourceEntity>)

    @Query("SELECT * FROM sources ORDER BY name")
    suspend fun all(): List<SourceEntity>

    /** US-1363: reactive backing for the ROI-by-source panel. */
    @Query("SELECT * FROM sources ORDER BY name")
    fun observeAll(): kotlinx.coroutines.flow.Flow<List<SourceEntity>>

    @Query("DELETE FROM sources")
    suspend fun clearAll()
}

@Dao
interface PendingMutationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun enqueue(mutation: PendingMutationEntity)

    /** FIFO — create-before-edit replay ordering depends on this. */
    @Query("SELECT * FROM pending_mutations ORDER BY createdAt ASC")
    suspend fun allInOrder(): List<PendingMutationEntity>

    @Query("DELETE FROM pending_mutations WHERE id = :id")
    suspend fun delete(id: String)

    /** US-1319: retry bookkeeping (terminal pins retryCount to the budget). */
    @Query(
        "UPDATE pending_mutations SET retryCount = :retryCount, lastError = :lastError, " +
            "lastAttemptAt = :lastAttemptAt WHERE id = :id",
    )
    suspend fun markAttempt(id: String, retryCount: Int, lastError: String?, lastAttemptAt: Long?)

    @Query("DELETE FROM pending_mutations")
    suspend fun clearAll()

    /**
     * US-2792: counts for the shell's sync bar, PUSHED rather than polled.
     *
     * Pending deliberately EXCLUDES stuck rows. They are counted separately
     * and mean something different to a seller - queued work will go on its
     * own once there is a connection, whereas stuck work has exhausted its
     * retries and needs a deliberate retry or discard. Counting a stuck row
     * as pending would promise it is still trying.
     */
    @Query("SELECT COUNT(*) FROM pending_mutations WHERE retryCount < :maxRetries")
    fun observePendingCount(maxRetries: Int): kotlinx.coroutines.flow.Flow<Int>

    @Query("SELECT COUNT(*) FROM pending_mutations WHERE retryCount >= :maxRetries")
    fun observeStuckCount(maxRetries: Int): kotlinx.coroutines.flow.Flow<Int>
}

@Dao
interface CaptureDraftDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(draft: CaptureDraftEntity)

    @Query("SELECT * FROM capture_drafts WHERE id = :id")
    suspend fun byId(id: String): CaptureDraftEntity?

    @Query("DELETE FROM capture_drafts WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM capture_drafts")
    suspend fun clearAll()
}

/** US-2408: the one in-flight AutoLister session. */
@Dao
interface AutolisterSessionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(session: AutolisterSessionEntity)

    @Query("SELECT * FROM autolister_sessions WHERE id = :id")
    suspend fun byId(id: String): AutolisterSessionEntity?

    @Query("DELETE FROM autolister_sessions WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM autolister_sessions")
    suspend fun clearAll()
}

/** US-1382: the share-target inbox. */
@Dao
interface IntakeBatchDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(batch: IntakeBatchEntity)

    /** Oldest first — batches drain in the order they were shared. */
    @Query("SELECT * FROM intake_batches ORDER BY createdAt ASC")
    suspend fun all(): List<IntakeBatchEntity>

    @Query("DELETE FROM intake_batches WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM intake_batches")
    suspend fun clearAll()
}
