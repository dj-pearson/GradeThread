package com.gradethread.app.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.sync.db.SaleEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** US-1320: prune correctness, the protected sets, and the throttle. */
@RunWith(RobolectricTestRunner::class)
class DeleteReconcilerTest {

    private lateinit var db: GradeThreadDb
    private var now = 0L
    private lateinit var reconciler: DeleteReconciler

    private fun item(id: String, dirty: Boolean = false) = InventoryItemEntity(
        id = id, userId = "u1", title = "t", brand = null, sku = null, size = null,
        color = null, material = null, status = "sourced", itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = null, targetPrice = null,
        listingPrice = null, gradeValue = null, gradeLabel = null, certificateUrl = null,
        gradeReportId = null, disputeStatus = null, conditionNotes = null,
        measurementsJson = null, primaryPhotoUrl = null, createdAt = 1, updatedAt = 1,
        hasLocalChanges = dirty,
    )

    private fun sale(id: String, dirty: Boolean = false) = SaleEntity(
        id = id, inventoryItemId = "i", listingId = null, salePrice = 10.0,
        platformFees = 1.0, paymentProcessingFees = null, shippingCollected = null,
        shippingCost = null, gradingCost = null, otherCosts = null, tax = null,
        netProfit = null, buyerUsername = null, platformOrderId = null,
        payoutReference = null, saleDate = 1, soldAt = null, shippedAt = null,
        trackingNumber = null, hasLocalChanges = dirty, createdAt = 1,
    )

    private fun photo(id: String, itemId: String, localPath: String? = null) = ItemPhotoEntity(
        id = id, inventoryItemId = itemId, photoType = "front", photoUrl = "u",
        thumbnailUrl = null, storagePath = null, width = null, height = null,
        bytes = null, sortOrder = 0, createdAt = 1, localBytesPath = localPath,
    )

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()
        now = 0L
        reconciler = DeleteReconciler(db, clock = { now })
    }

    @After
    fun tearDown() {
        db.close()
    }

    /** Everything survives everywhere except what the test overrides. */
    private fun fetcher(
        overrides: Map<DeleteReconciler.Table, Set<String>?>,
        allElse: Set<String> = emptySet(),
    ): suspend (DeleteReconciler.Table) -> Set<String>? = { table ->
        if (table in overrides) overrides[table] else allElse
    }

    @Test
    fun prunesRowsAbsentFromTheSurvivingSet() = runTest {
        db.sales().upsert(listOf(sale("s1"), sale("s2")))
        val outcome = reconciler.reconcileIfDue(
            fetcher(mapOf(DeleteReconciler.Table.SALES to setOf("s1"))),
        )
        assertTrue(outcome.ran)
        assertEquals(listOf("s1"), db.sales().allIds())
    }

    @Test
    fun dirtyRows_areNeverPruned() = runTest {
        db.sales().upsert(listOf(sale("s1", dirty = true)))
        db.items().upsert(listOf(item("i1", dirty = true)))
        reconciler.reconcileIfDue(fetcher(emptyMap())) // server has NOTHING
        assertEquals(listOf("s1"), db.sales().allIds())
        assertEquals(listOf("i1"), db.items().allIds())
    }

    @Test
    fun queuedCreatesAndUploadPhotos_areProtected() = runTest {
        db.items().upsert(listOf(item("i-new")))
        db.photos().upsert(listOf(photo("p-new", "i-new")))
        // A queued create for the item + a queued upload carrying the photo id.
        val queue = OfflineMutationQueue(db, clock = { now })
        queue.enqueue(MutationKind.CREATE_INVENTORY_ITEM, "i-new", ByteArray(0))
        queue.enqueue(
            MutationKind.UPLOAD_PHOTO,
            "i-new", // targetId is the PARENT item
            """{"photo_id":"p-new"}""".encodeToByteArray(),
        )

        reconciler.reconcileIfDue(fetcher(emptyMap()))
        assertEquals(listOf("i-new"), db.items().allIds())
        assertEquals(listOf("p-new"), db.photos().allIds())
    }

    @Test
    fun localOnlyCaptures_areProtected() = runTest {
        db.items().upsert(listOf(item("i1", dirty = true)))
        db.photos().upsert(listOf(photo("p-local", "i1", localPath = "/data/p.jpg")))
        reconciler.reconcileIfDue(fetcher(emptyMap()))
        assertEquals(listOf("p-local"), db.photos().allIds())
    }

    @Test
    fun aFailedTableFetch_leavesThatTableUntouched() = runTest {
        db.sales().upsert(listOf(sale("s1")))
        db.expenses().upsert(emptyList())
        val outcome = reconciler.reconcileIfDue(
            fetcher(mapOf(DeleteReconciler.Table.SALES to null)),
        )
        assertTrue(outcome.ran) // other tables still reconciled
        assertEquals(listOf("s1"), db.sales().allIds()) // sales untouched
    }

    @Test
    fun throttle_skipsWithinTheWindow_butAFailedPassDoesNotAdvanceIt() = runTest {
        // Pass 1: total failure (offline) — must NOT advance the throttle.
        var offline = reconciler.reconcileIfDue { null }
        assertFalse(offline.ran)

        // Immediately after (still t=0): a healthy pass RUNS (no throttle set).
        db.sales().upsert(listOf(sale("s-gone")))
        val healthy = reconciler.reconcileIfDue(fetcher(emptyMap()))
        assertTrue(healthy.ran)
        assertEquals(0, db.sales().allIds().size)

        // Within the window: skipped.
        now += DeleteReconciler.RECONCILE_INTERVAL_MS - 1
        assertFalse(reconciler.reconcileIfDue(fetcher(emptyMap())).ran)

        // Past the window: runs again.
        now += 2
        assertTrue(reconciler.reconcileIfDue(fetcher(emptyMap())).ran)
    }

    @Test
    fun uploadPhotoId_parsesAndToleratesGarbage() {
        assertEquals(
            "p1",
            DeleteReconciler.uploadPhotoId("""{"photo_id":"p1"}""".encodeToByteArray()),
        )
        assertNull(DeleteReconciler.uploadPhotoId(ByteArray(0)))
        assertNull(DeleteReconciler.uploadPhotoId("not json".encodeToByteArray()))
        assertNotNull(DeleteReconciler.protectedReconcileIds(emptyList()))
    }
}
