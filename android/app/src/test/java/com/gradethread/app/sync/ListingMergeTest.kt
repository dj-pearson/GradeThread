package com.gradethread.app.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ListingEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1351: the listing merge rules (iOS SyncMergeActor.mergeListings).
 *
 * The stakes: price, status and quantity are eBay-owned EDITABLE fields. Get
 * the provenance branch wrong and a pull either undoes a seller's just-made
 * price change or lets a stale local value survive over what eBay actually has
 * live — and the next push writes the wrong number back to the marketplace.
 */
@RunWith(RobolectricTestRunner::class)
class ListingMergeTest {

    private lateinit var db: GradeThreadDb
    private lateinit var merger: SyncMerger

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            GradeThreadDb::class.java,
        ).allowMainThreadQueries().build()
        merger = SyncMerger(db)
    }

    @After
    fun tearDown() = db.close()

    private fun listing(
        price: Double = 40.0,
        status: String = "active",
        quantity: Int? = 1,
        origin: String? = null,
        dirty: Boolean = false,
        offerId: String? = null,
        publishError: String? = null,
        updatedAt: Long = 1_000L,
    ) = ListingEntity(
        id = "l1",
        inventoryItemId = "i1",
        platform = "ebay",
        platformListingId = "1234",
        platformOfferId = offerId,
        externalUrl = "https://www.ebay.com/itm/1234",
        listingPrice = price,
        listingStatus = status,
        listedAt = 500L,
        endedAt = null,
        viewsTotal = null,
        watchersCount = null,
        quantity = quantity,
        listingOrigin = origin,
        publishError = publishError,
        hasLocalChanges = dirty,
        createdAt = 100L,
        updatedAt = updatedAt,
    )

    @Test
    fun `an unseen listing is taken as-is`() {
        val server = listing(price = 55.0)
        assertEquals(server, merger.mergeListing(local = null, server = server))
    }

    @Test
    fun `a clean local row takes the server price status and quantity`() {
        val merged = merger.mergeListing(
            local = listing(price = 40.0, status = "active", quantity = 1),
            server = listing(price = 35.0, status = "ended", quantity = 0, updatedAt = 2_000L),
        )
        assertEquals(35.0, merged.listingPrice, 0.001)
        assertEquals("ended", merged.listingStatus)
        assertEquals(0, merged.quantity)
    }

    @Test
    fun `a dirty gradethread listing keeps its pending local edits`() {
        val merged = merger.mergeListing(
            local = listing(price = 44.0, quantity = 0, origin = "gradethread", dirty = true),
            server = listing(price = 40.0, quantity = 1, origin = "gradethread"),
        )
        assertEquals(44.0, merged.listingPrice, 0.001)
        assertEquals(0, merged.quantity)
    }

    @Test
    fun `an ebay-originated listing always takes the server value`() {
        // eBay is the source of truth for what it has live — a local edit to an
        // imported listing is not authoritative even while dirty.
        val merged = merger.mergeListing(
            local = listing(price = 44.0, quantity = 0, origin = "ebay", dirty = true),
            server = listing(price = 40.0, quantity = 3, origin = "ebay"),
        )
        assertEquals(40.0, merged.listingPrice, 0.001)
        assertEquals(3, merged.quantity)
    }

    @Test
    fun `a delta omitting the origin falls back to the cached marker`() {
        val merged = merger.mergeListing(
            local = listing(price = 44.0, origin = "ebay", dirty = true),
            server = listing(price = 40.0, origin = null),
        )
        assertEquals("server wins on the cached ebay origin", 40.0, merged.listingPrice, 0.001)
        assertEquals("ebay", merged.listingOrigin)
    }

    @Test
    fun `a legacy row with no origin anywhere is treated as gradethread`() {
        val merged = merger.mergeListing(
            local = listing(price = 44.0, origin = null, dirty = true),
            server = listing(price = 40.0, origin = null),
        )
        assertEquals(44.0, merged.listingPrice, 0.001)
        assertNull(merged.listingOrigin)
    }

    @Test
    fun `a server null quantity keeps what was already known`() {
        // Null means "no sync has reported one", not "set it to nothing".
        val merged = merger.mergeListing(
            local = listing(quantity = 4),
            server = listing(quantity = null),
        )
        assertEquals(4, merged.quantity)
    }

    @Test
    fun `platform identity fields always refresh from the server`() {
        val merged = merger.mergeListing(
            local = listing(offerId = null, dirty = true),
            server = listing(offerId = "offer-9", origin = "gradethread"),
        )
        assertEquals("offer-9", merged.platformOfferId)
        assertEquals("1234", merged.platformListingId)
    }

    @Test
    fun `publish error is server-owned and clears on success`() {
        val merged = merger.mergeListing(
            local = listing(publishError = "title too long", dirty = true),
            server = listing(publishError = null),
        )
        assertNull(merged.publishError)
    }

    @Test
    fun `applying a pulled batch merges instead of overwriting`() = runTest {
        // The regression this guards: listings used to be blind-upserted, so a
        // pull landing on a pending local price edit silently reverted it.
        db.listings().upsert(listOf(listing(price = 44.0, origin = "gradethread", dirty = true)))

        merger.apply(
            SyncMerger.PulledBatch(
                listings = listOf(
                    listing(
                        price = 40.0,
                        status = "ended",
                        origin = "gradethread",
                        offerId = "offer-9",
                    ),
                ),
            ),
        )

        val stored = db.listings().forItem("i1").single()
        assertEquals(44.0, stored.listingPrice, 0.001)
        // Status rides the same provenance rule as price, so a dirty
        // GradeThread-owned row keeps its local one too.
        assertEquals("active", stored.listingStatus)
        assertEquals("offer-9", stored.platformOfferId) // identity still refreshes
        assertEquals(true, stored.hasLocalChanges)
    }

    @Test
    fun `the pull never clears the local dirty flag`() {
        // Only a successful mutation replay clears it. Clearing it here would
        // drop a queued edit on the floor.
        val merged = merger.mergeListing(
            local = listing(dirty = true),
            server = listing(dirty = false),
        )
        assertEquals(true, merged.hasLocalChanges)
    }
}
