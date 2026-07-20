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

    @Query("SELECT id FROM sales")
    suspend fun allIds(): List<String>

    @Query("SELECT id FROM sales WHERE hasLocalChanges = 1")
    suspend fun dirtyIds(): List<String>

    @Query("DELETE FROM sales WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM sales")
    suspend fun clearAll()
}

@Dao
interface ExpenseDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(expenses: List<ExpenseEntity>)

    @Query("SELECT * FROM expenses ORDER BY spentOn DESC")
    suspend fun all(): List<ExpenseEntity>

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
