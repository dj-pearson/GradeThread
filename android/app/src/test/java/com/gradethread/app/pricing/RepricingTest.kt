package com.gradethread.app.pricing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
        assertEquals("Give the rule a name.", Repricing.validationError(RuleDraft(name = " ")))
        assertTrue(
            Repricing.validationError(RuleDraft(name = "x".repeat(81), dropPct = 5.0))!!
                .contains("too long"),
        )
        assertTrue(
            Repricing.validationError(RuleDraft(name = "Idle", dropPct = 0.0))!!
                .contains("does something"),
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
        assertTrue(summary.contains("Drop 10% every 7d"))
        assertTrue(summary.contains("auto-accept ≥ 80%"))
        assertTrue(summary.contains("floor"))
    }

    @Test
    fun `an unscoped rule says it touches everything`() {
        assertEquals("All listings", Repricing.scopeSummary(rule()))
        assertEquals(
            "Nike · 30d+ old",
            Repricing.scopeSummary(rule(brand = "Nike", minAge = 30)),
        )
    }

    @Test
    fun `a live rule with no floor is flagged`() {
        // Nothing stops it, and the seller should know before it runs tonight.
        assertNotNull(Repricing.floorWarning(rule(floorCents = null)))
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
        assertTrue(Repricing.changeSummary(suggestion(4800, 4200)).contains("−13%"))
        assertTrue(Repricing.changeSummary(suggestion(4200, 4800)).contains("+14%"))
    }

    @Test
    fun `a zero current price yields no percentage rather than a divide by zero`() {
        val summary = Repricing.changeSummary(suggestion(0, 4200))
        assertFalse(summary.contains("%"))
    }

    @Test
    fun `the evidence behind a suggestion is shown, not hidden`() {
        assertTrue(Repricing.evidenceSummary(suggestion(4800, 4200, comps = 2))!!.contains("2 comparable listings"))
        assertTrue(Repricing.evidenceSummary(suggestion(4800, 4200, comps = 1))!!.contains("1 comparable listing"))
        assertNull(Repricing.evidenceSummary(suggestion(4800, 4200, comps = 0)))
        assertNull(Repricing.evidenceSummary(suggestion(4800, 4200, comps = null)))
    }

    @Test
    fun `reason codes read as sentences, and unknown ones still say something`() {
        assertEquals("Priced under comparable listings", Repricing.reasonLabel("UNDERPRICED"))
        assertEquals("Sitting unsold", Repricing.reasonLabel("STALE"))
        assertEquals("Some new code", Repricing.reasonLabel("SOME_NEW_CODE"))
    }

    // ── scan reporting ───────────────────────────────────────────────────────

    @Test
    fun `a scan says what it found`() {
        assertEquals(
            "Scanned 25, 3 worth a look.",
            Repricing.scanSummary(ScanResult(scanned = 25, actionable = 3)),
        )
        assertEquals(
            "Scanned 25. Nothing worth changing.",
            Repricing.scanSummary(ScanResult(scanned = 25)),
        )
        assertEquals("No active listings to scan.", Repricing.scanSummary(ScanResult()))
    }

    @Test
    fun `what a scan couldn't check is reported too`() {
        // Otherwise "nothing worth changing" hides listings that were never
        // compared to anything.
        val caveat = Repricing.scanCaveat(
            ScanResult(scanned = 25, skippedNoCategory = 4, errors = 1),
        )!!
        assertTrue(caveat.contains("4 skipped with no eBay category"))
        assertTrue(caveat.contains("1 couldn't be checked"))
        assertNull(Repricing.scanCaveat(ScanResult(scanned = 25, actionable = 2)))
    }

    @Test
    fun `the scan limit stays inside what the server accepts`() {
        assertEquals(50, Repricing.clampScanLimit(500))
        assertEquals(1, Repricing.clampScanLimit(0))
        assertEquals(25, Repricing.clampScanLimit(25))
    }
}
