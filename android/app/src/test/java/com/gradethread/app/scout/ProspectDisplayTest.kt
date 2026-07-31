package com.gradethread.app.scout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import com.gradethread.app.money.Money
import org.junit.Test

/**
 * US-1374: the wording someone reads while stood in a shop with the item in
 * their hand. Overstating any of it costs them money.
 */
class ProspectDisplayTest {

    private fun stats(
        count: Int = 12,
        low: Int? = 3000,
        median: Int? = 5000,
        high: Int? = 8000,
        sufficient: Boolean = true,
    ) = ProspectStats(
        count = count,
        lowCents = low,
        medianCents = median,
        highCents = high,
        sufficient = sufficient,
    )

    private fun response(
        identified: Boolean = true,
        stats: ProspectStats? = stats(),
        decision: ProspectDecision? = null,
    ) = ProspectResponse(
        identified = identified,
        item = ProspectItem(brand = "Patagonia", title = "Patagonia fleece"),
        stats = stats,
        decision = decision,
    )

    // ── The verdict ──────────────────────────────────────────────────────────

    @Test
    fun `no cost means no verdict, and it says so`() {
        // "Maybe" here would dress a missing input up as a judgement.
        assertEquals(
            "Enter what it costs for a verdict",
            ProspectDisplay.verdictLabel(null),
        )
    }

    @Test
    fun `each recommendation gets plain wording`() {
        assertEquals("Buy it", ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "buy")))
        assertEquals(
            "Walk away",
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "skip")),
        )
        assertEquals(
            "Could go either way",
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "maybe")),
        )
    }

    @Test
    fun `an unknown recommendation does not become a buy signal`() {
        assertEquals(
            "Enter what it costs for a verdict",
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "something_new")),
        )
    }

    // ── Caveats ──────────────────────────────────────────────────────────────

    @Test
    fun `no comps at all is said outright`() {
        val caveat = ProspectDisplay.caveat(
            response(stats = stats(count = 0, median = null, sufficient = false)),
        )!!
        assertTrue(caveat.contains("No comparable sales"))
    }

    @Test
    fun `too few comps names how few`() {
        val caveat = ProspectDisplay.caveat(response(stats = stats(count = 2, sufficient = false)))!!
        assertTrue(caveat.contains("2 comparable sales"))
        assertTrue(caveat.contains("rough guide"))
    }

    @Test
    fun `one comp reads as singular`() {
        val caveat = ProspectDisplay.caveat(response(stats = stats(count = 1, sufficient = false)))!!
        assertTrue(caveat.contains("1 comparable sale."))
    }

    @Test
    fun `thin confidence is a separate caveat from thin comps`() {
        // Not the same thing: few comps means the PRICE is a guess; low
        // confidence means the verdict built on it is.
        val caveat = ProspectDisplay.caveat(
            response(decision = ProspectDecision(recommendation = "buy", confident = false)),
        )!!
        assertTrue(caveat.contains("thin"))
    }

    @Test
    fun `a solid result carries no caveat`() {
        assertNull(
            ProspectDisplay.caveat(
                response(decision = ProspectDecision(recommendation = "buy", confident = true)),
            ),
        )
    }

    // ── Numbers ──────────────────────────────────────────────────────────────

    @Test
    fun `the price range shows the spread when there is one`() {
        // Built through Money.format, not hardcoded: the symbol and separators
        // follow the device locale, so a literal would fail on a non-US runner.
        assertEquals(
            "${Money.format(50.0)} (usually ${Money.format(30.0)} to ${Money.format(80.0)})",
            ProspectDisplay.priceRange(stats()),
        )
        assertEquals(
            Money.format(50.0),
            ProspectDisplay.priceRange(stats(low = null, high = null)),
        )
        assertEquals("No price data", ProspectDisplay.priceRange(stats(median = null)))
        assertEquals("No price data", ProspectDisplay.priceRange(null))
    }

    @Test
    fun `margin reads with its return percentage`() {
        assertEquals(
            "About ${Money.format(32.0)} profit · 160% return",
            ProspectDisplay.marginLabel(
                ProspectDecision(recommendation = "buy", estMarginCents = 3200, roiPct = 160.0),
            ),
        )
        assertEquals(
            "About ${Money.format(32.0)} profit",
            ProspectDisplay.marginLabel(
                ProspectDecision(recommendation = "buy", estMarginCents = 3200),
            ),
        )
        assertNull(ProspectDisplay.marginLabel(null))
        assertNull(ProspectDisplay.marginLabel(ProspectDecision(recommendation = "buy")))
    }

    @Test
    fun `an unknown sell-through says nothing rather than guessing`() {
        assertNull(ProspectDisplay.sellThroughLabel(null))
        assertNull(ProspectDisplay.sellThroughLabel(ProspectSellThrough(label = "unknown")))
        assertEquals(
            "Sells fast · around 3 to 10 days",
            ProspectDisplay.sellThroughLabel(
                ProspectSellThrough(label = "fast", daysLow = 3, daysHigh = 10),
            ),
        )
    }

    // ── Committing it ────────────────────────────────────────────────────────

    @Test
    fun `an unidentified item cannot be added to inventory`() {
        // There is nothing to add: no title, no brand, no price to aim at.
        assertFalse(ProspectDisplay.canBuy(response(identified = false)))
        assertFalse(ProspectDisplay.canBuy(null))
        assertTrue(ProspectDisplay.canBuy(response()))
    }

    @Test
    fun `the title falls back rather than landing blank in inventory`() {
        assertEquals(
            "Patagonia fleece",
            ProspectDisplay.buyTitle(ProspectItem(brand = "Patagonia", title = "Patagonia fleece")),
        )
        assertEquals(
            "Patagonia",
            ProspectDisplay.buyTitle(ProspectItem(brand = "Patagonia", title = "  ")),
        )
        // A blank title would land in the list as a row nobody can find again.
        assertEquals("Prospected item", ProspectDisplay.buyTitle(ProspectItem()))
    }
}
