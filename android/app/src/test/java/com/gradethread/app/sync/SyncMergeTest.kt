package com.gradethread.app.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** US-1318: the per-field item merge + the transactional apply. */
@RunWith(RobolectricTestRunner::class)
class SyncMergeTest {

    private lateinit var db: GradeThreadDb
    private lateinit var merger: SyncMerger

    private fun item(
        id: String = "a",
        title: String = "Original",
        gradeValue: Double? = null,
        dirty: Boolean = false,
        updatedAt: Long = 1L,
    ) = InventoryItemEntity(
        id = id, userId = "u1", title = title, brand = null, sku = null, size = null,
        color = null, material = null, status = "sourced", itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = null, targetPrice = null,
        listingPrice = null, gradeValue = gradeValue, gradeLabel = null,
        certificateUrl = null, gradeReportId = null, disputeStatus = null,
        conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
        createdAt = 1L, updatedAt = updatedAt, hasLocalChanges = dirty,
    )

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()
        merger = SyncMerger(db)
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun dirtyLocal_keepsUserFields_butTakesServerOwned() {
        val local = item(title = "My edited title", dirty = true)
        val server = item(title = "Server title", gradeValue = 9.4, updatedAt = 5L)

        val merged = merger.mergeItem(local, server)

        assertEquals("My edited title", merged.title) // user-owned kept
        assertEquals(9.4, merged.gradeValue!!, 0.0) // server-owned taken
        assertTrue(merged.hasLocalChanges) // the pull never clears dirtiness
    }

    @Test
    fun cleanLocal_takesEverythingFromTheServer() {
        val merged = merger.mergeItem(
            item(title = "Old"),
            item(title = "Fresh", gradeValue = 8.0, updatedAt = 9L),
        )
        assertEquals("Fresh", merged.title)
        assertEquals(8.0, merged.gradeValue!!, 0.0)
    }

    @Test
    fun noLocalRow_serverInsertsVerbatim() {
        val server = item(title = "Brand new")
        assertEquals(server, merger.mergeItem(null, server))
    }

    @Test
    fun apply_mergesInsideOneTransaction() = runTest {
        // Seed a dirty local edit.
        db.items().upsert(listOf(item(title = "Local edit", dirty = true)))

        merger.apply(
            SyncMerger.PulledBatch(
                items = listOf(item(title = "Server title", gradeValue = 9.0, updatedAt = 7L)),
            ),
        )

        val stored = db.items().byId("a")!!
        assertEquals("Local edit", stored.title)
        assertEquals(9.0, stored.gradeValue!!, 0.0)
        assertTrue(stored.hasLocalChanges)
    }
}
