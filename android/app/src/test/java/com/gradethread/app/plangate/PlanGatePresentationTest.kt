package com.gradethread.app.plangate

import com.gradethread.app.platform.net.PlanGateError
import com.gradethread.app.platform.net.PlanWarning
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1367 AC3: the shell gate, which is mostly about NOT nagging.
 */
class PlanGatePresentationTest {

    private val listingsCap = PlanGateError(
        error = "CAP_REACHED",
        cap = "activeListings",
        used = 250,
        limit = 250,
        plan = "starter",
        requiredPlan = "pro",
    )

    private fun warn(kind: String, used: Int, limit: Int) = PlanWarning(kind, used, limit)

    @Test
    fun `a hard cap always shows`() {
        val state = PlanGatePresentation.onGate(PlanGatePresentation.State(), listingsCap)
        assertEquals(listingsCap, state.gate)
    }

    @Test
    fun `hitting the wall clears the eighty-percent banner for the same cap`() {
        // Otherwise the dialog says "250 of 250" over a banner still saying
        // "210 of 250", and the smaller number is the one people believe.
        var state = PlanGatePresentation.onWarning(
            PlanGatePresentation.State(),
            warn("activeListings", 210, 250),
        )
        assertNotNull(state.warning)

        state = PlanGatePresentation.onGate(state, listingsCap)
        assertNull(state.warning)
    }

    @Test
    fun `a warning about a different capacity survives an unrelated wall`() {
        var state = PlanGatePresentation.onWarning(
            PlanGatePresentation.State(),
            warn("aiActions", 160, 200),
        )
        state = PlanGatePresentation.onGate(state, listingsCap)

        assertNotNull(state.warning)
        assertEquals("aiActions", state.warning!!.kind)
    }

    @Test
    fun `no soft warning is raised while a hard wall is up`() {
        var state = PlanGatePresentation.onGate(PlanGatePresentation.State(), listingsCap)
        state = PlanGatePresentation.onWarning(state, warn("aiActions", 160, 200))

        assertNull(state.warning)
    }

    @Test
    fun `a dismissed warning stays dismissed no matter how many arrive`() {
        // A bulk run raises the same warning on every response. Re-showing it
        // would make the shell unusable at the moment someone is working hardest.
        var state = PlanGatePresentation.onWarning(
            PlanGatePresentation.State(),
            warn("aiActions", 160, 200),
        )
        state = PlanGatePresentation.dismissWarning(state)

        repeat(20) {
            state = PlanGatePresentation.onWarning(state, warn("aiActions", 160 + it, 200))
        }
        assertNull(state.warning)
    }

    @Test
    fun `a dismissed warning comes back when the limit changes`() {
        // After an upgrade or a new month it is a different fact about a
        // different number.
        var state = PlanGatePresentation.onWarning(
            PlanGatePresentation.State(),
            warn("activeListings", 210, 250),
        )
        state = PlanGatePresentation.dismissWarning(state)

        state = PlanGatePresentation.onWarning(state, warn("activeListings", 850, 1000))
        assertNotNull(state.warning)
        assertEquals(1000, state.warning!!.limit)
    }

    @Test
    fun `a nonsense warning is dropped rather than rendered`() {
        // "You have used 300 of your 250" is a support ticket, not a nudge.
        val start = PlanGatePresentation.State()
        assertNull(PlanGatePresentation.onWarning(start, warn("aiActions", 300, 250)).warning)
        assertNull(PlanGatePresentation.onWarning(start, warn("aiActions", 10, 0)).warning)
        assertNull(PlanGatePresentation.onWarning(start, warn("aiActions", -1, 200)).warning)
    }

    @Test
    fun `progress is clamped to the track`() {
        assertEquals(0.8f, PlanGatePresentation.progress(warn("aiActions", 160, 200)), 0.001f)
        assertEquals(1f, PlanGatePresentation.progress(warn("aiActions", 260, 250)), 0.001f)
        assertEquals(1f, PlanGatePresentation.progress(warn("aiActions", 5, 0)), 0.001f)
    }

    @Test
    fun `closing the dialog leaves the seller where they were`() {
        var state = PlanGatePresentation.onGate(PlanGatePresentation.State(), listingsCap)
        state = PlanGatePresentation.dismissGate(state)

        assertNull(state.gate)
        // Not added to `dismissed` — that set is for warnings. The next 402
        // must show again, because they just tried the thing again.
        assertTrue(state.dismissed.isEmpty())
    }

    @Test
    fun `a second wall replaces the first`() {
        val aiCap = listingsCap.copy(cap = "aiActions", used = 200, limit = 200)
        var state = PlanGatePresentation.onGate(PlanGatePresentation.State(), listingsCap)
        state = PlanGatePresentation.onGate(state, aiCap)

        assertEquals("aiActions", state.gate!!.cap)
    }

    @Test
    fun `the banner names the capacity in words`() {
        assertEquals(
            "You've used 210 of your 250 active-listings allowance.",
            PlanGatePresentation.warningMessage(warn("activeListings", 210, 250)),
        )
    }

    @Test
    fun `a gate with nothing to sell offers no upgrade button`() {
        val empty = PlanGateError(error = "CAP_REACHED")
        assertFalse(PlanGatePresentation.offersUpgrade(empty))
        assertTrue(PlanGatePresentation.offersUpgrade(listingsCap))
        assertTrue(
            PlanGatePresentation.offersUpgrade(
                PlanGateError(error = "FEATURE_LOCKED", feature = "autolister"),
            ),
        )
    }

    @Test
    fun `dismissing with no banner up changes nothing`() {
        val state = PlanGatePresentation.State()
        assertEquals(state, PlanGatePresentation.dismissWarning(state))
    }
}
