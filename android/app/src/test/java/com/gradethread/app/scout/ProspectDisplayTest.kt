package com.gradethread.app.scout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import com.gradethread.app.R
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

    // US-2976: these assert the resource ID, not the sentence. Which of the
    // four verdicts comes back is the whole risk here, and the id says that
    // exactly as well as the English did.

    @Test
    fun `no cost means no verdict, and it says so`() {
        // "Maybe" here would dress a missing input up as a judgement.
        assertEquals(
            R.string.prospect_verdict_none,
            ProspectDisplay.verdictLabel(null),
        )
    }

    @Test
    fun `each recommendation gets its own verdict`() {
        assertEquals(
            R.string.prospect_verdict_buy,
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "buy")),
        )
        assertEquals(
            R.string.prospect_verdict_skip,
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "skip")),
        )
        assertEquals(
            R.string.prospect_verdict_maybe,
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "maybe")),
        )
    }

    @Test
    fun `an unknown recommendation does not become a buy signal`() {
        assertEquals(
            R.string.prospect_verdict_none,
            ProspectDisplay.verdictLabel(ProspectDecision(recommendation = "something_new")),
        )
    }

    // ── Caveats ──────────────────────────────────────────────────────────────

    @Test
    fun `no comps at all is said outright`() {
        val caveat = ProspectDisplay.caveat(
            response(stats = stats(count = 0, median = null, sufficient = false)),
        )!!
        assertEquals(R.string.prospect_caveat_no_comps, caveat.res)
        assertNull(caveat.quantity)
    }

    @Test
    fun `too few comps names how few`() {
        // US-2976: the COUNT travels, and singular-versus-plural is the plurals
        // resource's job - which is the only way Spanish can pick the right
        // form anyway.
        val caveat = ProspectDisplay.caveat(response(stats = stats(count = 2, sufficient = false)))!!
        assertEquals(R.plurals.prospect_caveat_few_comps, caveat.res)
        assertEquals(2, caveat.quantity)
        // The count is both the plural selector AND the number in the
        // sentence. Passing it once would leave "Only %1$d" unfilled.
        assertEquals(listOf<Any>(2), caveat.args)
    }

    @Test
    fun `one comp carries a count of one`() {
        val caveat = ProspectDisplay.caveat(response(stats = stats(count = 1, sufficient = false)))!!
        assertEquals(R.plurals.prospect_caveat_few_comps, caveat.res)
        assertEquals(1, caveat.quantity)
    }

    @Test
    fun `thin confidence is a separate caveat from thin comps`() {
        // Not the same thing: few comps means the PRICE is a guess; low
        // confidence means the verdict built on it is. Asserting the id is what
        // proves they stayed separate.
        val caveat = ProspectDisplay.caveat(
            response(decision = ProspectDecision(recommendation = "buy", confident = false)),
        )!!
        assertEquals(R.string.prospect_caveat_thin_verdict, caveat.res)
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
        val spread = ProspectDisplay.priceRange(stats())
        assertEquals(R.string.prospect_price_range, spread.res)
        assertEquals(
            listOf<Any>(Money.format(50.0), Money.format(30.0), Money.format(80.0)),
            spread.args,
        )

        // Only a median: a different resource, so the "(usually ...)" clause
        // cannot end up wrapped around nothing.
        val median = ProspectDisplay.priceRange(stats(low = null, high = null))
        assertEquals(R.string.prospect_price_median, median.res)
        assertEquals(listOf<Any>(Money.format(50.0)), median.args)

        assertEquals(
            R.string.prospect_no_price_data,
            ProspectDisplay.priceRange(stats(median = null)).res,
        )
        assertEquals(R.string.prospect_no_price_data, ProspectDisplay.priceRange(null).res)
    }

    @Test
    fun `margin carries its return percentage separately`() {
        val withRoi = ProspectDisplay.marginLabel(
            ProspectDecision(recommendation = "buy", estMarginCents = 3200, roiPct = 160.0),
        )!!
        assertEquals(Money.format(32.0), withRoi.profit)
        assertEquals(160, withRoi.roiPercent)

        // No ROI is not a zero ROI. The screen picks a shorter sentence.
        val withoutRoi = ProspectDisplay.marginLabel(
            ProspectDecision(recommendation = "buy", estMarginCents = 3200),
        )!!
        assertEquals(Money.format(32.0), withoutRoi.profit)
        assertNull(withoutRoi.roiPercent)

        assertNull(ProspectDisplay.marginLabel(null))
        assertNull(ProspectDisplay.marginLabel(ProspectDecision(recommendation = "buy")))
    }

    @Test
    fun `an unknown sell-through says nothing rather than guessing`() {
        assertNull(ProspectDisplay.sellThroughLabel(null))
        assertNull(ProspectDisplay.sellThroughLabel(ProspectSellThrough(label = "unknown")))
        val fast = ProspectDisplay.sellThroughLabel(
            ProspectSellThrough(label = "fast", daysLow = 3, daysHigh = 10),
        )!!
        assertEquals(R.string.prospect_sells_fast, fast.pace)
        assertEquals(3, fast.daysLow)
        assertEquals(10, fast.daysHigh)
    }

    @Test
    fun `the wire pace word is mapped, not printed`() {
        // US-2976: "fast" and "slow" arrived from the edge and were dropped
        // straight into an English sentence. A pace nobody has mapped falls to
        // the neutral wording rather than leaking the wire value onto a screen.
        assertEquals(
            R.string.prospect_sells_slow,
            ProspectDisplay.sellThroughLabel(ProspectSellThrough(label = "slow"))!!.pace,
        )
        assertEquals(
            R.string.prospect_sells_average,
            ProspectDisplay.sellThroughLabel(ProspectSellThrough(label = "moderate"))!!.pace,
        )
        assertEquals(
            R.string.prospect_sells_average,
            ProspectDisplay.sellThroughLabel(ProspectSellThrough(label = "brisk"))!!.pace,
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
        // A blank title would land in the list as a row nobody can find again,
        // so the caller substitutes R.string.prospect_untitled_item for this null.
        assertNull(ProspectDisplay.buyTitle(ProspectItem()))
    }
}
