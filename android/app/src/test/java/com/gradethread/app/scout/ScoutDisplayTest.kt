package com.gradethread.app.scout

import com.gradethread.app.R

import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.ui.UiMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1374: the ranking, and the plan-wall handling that decides whether a
 * retry button is offered at all.
 */
class ScoutDisplayTest {

    private fun candidate(
        id: String,
        margin: Int? = 1000,
        grade: Double? = 8.0,
        confidence: Double = 0.8,
        actionable: Boolean = true,
    ) = ScoutCandidate(
        itemId = id,
        title = "Item $id",
        askingCents = 2000,
        shadowGrade = grade,
        gradeConfidence = confidence,
        valueMedianCents = 5000,
        estMarginCents = margin,
        underpriced = margin != null && margin > 0,
        actionable = actionable,
        reason = "because",
    )

    // ── Ranking ──────────────────────────────────────────────────────────────

    @Test
    fun `margin sorts highest first`() {
        val ranked = ScoutDisplay.display(
            listOf(candidate("a", margin = 500), candidate("b", margin = 5000)),
            ScoutSort.MARGIN,
            actionableOnly = false,
        )
        assertEquals(listOf("b", "a"), ranked.map { it.itemId })
    }

    @Test
    fun `a candidate with no margin reading sinks rather than floats`() {
        // An absence is not a result. Putting it above a measured margin would
        // present "we don't know" as "this is the best one".
        val ranked = ScoutDisplay.display(
            listOf(candidate("unknown", margin = null), candidate("known", margin = 1)),
            ScoutSort.MARGIN,
            actionableOnly = false,
        )
        assertEquals(listOf("known", "unknown"), ranked.map { it.itemId })
    }

    @Test
    fun `an ungraded candidate sinks in a grade sort`() {
        val ranked = ScoutDisplay.display(
            listOf(candidate("nograde", grade = null), candidate("low", grade = 2.0)),
            ScoutSort.GRADE,
            actionableOnly = false,
        )
        assertEquals(listOf("low", "nograde"), ranked.map { it.itemId })
    }

    @Test
    fun `confidence sorts on its own axis`() {
        val ranked = ScoutDisplay.display(
            listOf(
                candidate("sure", margin = 1, confidence = 0.95),
                candidate("rich", margin = 9999, confidence = 0.2),
            ),
            ScoutSort.CONFIDENCE,
            actionableOnly = false,
        )
        assertEquals(listOf("sure", "rich"), ranked.map { it.itemId })
    }

    @Test
    fun `the worth-buying filter keeps only actionable candidates`() {
        val ranked = ScoutDisplay.display(
            listOf(candidate("yes"), candidate("no", actionable = false)),
            ScoutSort.MARGIN,
            actionableOnly = true,
        )
        assertEquals(listOf("yes"), ranked.map { it.itemId })
    }

    @Test
    fun `ties break on a stable key`() {
        // Otherwise the list reshuffles under the seller's thumb on recompose.
        val input = listOf(candidate("b", margin = 100), candidate("a", margin = 100))
        val once = ScoutDisplay.display(input, ScoutSort.MARGIN, false)
        val twice = ScoutDisplay.display(input.reversed(), ScoutSort.MARGIN, false)
        assertEquals(once.map { it.itemId }, twice.map { it.itemId })
    }

    // ── Labels ───────────────────────────────────────────────────────────────

    @Test
    fun `a missing grade shows a dash, never a zero`() {
        // A 0.0 would sink a perfectly good item while looking like a reading
        // somebody actually took.
        assertEquals("—", candidate("x", grade = null).gradeLabel)
        assertEquals("8.0", candidate("x", grade = 8.0).gradeLabel)
    }

    @Test
    fun `missing money shows a dash`() {
        assertEquals("—", candidate("x", margin = null).marginLabel)
        assertEquals(
            "No comps",
            candidate("x").copy(valueMedianCents = null).valueLabel,
        )
    }

    // ── Inputs ───────────────────────────────────────────────────────────────

    @Test
    fun `a scan needs at least a keyword or a brand`() {
        assertFalse(ScoutDisplay.canScan("", "", busy = false))
        assertFalse(ScoutDisplay.canScan("jacket", "", busy = true))
        assertTrue(ScoutDisplay.canScan("jacket", "", busy = false))
        assertTrue(ScoutDisplay.canScan("", "Patagonia", busy = false))
    }

    @Test
    fun `the category probe prefers the keyword`() {
        // "Patagonia" alone lands on the apparel root; "Patagonia fleece"
        // resolves to something narrow enough to be worth scanning.
        assertEquals("fleece", ScoutDisplay.categoryProbe(" fleece ", "Patagonia"))
        assertEquals("Patagonia", ScoutDisplay.categoryProbe("  ", "Patagonia"))
        assertEquals("", ScoutDisplay.categoryProbe("", ""))
    }

    // ── Summary ──────────────────────────────────────────────────────────────

    @Test
    fun `the summary distinguishes no results from nothing worth buying`() {
        // US-2976: a resource and its numbers, so this asserts WHICH resource
        // and WHAT numbers. The four cases are four different answers and the
        // distinctness below is what says so.
        assertEquals(R.string.scout_summary_idle, ScoutDisplay.summary(null, 0).res)

        val empty = ScoutScanResponse(scanned = 12, candidates = emptyList(), note = "Nothing here")
        // The SERVER's note wins when there is one; our own sentence is the
        // fallback and is the only half that translates.
        assertEquals("Nothing here", ScoutDisplay.summary(empty, 0).detail)
        assertEquals(R.string.scout_summary_empty, ScoutDisplay.summary(empty, 0).res)

        // Candidates exist, the filter hid them all — and that IS the answer.
        val filtered = ScoutScanResponse(scanned = 8, candidates = listOf(candidate("a")))
        assertEquals(
            UiMessage(R.string.scout_summary_none_cleared, args = listOf(8)),
            ScoutDisplay.summary(filtered, 0),
        )
        assertEquals(
            UiMessage(R.string.scout_summary_showing, args = listOf(8, 1)),
            ScoutDisplay.summary(filtered, 1),
        )
        val cases = listOf(
            ScoutDisplay.summary(null, 0).res,
            ScoutDisplay.summary(empty, 0).res,
            ScoutDisplay.summary(filtered, 0).res,
            ScoutDisplay.summary(filtered, 1).res,
        )
        assertEquals(cases.size, cases.toSet().size)
    }

    // ── Plan walls ───────────────────────────────────────────────────────────

    @Test
    fun `a feature lock reads as a locked feature, not a quota`() {
        val error = EdgeApiError.from(
            402,
            """{"error":"FEATURE_LOCKED","feature":"scout","requiredPlan":"pro"}""",
        )

        assertTrue(error is EdgeApiError.PlanGated)
        val wall = ScoutError.from(error)
        assertEquals(ScoutError.PlanLocked("pro"), wall)
        // The sentence is a resource; the PLAN NAME is the argument, and
        // capitalising it is what this case was really asserting.
        assertEquals(R.string.scout_plan_locked, wall!!.message)
        assertEquals("Pro", wall.messageArg)
    }

    @Test
    fun `a cap reached reads as a quota`() {
        val error = EdgeApiError.from(
            402,
            """{"error":"CAP_REACHED","cap":"aiActions","used":200,"limit":200}""",
        )

        assertEquals(ScoutError.QuotaReached, ScoutError.from(error))
        assertEquals(R.string.scout_quota_reached, ScoutError.from(error)!!.message)
        // A quota takes no plan name; a feature lock does. Same field, and only
        // one of them fills it.
        assertNull(ScoutError.from(error)!!.messageArg)
    }

    @Test
    fun `a transient failure is not a plan wall, so the retry stays`() {
        assertNull(ScoutError.from(EdgeApiError.Network("timed out")))
        assertNull(ScoutError.from(EdgeApiError.from(500, "")))
        assertNull(ScoutError.from(IllegalStateException("boom")))
    }

    @Test
    fun `a 402 with no readable gate body is still a plain error`() {
        // Better a retry that might work than a plan message we invented.
        val error = EdgeApiError.from(402, "gateway said no")
        assertFalse(error is EdgeApiError.PlanGated)
        assertNull(ScoutError.from(error))
    }

    @Test
    fun `a plan wall is marked as an upgrade prompt`() {
        val error = EdgeApiError.from(402, """{"error":"CAP_REACHED","cap":"aiActions"}""")
        assertTrue(error.isUpgradePrompt)
    }
}
