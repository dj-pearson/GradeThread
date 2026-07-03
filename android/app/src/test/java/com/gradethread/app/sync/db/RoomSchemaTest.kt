package com.gradethread.app.sync.db

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1316: the schema's contractual behaviors — the photos relation as the
 * presence truth (US-994), the item→photos cascade, FIFO mutation order, and
 * the corruption-recovery chain.
 */
@RunWith(RobolectricTestRunner::class)
class RoomSchemaTest {

    private lateinit var db: GradeThreadDb

    private fun item(id: String, coverUrl: String? = null) = InventoryItemEntity(
        id = id, userId = "u1", title = "Vintage hoodie", brand = null, sku = null,
        size = null, color = null, material = null, status = "sourced",
        itemCategory = null, garmentType = null, garmentCategory = null,
        itemDescription = null, style = null, sourcedBy = null, acquiredDate = null,
        container = null, compSetJson = null, sourceId = null, locationBin = null,
        consignorId = null, consignmentSplitPct = null, acquiredPrice = null,
        targetPrice = null, listingPrice = null, gradeValue = null, gradeLabel = null,
        certificateUrl = null, gradeReportId = null, disputeStatus = null,
        conditionNotes = null, measurementsJson = null, primaryPhotoUrl = coverUrl,
        createdAt = 1L, updatedAt = 1L,
    )

    private fun photo(id: String, itemId: String, sort: Int = 0) = ItemPhotoEntity(
        id = id, inventoryItemId = itemId, photoType = "front",
        photoUrl = "https://x/p.jpg", thumbnailUrl = null, storagePath = null,
        width = null, height = null, bytes = null, sortOrder = sort,
        createdAt = 1L, localBytesPath = null,
    )

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun hasPhotos_derivesFromTheRelation_neverTheCoverUrl() = runTest {
        // US-994: a stale cover URL with NO photo rows must read as no photos…
        db.items().upsert(listOf(item("a", coverUrl = "https://stale/cover.jpg")))
        assertFalse(db.items().itemHasPhotos("a"))
        assertFalse(db.items().withPhotos("a")!!.hasPhotos)

        // …and photo rows with a NULL cover must read as having photos.
        db.items().upsert(listOf(item("b", coverUrl = null)))
        db.photos().upsert(listOf(photo("p1", "b")))
        assertTrue(db.items().itemHasPhotos("b"))
        assertTrue(db.items().withPhotos("b")!!.hasPhotos)
    }

    @Test
    fun deletingAnItem_cascadesItsPhotos() = runTest {
        db.items().upsert(listOf(item("a")))
        db.photos().upsert(listOf(photo("p1", "a"), photo("p2", "a", sort = 1)))
        assertEquals(2, db.photos().forItem("a").size)

        db.items().delete("a")
        assertEquals(0, db.photos().forItem("a").size)
    }

    @Test
    fun photosLoad_inSortOrder() = runTest {
        db.items().upsert(listOf(item("a")))
        db.photos().upsert(listOf(photo("p2", "a", sort = 2), photo("p1", "a", sort = 1)))
        assertEquals(listOf("p1", "p2"), db.photos().forItem("a").map { it.id })
    }

    @Test
    fun pendingMutations_replayFifo() = runTest {
        val base = PendingMutationEntity(
            id = "", kind = "update_item", payload = ByteArray(0), targetId = null,
            lastError = null, lastAttemptAt = null, createdAt = 0L,
        )
        db.pendingMutations().enqueue(base.copy(id = "m2", createdAt = 2L))
        db.pendingMutations().enqueue(base.copy(id = "m1", createdAt = 1L))
        assertEquals(
            listOf("m1", "m2"),
            db.pendingMutations().allInOrder().map { it.id },
        )
    }

    @Test
    fun clearAll_supportsTheSignOutWipe() = runTest {
        db.items().upsert(listOf(item("a")))
        db.photos().upsert(listOf(photo("p1", "a")))
        db.items().clearAll() // cascade removes photos too
        assertNull(db.items().byId("a"))
        assertEquals(0, db.photos().forItem("a").size)
    }

    @Test
    fun corruptStore_recoversDestructivelyThenWorks() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "corrupt-test.db"
        // Plant garbage bytes where the store should be.
        context.getDatabasePath(name).parentFile?.mkdirs()
        context.getDatabasePath(name).writeBytes(ByteArray(64) { 0x42 })

        val recovered = DatabaseProvider.open(context, dbName = name)
        // The recovered store is usable…
        recovered.items().upsert(listOf(item("z")))
        assertTrue(recovered.items().itemHasPhotos("z") == false)
        // …and the one-time notice reflects what happened (RESET, or NORMAL if
        // SQLite silently replaced the garbage file itself — either way, NEVER
        // EPHEMERAL for a recoverable file, and never a crash).
        assertTrue(DatabaseProvider.outcome.value != DatabaseProvider.Outcome.EPHEMERAL)
        recovered.close()
        context.deleteDatabase(name)
    }
}
