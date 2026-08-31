package com.gradethread.app.pricing

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1358: repricing rules and suggestion wording.
 *
 * A rule changes live prices while nobody is watching, so the normalisation
 * here mirrors the server's own — showing a seller a 95% drop the server
 * rewrote to 90 would be a lie about what their listings are doing tonight.
 */
class RepricingTest {

    private fun rule(
        name: String = "Weekly trim",
        enabled: Boolean = true,
        dropPct: Double = 10.0,
        intervalDays: Int = 7,
        floorCents: Int? = 999,
        confidence: Double? = null,
        brand: String? = null,
        minAge: Int = 0,
        itemId: String? = null,
    ) = RepricingRule(
        id = "r1",
        name = name,
        enabled = enabled,
        inventoryItemId = itemId,
        filterBrand = brand,
        minAgeDays = minAge,
        dropPct = dropPct,
        intervalDays = intervalDays,
        floorPriceCents = floorCents,
        autoAcceptConfidence = confidence,
    )

    // ── validity ─────────────────────────────────────────────────────────────

    @Test
    fun `a rule needs a name and an effect`() {
        assertFalse(Repricing.isValid(RuleDraft(name = "", dropPct = 10.0)))
        assertFalse(Repricing.isValid(RuleDraft(name = "Nothing", dropPct = 0.0)))
        assertTrue(Repricing.isValid(RuleDraft(name = "Trim", dropPct = 10.0)))
        // Auto-accept alone is a real effect, even with no drop.
        assertTrue(
            Repricing.isValid(RuleDraft(name = "Accept", dropPct = 0.0, autoAcceptEnabled = true)),
        )
    }

    @Test
    fun `the reason a rule can't be saved is specific`() {
        // US-2976: the resource id. WHICH of the three reasons comes back is
        // what the seller needs, and the id says that as precisely as the
        // sentence did - more precisely, in fact, than a `contains` on a
        // fragment that two of them could have shared.
        assertEquals(
            R.string.repricing_error_name_required,
            Repricing.validationError(RuleDraft(name = " "))?.res,
        )

        val tooLong = Repricing.validationError(RuleDraft(name = "x".repeat(81), dropPct = 5.0))!!
        assertEquals(R.string.repricing_error_name_too_long, tooLong.res)
        // The ceiling reaches the seller as an argument now, so a change to
        // RULE_NAME_MAX cannot leave the sentence saying the old number.
        assertEquals(listOf<Any>(Repricing.RULE_NAME_MAX), tooLong.args)

        assertEquals(
            R.string.repricing_error_no_effect,
            Repricing.validationError(RuleDraft(name = "Idle", dropPct = 0.0))?.res,
        )
        assertNull(Repricing.validationError(RuleDraft(name = "Fine", dropPct = 5.0)))
    }

    // ── normalisation, matching the server ───────────────────────────────────

    @Test
    fun `a drop is clamped to the server's ceiling`() {
        assertEquals(90.0, Repricing.clampDrop(150.0), 1e-9)
        assertEquals(0.0, Repricing.clampDrop(-5.0), 1e-9)
        assertEquals(0.0, Repricing.clampDrop(Double.NaN), 1e-9)
    }

    @Test
    fun `an interval is never less than a day`() {
        val request = Repricing.request(RuleDraft(name = "x", dropPct = 5.0, intervalDays = 0))
        assertEquals(1, request.intervalDays)
    }

    @Test
    fun `auto-accept off sends null, never zero`() {
        // A 0.0 confidence would auto-accept EVERY offer — the exact opposite of
        // what turning the switch off means.
        val off = Repricing.request(RuleDraft(name = "x", dropPct = 5.0, autoAcceptEnabled = false))
        assertNull(off.autoAcceptConfidence)

        val on = Repricing.request(
            RuleDraft(name = "x", dropPct = 5.0, autoAcceptEnabled = true, autoAcceptConfidence = 0.8),
        )
        assertEquals(0.8, on.autoAcceptConfidence!!, 1e-9)
    }

    @Test
    fun `blank filters are omitted rather than sent empty`() {
        val request = Repricing.request(
            RuleDraft(name = "x", dropPct = 5.0, filterBrand = "  ", filterCategoryId = ""),
        )
        assertNull(request.filterBrand)
        assertNull(request.filterCategoryId)
    }

    @Test
    fun `a blank floor means no floor`() {
        assertNull(Repricing.floorPriceCents(""))
        assertEquals(999, Repricing.floorPriceCents("9.99"))
    }

    // ── how a rule reads ─────────────────────────────────────────────────────

    @Test
    fun `the action summary names every part of what happens`() {
        val summary = Repricing.actionSummary(rule(dropPct = 10.0, floorCents = 999, confidence = 0.8))
        assertEquals(
            listOf(
                R.string.repricing_action_drop,
                R.string.repricing_action_auto_accept,
                R.string.repricing_action_floor,
            ),
            summary.map { it.res },
        )
        // The drop clause carries both its numbers, in the order the sentence
        // reads them: how much, then how often.
        assertEquals(listOf<Any>("10", 7), summary[0].args)
        assertEquals(listOf<Any>(80), summary[1].args)
    }

    @Test
    fun `a rule that does nothing says so rather than reading as blank`() {
        val summary = Repricing.actionSummary(rule(dropPct = 0.0, floorCents = null))
        assertEquals(listOf(R.string.repricing_action_none), summary.map { it.res })
    }

    @Test
    fun `an unscoped rule says it touches everything`() {
        assertEquals(
            listOf(R.string.repricing_scope_all),
            Repricing.scopeSummary(rule()).map { it.res },
        )

        val scoped = Repricing.scopeSummary(rule(brand = "Nike", minAge = 30))
        assertEquals(
            listOf(R.string.repricing_scope_brand, R.string.repricing_scope_min_age),
            scoped.map { it.res },
        )
        // The brand is the seller's own word and goes through untouched.
        assertEquals(listOf<Any>("Nike"), scoped[0].args)
        assertEquals(listOf<Any>(30), scoped[1].args)
    }

    @Test
    fun `a live rule with no floor is flagged`() {
        // Nothing stops it, and the seller should know before it runs tonight.
        assertEquals(R.string.repricing_no_floor, Repricing.floorWarning(rule(floorCents = null)))
        assertNull(Repricing.floorWarning(rule(floorCents = 999)))
        // A disabled rule isn't cutting anything, so it isn't a warning.
        assertNull(Repricing.floorWarning(rule(enabled = false, floorCents = null)))
    }

    // ── how a suggestion reads ───────────────────────────────────────────────

    private fun suggestion(current: Int, suggested: Int, comps: Int? = null, code: String = "OVERPRICED") =
        RepricingSuggestion(
            id = "s1",
            currentPriceCents = current,
            suggestedPriceCents = suggested,
            compCount = comps,
            compMedianCents = 4200,
            reasonCode = code,
        )

    @Test
    fun `the change summary shows the direction`() {
        // US-2976: up and down are SEPARATE resources, so the direction is a
        // resource id rather than a sign inside a string. Misreading a price
        // cut as a rise is the one mistake this line must not allow.
        val down = Repricing.changeSummary(suggestion(4800, 4200))
        assertEquals(R.string.repricing_change_down, down.res)
        assertEquals(13, down.args[2])

        val up = Repricing.changeSummary(suggestion(4200, 4800))
        assertEquals(R.string.repricing_change_up, up.res)
        assertEquals(14, up.args[2])
    }

    @Test
    fun `a zero current price yields no percentage rather than a divide by zero`() {
        val summary = Repricing.changeSummary(suggestion(0, 4200))
        assertEquals(R.string.repricing_change, summary.res)
        assertEquals(2, summary.args.size)
    }

    @Test
    fun `the evidence behind a suggestion is shown, not hidden`() {
        // The COUNT is what the seller weighs; singular versus plural is now a
        // plurals resource, which is the only form Spanish can pick correctly.
        val two = Repricing.evidenceSummary(suggestion(4800, 4200, comps = 2))!!
        assertEquals(R.plurals.repricing_evidence_median, two.res)
        assertEquals(2, two.quantity)
        assertEquals(2, two.args[0])
        assertEquals(1, Repricing.evidenceSummary(suggestion(4800, 4200, comps = 1))!!.quantity)

        // No median is a DIFFERENT plurals resource, not the same one with a
        // blank tail - otherwise the line reads "... - median " and stops.
        val noMedian = Repricing.evidenceSummary(
            suggestion(4800, 4200, comps = 4).copy(compMedianCents = null),
        )!!
        assertEquals(R.plurals.repricing_evidence, noMedian.res)
        assertEquals(listOf<Any>(4), noMedian.args)

        assertNull(Repricing.evidenceSummary(suggestion(4800, 4200, comps = 0)))
        assertNull(Repricing.evidenceSummary(suggestion(4800, 4200, comps = null)))
    }

    @Test
    fun `reason codes read as sentences, and unknown ones still say something`() {
        assertEquals(
            R.string.repricing_reason_underpriced,
            Repricing.reasonLabel("UNDERPRICED").res,
        )
        assertEquals(R.string.repricing_reason_stale, Repricing.reasonLabel("STALE").res)

        // A code this build has never been taught arrives as `detail` - the
        // server's own word, shown untranslated because there is nothing
        // better, and tidied rather than dropped.
        val unknown = Repricing.reasonLabel("SOME_NEW_CODE")
        assertEquals(R.string.repricing_reason_unknown, unknown.res)
        assertEquals("Some new code", unknown.detail)
        assertNull(Repricing.reasonLabel("STALE").detail)
    }

    // ── scan reporting ───────────────────────────────────────────────────────

    @Test
    fun `a scan says what it found`() {
        val actionable = Repricing.scanSummary(ScanResult(scanned = 25, actionable = 3))
        assertEquals(R.string.repricing_scan_actionable, actionable.res)
        // Scanned first, actionable second. Reversed, a scan that found three
        // things to fix reads as one that found twenty-five.
        assertEquals(listOf<Any>(25, 3), actionable.args)

        val nothing = Repricing.scanSummary(ScanResult(scanned = 25))
        assertEquals(R.string.repricing_scan_nothing, nothing.res)
        assertEquals(listOf<Any>(25), nothing.args)

        assertEquals(R.string.repricing_scan_none, Repricing.scanSummary(ScanResult()).res)
    }

    @Test
    fun `what a scan couldn't check is reported too`() {
        // Otherwise "nothing worth changing" hides listings that were never
        // compared to anything.
        val caveats = Repricing.scanCaveat(
            ScanResult(scanned = 25, skippedNoCategory = 4, errors = 1),
        )
        assertEquals(
            listOf(R.plurals.repricing_skipped_no_category, R.plurals.repricing_scan_errors),
            caveats.map { it.res },
        )
        assertEquals(listOf<Int?>(4, 1), caveats.map { it.quantity })
        assertTrue(Repricing.scanCaveat(ScanResult(scanned = 25, actionable = 2)).isEmpty())
    }

    @Test
    fun `the scan limit stays inside what the server accepts`() {
        assertEquals(50, Repricing.clampScanLimit(500))
        assertEquals(1, Repricing.clampScanLimit(0))
        assertEquals(25, Repricing.clampScanLimit(25))
    }
}
