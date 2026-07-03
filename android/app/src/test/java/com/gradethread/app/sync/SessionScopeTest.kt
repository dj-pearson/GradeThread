package com.gradethread.app.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1323: the sign-out ordering contract, the workspace-switch queue rule,
 * epoch invalidation, and the no-cross-tenant-leakage sweep.
 */
@RunWith(RobolectricTestRunner::class)
class SessionScopeTest {

    private lateinit var db: GradeThreadDb
    private lateinit var watermark: SyncWatermark

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()
        watermark = SyncWatermark(context)
    }

    @After
    fun tearDown() {
        db.close()
    }

    private suspend fun seedTenantData() {
        db.items().upsert(
            listOf(
                InventoryItemEntity(
                    id = "i1", userId = "old-user", title = "Prev tenant item", brand = null,
                    sku = null, size = null, color = null, material = null, status = "sourced",
                    itemCategory = null, garmentType = null, garmentCategory = null,
                    itemDescription = null, style = null, sourcedBy = null, acquiredDate = null,
                    container = null, compSetJson = null, sourceId = null, locationBin = null,
                    consignorId = null, consignmentSplitPct = null, acquiredPrice = null,
                    targetPrice = null, listingPrice = null, gradeValue = null, gradeLabel = null,
                    certificateUrl = null, gradeReportId = null, disputeStatus = null,
                    conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
                    createdAt = 1, updatedAt = 1,
                ),
            ),
        )
        db.sales().upsert(
            listOf(
                SaleEntity(
                    id = "s1", inventoryItemId = "i1", listingId = null, salePrice = 100.0,
                    platformFees = 10.0, paymentProcessingFees = null, shippingCollected = null,
                    shippingCost = null, gradingCost = null, otherCosts = null, tax = null,
                    netProfit = 90.0, buyerUsername = null, platformOrderId = null,
                    payoutReference = null, saleDate = 1, soldAt = null, shippedAt = null,
                    trackingNumber = null, createdAt = 1,
                ),
            ),
        )
        db.expenses().upsert(
            listOf(
                ExpenseEntity(
                    id = "e1", category = "shipping", expenseDescription = null, amount = 5.0,
                    spentOn = 1, inventoryItemId = null, listingId = null, createdAt = 1,
                ),
            ),
        )
        db.listings().upsert(
            listOf(
                ListingEntity(
                    id = "l1", inventoryItemId = "i1", platform = "ebay",
                    platformListingId = null, platformOfferId = null, externalUrl = null,
                    listingPrice = 50.0, listingStatus = "active", listedAt = null,
                    endedAt = null, viewsTotal = null, watchersCount = null,
                    listingOrigin = null, publishError = null, createdAt = 1, updatedAt = 1,
                ),
            ),
        )
        db.sources().upsert(
            listOf(
                SourceEntity(
                    id = "src1", userId = "old-user", name = "Goodwill", sourceType = "thrift",
                    notes = null, archivedAt = null, createdAt = 1, updatedAt = 1,
                ),
            ),
        )
        OfflineMutationQueue(db).enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "i1", ByteArray(0))
    }

    // ── Sign-out ──

    @Test
    fun signOut_resetsWatermarksBeforeWipingRows() = runTest {
        val order = mutableListOf<String>()
        val scope = SessionScope(
            db, watermark,
            resetWatermarks = { order += "watermarks" },
            wipeRows = { order += "rows" },
        )
        scope.signOutWipe(
            SessionScope.Hooks(
                stopSync = { order += "stopSync" },
                stopRealtime = { order += "stopRealtime" },
                cancelUploads = { order += "cancelUploads" },
                clearances = listOf({ order += "clearances" }),
            ),
        )
        // The crash-safety contract: writers stopped first, watermarks
        // strictly before rows, clearances last.
        assertEquals(
            listOf("stopSync", "stopRealtime", "cancelUploads", "watermarks", "rows", "clearances"),
            order,
        )
    }

    @Test
    fun signOut_leavesNothingForTheNextAccount() = runTest {
        seedTenantData()
        watermark.advance(SyncWatermark.Table.ITEMS, "2026-07-03T00:00:00Z")

        SessionScope(db, watermark).signOutWipe()

        // No surface may show the previous tenant (list/Money/dashboard AC3).
        assertTrue(db.items().allWithPhotos().isEmpty())
        assertTrue(db.sales().all().isEmpty())
        assertTrue(db.expenses().all().isEmpty())
        assertTrue(db.listings().forItem("i1").isEmpty())
        assertTrue(db.sources().all().isEmpty())
        // The queue too — the next account must not FLUSH the old edits.
        assertEquals(0, db.pendingMutations().allInOrder().size)
        // And the next delta starts from scratch (full backfill).
        assertEquals(null, watermark.cursor(SyncWatermark.Table.ITEMS))
    }

    // ── Workspace switch ──

    @Test
    fun workspaceSwitch_flushesFirst_keepsTheQueue_wipesTenantRows() = runTest {
        seedTenantData()
        val order = mutableListOf<String>()

        SessionScope(db, watermark).switchWorkspace(
            "new-owner",
            SessionScope.Hooks(
                flushPending = { order += "flush" },
                rehomeRealtime = { order += "rehome:$it" },
                pullForOwner = { order += "pull:$it" },
            ),
        )

        assertEquals(listOf("flush", "rehome:new-owner", "pull:new-owner"), order)
        // Tenant rows gone…
        assertTrue(db.items().allWithPhotos().isEmpty())
        assertTrue(db.sales().all().isEmpty())
        // …but the queue survives (same signed-in user).
        assertEquals(1, db.pendingMutations().allInOrder().size)
    }

    // ── Scope epoch (US-1493) ──

    @Test
    fun epoch_invalidatesInFlightPulls() {
        val epoch = SessionScope.ScopeEpoch()
        val token = epoch.current()
        assertTrue(epoch.isCurrent(token))

        epoch.invalidate()
        // The pull that started before the boundary must discard its merge.
        assertFalse(epoch.isCurrent(token))
        assertTrue(epoch.isCurrent(epoch.current()))
    }
}
