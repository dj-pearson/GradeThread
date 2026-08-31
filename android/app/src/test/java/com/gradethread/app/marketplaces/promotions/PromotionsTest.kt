package com.gradethread.app.marketplaces.promotions

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

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
        assertEquals(
            R.string.promotion_summary_never,
            Promotions.promotionSummary(inheriting).res,
        )
    }

    @Test
    fun `an explicit per-listing off says so`() {
        val off = PromotionState(
            promoteOverride = false,
            effectivePromote = false,
            promoteByDefault = true,
        )
        assertEquals(
            R.string.promotion_summary_off_for_listing,
            Promotions.promotionSummary(off).res,
        )
    }

    @Test
    fun `an active promotion names its rate`() {
        val on = PromotionState(effectivePromote = true, ratePct = 7.5)
        val promoted = Promotions.promotionSummary(on)
        assertEquals(R.string.promotion_summary_at_rate, promoted.res)
        // The rate is pre-formatted by formatPct, not handed over as a Double:
        // "7.5", never "7,5" and never "7.50".
        assertEquals("7.5", promoted.args[0])
    }

    @Test
    fun `opting out outranks everything else`() {
        val out = PromotionState(optOut = true, effectivePromote = true, ratePct = 9.0)
        assertEquals(R.string.promotion_summary_opted_out, Promotions.promotionSummary(out).res)
    }

    @Test
    fun `a running sale names its discount`() {
        val onSale = PromotionState(saleActive = true, salePct = 20.0)
        val sale = Promotions.saleSummary(onSale)
        assertEquals(R.string.promotion_sale_at_pct, sale.res)
        assertEquals("20", sale.args[0])
        assertEquals(R.string.promotion_sale_none, Promotions.saleSummary(PromotionState()).res)
    }

    /**
     * US-2976: the honesty guard, now that the sentences live in XML.
     *
     * Asserting a resource id proves which branch ran and nothing about what
     * the seller reads - a translator could have written "Promocionado" into
     * promotion_summary_never and every test above would stay green while the
     * app told sellers they were paying for placement they never bought. So
     * read the XML, in both locales.
     */
    @Test
    fun `every not-promoted sentence reads as not promoted, in both locales`() {
        val notPromoted = listOf(
            "promotion_summary_opted_out",
            "promotion_summary_off_for_listing",
            "promotion_summary_not_yet",
            "promotion_summary_never",
        )
        // The test working directory is app/, not android/.
        for ((dir, opener) in listOf("values" to "Not promoted", "values-es" to "Sin promocionar")) {
            val xml = File("src/main/res/$dir/strings.xml").readText()
            for (name in notPromoted) {
                val line = xml.lines().firstOrNull { it.contains("\"$name\"") }
                assertNotNull("$dir is missing $name", line)
                val body = line!!.substringAfter(">").substringBefore("</string>")
                assertTrue(
                    "$dir/$name does not read as not promoted: $body",
                    body.startsWith(opener),
                )
            }
        }
    }
}
