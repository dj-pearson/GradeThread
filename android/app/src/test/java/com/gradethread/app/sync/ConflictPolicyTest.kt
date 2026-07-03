package com.gradethread.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** US-1318: the four merge strategies + the US-1244 price selection. */
class ConflictPolicyTest {

    @Test
    fun serverOwned_alwaysTakesServer() {
        assertEquals("server", ConflictPolicy.resolveServerOwned("local", "server"))
    }

    @Test
    fun userOwned_localWinsOnlyWhileDirty() {
        assertEquals("local", ConflictPolicy.resolveUserOwned("local", "server", hasLocalChanges = true))
        assertEquals("server", ConflictPolicy.resolveUserOwned("local", "server", hasLocalChanges = false))
    }

    @Test
    fun timestamp_newestWins_serverOnTies() {
        assertEquals("server", ConflictPolicy.resolveByTimestamp("local", "server", 100, 200))
        assertEquals("local", ConflictPolicy.resolveByTimestamp("local", "server", 200, 100))
        // Tie → server (it already round-tripped).
        assertEquals("server", ConflictPolicy.resolveByTimestamp("local", "server", 100, 100))
    }

    @Test
    fun ebayOrigin_serverAlwaysWins_othersFallBackToUserOwned() {
        // eBay-originated: even a dirty local edit loses.
        assertEquals(
            "server",
            ConflictPolicy.resolveEbayOwnedListingField(
                "local", "server", hasLocalChanges = true, listingOrigin = "ebay",
            ),
        )
        // GradeThread-originated: the user-owned rule applies.
        assertEquals(
            "local",
            ConflictPolicy.resolveEbayOwnedListingField(
                "local", "server", hasLocalChanges = true, listingOrigin = "gradethread",
            ),
        )
        // Unknown origin behaves like gradethread (never silently eBay).
        assertEquals(
            "local",
            ConflictPolicy.resolveEbayOwnedListingField(
                "local", "server", hasLocalChanges = true, listingOrigin = null,
            ),
        )
        assertEquals(
            "server",
            ConflictPolicy.resolveEbayOwnedListingField(
                "local", "server", hasLocalChanges = false, listingOrigin = null,
            ),
        )
    }

    // ── US-1244: market-price selection ──

    private fun row(item: String, price: Double, at: Long, live: Boolean) =
        ConflictPolicy.ListingPriceRow(item, price, at, live)

    @Test
    fun liveListing_beatsNonLive_regardlessOfTimestamp() {
        val prices = ConflictPolicy.selectListingPrices(
            listOf(
                row("i1", price = 99.0, at = 2_000, live = false), // newer but ended
                row("i1", price = 45.0, at = 1_000, live = true), // older but LIVE
            ),
        )
        assertEquals(45.0, prices["i1"]!!, 0.0)
    }

    @Test
    fun withinTheSameLivenessClass_newerWins() {
        val prices = ConflictPolicy.selectListingPrices(
            listOf(
                row("i1", price = 10.0, at = 1_000, live = true),
                row("i1", price = 20.0, at = 2_000, live = true),
                row("i2", price = 30.0, at = 2_000, live = false),
                row("i2", price = 40.0, at = 1_000, live = false),
            ),
        )
        assertEquals(20.0, prices["i1"]!!, 0.0)
        assertEquals(30.0, prices["i2"]!!, 0.0)
    }

    @Test
    fun aLiveArrivingAfterANonLive_replacesIt() {
        val prices = ConflictPolicy.selectListingPrices(
            listOf(
                row("i1", price = 99.0, at = 9_000, live = false),
                row("i1", price = 55.0, at = 100, live = true),
            ),
        )
        assertEquals(55.0, prices["i1"]!!, 0.0)
        assertNull(prices["i-none"])
    }

    @Test
    fun liveStatuses_matchTheIosSet() {
        assertEquals(setOf("active", "relisted"), ConflictPolicy.liveListingStatuses)
    }
}
