package com.gradethread.app.sync.db

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
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
        // The probe seam is on an object, so a test that leaves it throwing
        // would break every later test in the run rather than its own.
        DatabaseProvider.probe = { it.openHelper.readableDatabase }
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

    /**
     * US-2340 AC3: a transient open failure must NOT delete the seller's data.
     *
     * The recovery ladder used to run `deleteDatabase` on ANY step-1 throw, so a
     * locked file, low storage or a missing migration cost the seller every
     * unsynced capture and queued mutation. The file below is a perfectly valid
     * store that simply cannot be opened at this path - the directory where it
     * should live is occupied by a FILE, so SQLite fails with a can't-open
     * error rather than a corruption one.
     *
     * The assertion is about the BYTES, not the outcome: whatever the provider
     * decides to do about this session, the thing on disk has to survive it.
     */
    /** Seeds a real store with one row and returns its bytes. */
    private suspend fun seedStore(context: Context, name: String): ByteArray {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        val seeded = DatabaseProvider.open(context, dbName = name)
        seeded.items().upsert(listOf(item("keep-me")))
        seeded.close()
        val bytes = path.readBytes()
        assertTrue("the seeded store should be non-empty", bytes.isNotEmpty())
        return bytes
    }

    @Test
    fun transientOpenFailure_doesNotDeleteTheStore() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "transient-test.db"
        val path = context.getDatabasePath(name)
        val before = seedStore(context, name)

        // A can't-open, NOT a corruption. This is the case that used to cost the
        // seller everything: the ladder deleted on any step-1 throw, so a locked
        // file or low storage was treated exactly like a damaged one.
        DatabaseProvider.probe = {
            throw android.database.sqlite.SQLiteCantOpenDatabaseException("disk busy")
        }
        DatabaseProvider.open(context, dbName = name)

        assertTrue(
            "a transient open failure deleted the store - the seller's unsynced " +
                "captures and queued mutations are what that costs",
            path.exists(),
        )
        assertArrayEquals(
            "the store was rewritten rather than left alone",
            before,
            path.readBytes(),
        )
        assertEquals(
            "an unopenable-but-intact store should run ephemeral for the session",
            DatabaseProvider.Outcome.EPHEMERAL,
            DatabaseProvider.outcome.value,
        )
        context.deleteDatabase(name)
    }

    @Test
    fun realCorruption_stillResets() = runTest {
        // The other half of the rule. Narrowing the delete is only correct if a
        // genuinely damaged store is still recovered - otherwise the fix trades
        // one failure mode for a permanently broken app.
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "corrupt-injected.db"
        seedStore(context, name)

        DatabaseProvider.probe = {
            throw android.database.sqlite.SQLiteDatabaseCorruptException("file is not a database")
        }
        val db = DatabaseProvider.open(context, dbName = name)

        assertEquals(
            DatabaseProvider.Outcome.RESET,
            DatabaseProvider.outcome.value,
        )
        assertNull("the reset store must be empty", db.items().byId("keep-me"))
        db.close()
        context.deleteDatabase(name)
    }

    @Test
    fun corruptionWrappedByRoom_isStillCorruption() = runTest {
        // Room wraps the driver's exception, so the rule reads the cause chain.
        // Asserted separately because a chain-walk that silently stopped at
        // depth 0 would leave every real corruption falling through to
        // ephemeral - the app would run, and never repair itself.
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "corrupt-wrapped.db"
        seedStore(context, name)

        DatabaseProvider.probe = {
            throw IllegalStateException(
                "could not open",
                android.database.sqlite.SQLiteDatabaseCorruptException("malformed"),
            )
        }
        val db = DatabaseProvider.open(context, dbName = name)

        assertEquals(DatabaseProvider.Outcome.RESET, DatabaseProvider.outcome.value)
        db.close()
        context.deleteDatabase(name)
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
