package com.gradethread.app.marketplaces.promotions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1357: promotion + markdown rules.
 *
 * The bounds mirror the edge's own, so the number shown is the number applied —
 * a client that accepted 25% and let the server clamp it to 20 would misreport
 * what the listing is paying. The suggestion wording matters for the same
 * reason: only eBay's trending rate may be called eBay's.
 */
class PromotionsTest {

    // ── bounds ───────────────────────────────────────────────────────────────

    @Test
    fun `an ad rate clamps to what eBay accepts`() {
        assertEquals(2.0, Promotions.clampAdRate(0.5), 1e-9)
        assertEquals(20.0, Promotions.clampAdRate(45.0), 1e-9)
        assertEquals(8.5, Promotions.clampAdRate(8.5), 1e-9)
        assertEquals(2.0, Promotions.clampAdRate(Double.NaN), 1e-9)
    }

    @Test
    fun `a markdown clamps to its own, different range`() {
        // 5-70, not the ad rate's 2-20. Sharing one range would silently turn a
        // 60% clearance sale into a 20% one.
        assertEquals(5.0, Promotions.clampMarkdown(1.0), 1e-9)
        assertEquals(70.0, Promotions.clampMarkdown(90.0), 1e-9)
        assertEquals(60.0, Promotions.clampMarkdown(60.0), 1e-9)
    }

    @Test
    fun `rates parse the way people type them`() {
        assertEquals(8.0, Promotions.parseAdRate("8")!!, 1e-9)
        assertEquals(8.5, Promotions.parseAdRate("8.5%")!!, 1e-9)
        assertEquals(8.5, Promotions.parseAdRate("8,5")!!, 1e-9)
        assertNull(Promotions.parseAdRate(""))
        assertNull(Promotions.parseAdRate("lots"))
        assertNull(Promotions.parseAdRate("0"))
    }

    @Test
    fun `formatting drops a pointless decimal`() {
        assertEquals("8", Promotions.formatPct(8.0))
        assertEquals("8.5", Promotions.formatPct(8.5))
    }

    // ── what the panel claims ────────────────────────────────────────────────

    @Test
    fun `eBay's trending rate is named as eBay's`() {
        val state = PromotionState(
            suggestedRatePct = 9.0,
            suggestedRateBasis = "ebay_trending",
        )
        assertTrue(state.suggestionFromEbay)
        assertEquals("eBay's trending rate for this category is 9%.", state.suggestionLabel)
    }

    @Test
    fun `our own guess is not passed off as eBay's`() {
        val state = PromotionState(
            suggestedRatePct = 6.0,
            suggestedRateBasis = "category_heuristic",
        )
        assertFalse(state.suggestionFromEbay)
        assertEquals("We suggest about 6% for this category.", state.suggestionLabel)
    }

    @Test
    fun `inheriting an off-by-default setting is not promoted`() {
        // The tri-state override is the trap: null means "inherit", and with the
        // seller default off, this listing is NOT being advertised. Saying it was
        // would have them believe they were paying for placement.
        val inheriting = PromotionState(
            promoteOverride = null,
            effectivePromote = false,
            promoteByDefault = false,
        )
        assertTrue(Promotions.promotionSummary(inheriting).startsWith("Not promoted"))
    }

    @Test
    fun `an explicit per-listing off says so`() {
        val off = PromotionState(
            promoteOverride = false,
            effectivePromote = false,
            promoteByDefault = true,
        )
        assertEquals(
            "Not promoted — turned off for this listing.",
            Promotions.promotionSummary(off),
        )
    }

    @Test
    fun `an active promotion names its rate`() {
        val on = PromotionState(effectivePromote = true, ratePct = 7.5)
        assertEquals("Promoted at 7.5% ad rate.", Promotions.promotionSummary(on))
    }

    @Test
    fun `opting out outranks everything else`() {
        val out = PromotionState(optOut = true, effectivePromote = true, ratePct = 9.0)
        assertEquals("Not promoted — this listing is opted out.", Promotions.promotionSummary(out))
    }

    @Test
    fun `a running sale names its discount`() {
        val onSale = PromotionState(saleActive = true, salePct = 20.0)
        assertTrue(Promotions.saleSummary(onSale).contains("20% off"))
        assertTrue(Promotions.saleSummary(PromotionState()).startsWith("No sale running"))
    }
}
