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

    @Query("DELETE FROM item_photos")
    suspend fun clearAll()
}

@Dao
interface SaleDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(sales: List<SaleEntity>)

    @Query("SELECT * FROM sales ORDER BY saleDate DESC")
    suspend fun all(): List<SaleEntity>

    @Query("DELETE FROM sales")
    suspend fun clearAll()
}

@Dao
interface ExpenseDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(expenses: List<ExpenseEntity>)

    @Query("SELECT * FROM expenses ORDER BY spentOn DESC")
    suspend fun all(): List<ExpenseEntity>

    @Query("DELETE FROM expenses")
    suspend fun clearAll()
}

@Dao
interface ListingDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(listings: List<ListingEntity>)

    @Query("SELECT * FROM listings WHERE inventoryItemId = :itemId")
    suspend fun forItem(itemId: String): List<ListingEntity>

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

    @Query("DELETE FROM pending_mutations")
    suspend fun clearAll()
}
