package com.gradethread.app.marketplaces.publish

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1352: the composer's profit estimate and the price it is computed from.
 *
 * The estimate is what a seller prices against, so it mirrors the web
 * `estimateListingProfit` exactly — a drift here means the phone and the
 * dashboard quote different margins for the same listing.
 */
class ListingProfitTest {

    @Test
    fun `fees are the fvf fraction plus the fixed per-order fee`() {
        val profit = ListingProfit.estimate(price = 100.0)
        assertEquals(13.25 + 0.40, profit.fees, 1e-9)
        assertEquals(0.0, profit.costs, 1e-9)
        assertEquals(86.35, profit.net, 1e-9)
        assertEquals(86.35, profit.marginPct, 1e-9)
    }

    @Test
    fun `costs come off the net and out of the margin`() {
        val profit = ListingProfit.estimate(
            price = 100.0,
            costBasis = 20.0,
            gradingCost = 5.0,
            shippingCost = 8.0,
        )
        assertEquals(33.0, profit.costs, 1e-9)
        assertEquals(53.35, profit.net, 1e-9)
    }

    @Test
    fun `a zero price charges no fees`() {
        // Not "the fixed fee against an empty box" — no price means no sale.
        val profit = ListingProfit.estimate(price = 0.0, costBasis = 20.0)
        assertEquals(0.0, profit.fees, 1e-9)
        assertEquals(-20.0, profit.net, 1e-9)
        assertEquals(0.0, profit.marginPct, 1e-9)
    }

    @Test
    fun `a loss is reported as a loss`() {
        // Underwater listings are the ones worth showing honestly.
        val profit = ListingProfit.estimate(price = 20.0, costBasis = 30.0)
        assertTrue("net was ${profit.net}", profit.net < 0)
        assertTrue(profit.marginPct < 0)
    }

    @Test
    fun `negative and missing costs are clamped, not trusted`() {
        val clamped = ListingProfit.estimate(price = 50.0, costBasis = -10.0)
        val absent = ListingProfit.estimate(price = 50.0)
        assertEquals(absent.net, clamped.net, 1e-9)
    }

    @Test
    fun `the displayed net and margin agree with each other`() {
        // The composer shows netCents; the margin must be derived from the SAME
        // rounded number or the two lines contradict each other on screen.
        val profit = ListingProfit.estimate(price = 33.33, costBasis = 7.77)
        val expected = profit.netCents / 33.33 * 100
        assertEquals(expected, profit.marginPctCents(33.33), 1e-9)
    }

    // ── price parsing ────────────────────────────────────────────────────────

    @Test
    fun `a blank or zero price is refused, never coerced to zero`() {
        // The US-789 incident: a garbled price became a $0 draft that could be
        // published at $0.
        assertNull(ListingDraftService.validatedPrice(""))
        assertNull(ListingDraftService.validatedPrice("   "))
        assertNull(ListingDraftService.validatedPrice("0"))
        assertNull(ListingDraftService.validatedPrice("abc"))
        assertNull(ListingDraftService.validatedPrice("-12"))
    }

    @Test
    fun `a typed price parses through the shared money parser`() {
        assertEquals(48.5, ListingDraftService.validatedPrice("48.50")!!, 1e-9)
        assertEquals(48.5, ListingDraftService.validatedPrice("$48.50")!!, 1e-9)
        assertEquals(1234.0, ListingDraftService.validatedPrice("1,234")!!, 1e-9)
    }
}
