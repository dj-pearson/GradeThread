package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1349: matching across four tables, and the two rules that decide what a
 * result is allowed to claim.
 */
class GlobalSearchTest {

    private fun item(
        id: String,
        title: String = "Better Sweater",
        brand: String? = "Patagonia",
        sku: String? = null,
    ) = InventoryItemEntity(
        id = id,
        userId = "u1",
        title = title,
        brand = brand,
        sku = sku,
        size = null,
        color = null,
        material = null,
        status = "cataloged",
        itemCategory = null,
        garmentType = null,
        garmentCategory = null,
        itemDescription = null,
        style = null,
        sourcedBy = null,
        acquiredDate = null,
        container = null,
        compSetJson = null,
        sourceId = null,
        locationBin = null,
        consignorId = null,
        consignmentSplitPct = null,
        acquiredPrice = null,
        targetPrice = null,
        listingPrice = null,
        gradeValue = null,
        gradeLabel = null,
        certificateUrl = null,
        gradeReportId = null,
        disputeStatus = null,
        conditionNotes = null,
        measurementsJson = null,
        primaryPhotoUrl = null,
        createdAt = 0,
        updatedAt = 0,
    )

    private fun listing(id: String, itemId: String, platform: String = "ebay") = ListingEntity(
        id = id,
        inventoryItemId = itemId,
        platform = platform,
        platformListingId = null,
        platformOfferId = null,
        externalUrl = null,
        listingPrice = 45.0,
        listingStatus = "active",
        listedAt = null,
        endedAt = null,
        viewsTotal = null,
        watchersCount = null,
        listingOrigin = null,
        publishError = null,
        createdAt = 0,
        updatedAt = 0,
    )

    private fun sale(id: String, itemId: String, buyer: String?) = SaleEntity(
        id = id,
        inventoryItemId = itemId,
        listingId = null,
        salePrice = 60.0,
        platformFees = 6.0,
        paymentProcessingFees = null,
        shippingCollected = null,
        shippingCost = null,
        gradingCost = null,
        otherCosts = null,
        tax = null,
        netProfit = null,
        buyerUsername = buyer,
        platformOrderId = null,
        payoutReference = null,
        saleDate = 0,
        soldAt = null,
        shippedAt = null,
        trackingNumber = null,
        createdAt = 0,
    )

    private fun source(id: String, name: String, type: String = "thrift") = SourceEntity(
        id = id,
        userId = "u1",
        name = name,
        sourceType = type,
        notes = null,
        archivedAt = null,
        createdAt = 0,
        updatedAt = 0,
    )

    // ── the minimum ──────────────────────────────────────────────────────

    @Test
    fun `a one-character query matches nothing at all`() {
        // It would match most of the inventory and help nobody.
        val results = GlobalSearch.compute("p", listOf(item("a")), emptyList(), emptyList(), emptyList())
        assertTrue(results.isEmpty)
    }

    @Test
    fun `matching is case-insensitive across the item's fields`() {
        val items = listOf(item("a", title = "Better Sweater", brand = "Patagonia", sku = "PT-9"))
        assertEquals(1, GlobalSearch.compute("PATAG", items, emptyList(), emptyList(), emptyList()).items.size)
        assertEquals(1, GlobalSearch.compute("sweater", items, emptyList(), emptyList(), emptyList()).items.size)
        assertEquals(1, GlobalSearch.compute("pt-9", items, emptyList(), emptyList(), emptyList()).items.size)
    }

    // ── the parent-item rule (US-1187) ───────────────────────────────────

    @Test
    fun `a listing whose item is not cached is not shown`() {
        // It would render a row with no title and no working tap target.
        val results = GlobalSearch.compute(
            query = "ebay",
            items = emptyList(),
            listings = listOf(listing("l1", "missing-item")),
            sales = emptyList(),
            sources = emptyList(),
        )
        assertTrue(results.listings.isEmpty())
    }

    @Test
    fun `a sale whose item IS cached is shown with it`() {
        val results = GlobalSearch.compute(
            query = "buyer99",
            items = listOf(item("a")),
            listings = emptyList(),
            sales = listOf(sale("s1", "a", "buyer99")),
            sources = emptyList(),
        )
        assertEquals(1, results.sales.size)
        assertEquals("Better Sweater", results.sales.first().item.title)
    }

    @Test
    fun `a listing matches on its item's title as well as its own fields`() {
        val results = GlobalSearch.compute(
            query = "sweater",
            items = listOf(item("a")),
            listings = listOf(listing("l1", "a")),
            sales = emptyList(),
            sources = emptyList(),
        )
        assertEquals(1, results.listings.size)
    }

    // ── the server hit is additive ───────────────────────────────────────

    @Test
    fun `a server hit widens the local result`() {
        // The server's full-text search can match a fuzzy term the local
        // substring pass misses.
        val items = listOf(item("a", title = "Fleece"), item("b", title = "Jacket"))
        val results = GlobalSearch.compute(
            query = "zzzz",
            items = items,
            listings = emptyList(),
            sales = emptyList(),
            sources = emptyList(),
            serverItemIds = setOf("b"),
        )
        assertEquals(listOf("b"), results.items.map { it.id })
    }

    @Test
    fun `no server opinion never narrows the local result`() {
        // null means "the search didn't run", NOT "no matches" — conflating
        // them would let a failed RPC empty a search local matching answered.
        val items = listOf(item("a", title = "Fleece"))
        val withNull = GlobalSearch.compute("fleece", items, emptyList(), emptyList(), emptyList(), null)
        val withEmpty = GlobalSearch.compute("fleece", items, emptyList(), emptyList(), emptyList(), emptySet())
        assertEquals(1, withNull.items.size)
        assertEquals(1, withEmpty.items.size)
    }

    // ── sources and caps ─────────────────────────────────────────────────

    @Test
    fun `sources match on name and type`() {
        val sources = listOf(source("s1", "Goodwill Bins"), source("s2", "Estate sale", "estate"))
        assertEquals(1, GlobalSearch.compute("goodwill", emptyList(), emptyList(), emptyList(), sources).sources.size)
        assertEquals(1, GlobalSearch.compute("estate", emptyList(), emptyList(), emptyList(), sources).sources.size)
    }

    @Test
    fun `each section is capped`() {
        val many = (1..50).map { item("i$it", title = "Fleece $it") }
        val results = GlobalSearch.compute("fleece", many, emptyList(), emptyList(), emptyList())
        assertEquals(GlobalSearch.SECTION_LIMIT, results.items.size)
        assertEquals(GlobalSearch.SECTION_LIMIT, results.total)
    }

    @Test
    fun `an empty result set reports itself as empty`() {
        val results = GlobalSearch.compute("nothing-matches", listOf(item("a")), emptyList(), emptyList(), emptyList())
        assertTrue(results.isEmpty)
        assertEquals(0, results.total)
    }

    // ── routing ──────────────────────────────────────────────────────────

    @Test
    fun `listing and sale hits route to their item, not a ledger row`() {
        // A seller who searched a buyer's username wants the garment they
        // bought, not a row they can't act on.
        assertEquals("item/a", GlobalSearch.routeFor(GlobalSearch.Kind.ITEM, "a"))
        assertEquals("item/a", GlobalSearch.routeFor(GlobalSearch.Kind.LISTING, "a"))
        assertEquals("item/a", GlobalSearch.routeFor(GlobalSearch.Kind.SALE, "a"))
    }

    @Test
    fun `a source routes somewhere that exists`() {
        // There is no source detail screen yet; the inventory list is the
        // closest honest destination.
        assertEquals("inventory", GlobalSearch.routeFor(GlobalSearch.Kind.SOURCE, "s1"))
        assertFalse(GlobalSearch.routeFor(GlobalSearch.Kind.SOURCE, "s1").contains("source/"))
    }
}
