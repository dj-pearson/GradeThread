package com.gradethread.app.marketplaces.pricing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1355: the bulk-pricing arithmetic.
 *
 * This is the whole feature. A mis-rounded reduction applied to two hundred
 * live listings is two hundred wrong prices on a marketplace, and there is no
 * undo — so every branch is pinned here rather than checked by eye in the UI.
 */
class BulkPricingTest {

    private fun listing(id: String, price: Double) =
        BulkListing(id = id, title = "Item $id", price = price, quantity = 1)

    // ── target price ─────────────────────────────────────────────────────────

    @Test
    fun `no change produces no target`() {
        assertNull(BulkPricing.target(40.0, BulkPricing.Mode.NONE, 10.0).price)
        // A mode with no value yet is the same: nothing to preview.
        assertNull(BulkPricing.target(40.0, BulkPricing.Mode.SET, null).price)
    }

    @Test
    fun `set mode gives every row the same price`() {
        assertEquals(29.99, BulkPricing.target(40.0, BulkPricing.Mode.SET, 29.99).price!!, 1e-9)
        assertEquals(29.99, BulkPricing.target(12.0, BulkPricing.Mode.SET, 29.99).price!!, 1e-9)
    }

    @Test
    fun `reduce mode takes a percentage off each row's own price`() {
        assertEquals(36.0, BulkPricing.target(40.0, BulkPricing.Mode.REDUCE, 10.0).price!!, 1e-9)
        assertEquals(10.8, BulkPricing.target(12.0, BulkPricing.Mode.REDUCE, 10.0).price!!, 1e-9)
    }

    @Test
    fun `a reduction rounds to whole cents`() {
        // 19.99 - 15% = 16.9915. eBay takes cents, so this must be one value,
        // not a float tail that renders differently than it publishes.
        assertEquals(16.99, BulkPricing.target(19.99, BulkPricing.Mode.REDUCE, 15.0).price!!, 1e-9)
    }

    @Test
    fun `a price under a cent is refused, not clamped`() {
        // A 95% cut on a cheap item legitimately reaches $0.01; deeper reaches
        // zero. Quietly clamping would push a price the seller never chose.
        val zeroed = BulkPricing.target(0.15, BulkPricing.Mode.REDUCE, 99.0)
        assertNull(zeroed.price)
        assertTrue(zeroed.error!!.contains("0 or less"))

        val valid = BulkPricing.target(0.15, BulkPricing.Mode.REDUCE, 90.0)
        assertEquals(0.02, valid.price!!, 1e-9)
    }

    // ── input parsing ────────────────────────────────────────────────────────

    @Test
    fun `a set price goes through the shared money parser`() {
        assertEquals(29.99, BulkPricing.inputValue("\$29.99", BulkPricing.Mode.SET)!!, 1e-9)
        assertNull(BulkPricing.inputValue("0", BulkPricing.Mode.SET))
        assertNull(BulkPricing.inputValue("", BulkPricing.Mode.SET))
    }

    @Test
    fun `a reduction must be between 1 and 99 percent`() {
        assertEquals(15.0, BulkPricing.inputValue("15", BulkPricing.Mode.REDUCE)!!, 1e-9)
        assertEquals(15.0, BulkPricing.inputValue("15%", BulkPricing.Mode.REDUCE)!!, 1e-9)
        // 100% is free and a negative is a raise nobody asked for.
        assertNull(BulkPricing.inputValue("100", BulkPricing.Mode.REDUCE))
        assertNull(BulkPricing.inputValue("-5", BulkPricing.Mode.REDUCE))
        assertNull(BulkPricing.inputValue("lots", BulkPricing.Mode.REDUCE))
    }

    // ── what gets sent ───────────────────────────────────────────────────────

    @Test
    fun `only selected rows are sent`() {
        val listings = listOf(listing("a", 40.0), listing("b", 50.0))
        val updates = BulkPricing.updates(listings, setOf("a"), BulkPricing.Mode.REDUCE, 10.0)
        assertEquals(listOf("a"), updates.map { it.listingId })
        assertEquals(36.0, updates.first().price!!, 1e-9)
    }

    @Test
    fun `a row whose target is invalid is dropped from the request`() {
        // It already shows its reason on screen. Sending it would risk the
        // server refusing the whole request and taking the good rows with it.
        val listings = listOf(listing("cheap", 0.10), listing("normal", 40.0))
        val updates = BulkPricing.updates(
            listings,
            setOf("cheap", "normal"),
            BulkPricing.Mode.REDUCE,
            99.0,
        )
        assertEquals(listOf("normal"), updates.map { it.listingId })
    }

    @Test
    fun `quantity is never sent by the price editor`() {
        // The endpoint accepts it, and an accidental 0 would pull listings out
        // of stock — a far bigger action than a price change.
        val updates = BulkPricing.updates(
            listOf(listing("a", 40.0)),
            setOf("a"),
            BulkPricing.Mode.SET,
            20.0,
        )
        assertNull(updates.single().quantity)
    }

    @Test
    fun `the request is capped at what the server accepts`() {
        val many = (1..600).map { listing("l$it", 20.0) }
        val updates = BulkPricing.updates(
            many,
            many.map { it.id }.toSet(),
            BulkPricing.Mode.SET,
            9.99,
        )
        assertEquals(BulkPricing.MAX_UPDATES, updates.size)
    }

    // ── results ──────────────────────────────────────────────────────────────

    @Test
    fun `failures land on their own rows`() {
        val errors = BulkPricing.rowErrors(
            listOf(
                BulkPriceResult(listingId = "a", ok = true),
                BulkPriceResult(listingId = "b", ok = false, error = "Offer not found"),
                BulkPriceResult(listingId = "c", ok = false, error = null),
            ),
        )
        assertEquals(setOf("b", "c"), errors.keys)
        assertEquals("Offer not found", errors["b"])
        assertTrue(errors["c"]!!.isNotBlank())
    }

    @Test
    fun `a partial batch is named as partial`() {
        assertEquals(
            "Updated 20 listings on eBay.",
            BulkPricing.summary(BulkPriceResponse(succeeded = 20, total = 20)),
        )
        assertTrue(
            BulkPricing.summary(BulkPriceResponse(succeeded = 18, total = 20))
                .startsWith("Updated 18 of 20."),
        )
        assertEquals(
            "None of the 20 updates went through.",
            BulkPricing.summary(BulkPriceResponse(succeeded = 0, total = 20)),
        )
    }
}
