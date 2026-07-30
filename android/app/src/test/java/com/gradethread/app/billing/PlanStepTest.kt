package com.gradethread.app.billing

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1367 AC2: who sees the one-time plan step, and who doesn't.
 */
class PlanStepTest {

    @Test
    fun `a brand new account sees it once`() {
        assertTrue(PlanStep.shouldShow("user-1", emptySet(), null))
        assertFalse(PlanStep.shouldShow("user-1", setOf("user-1"), null))
    }

    @Test
    fun `it is per account, not per device`() {
        // Two people share a tablet more often than anyone plans for. A
        // device-wide flag means the second one never sees it.
        assertTrue(PlanStep.shouldShow("user-2", setOf("user-1"), null))
    }

    @Test
    fun `someone who already pays is never asked to pick a plan`() {
        // They may have subscribed on the web and then installed the app.
        // Selling someone the plan they already have is the failure worth
        // designing around.
        assertFalse(PlanStep.shouldShow("user-1", emptySet(), PlanTier.PRO))
    }

    @Test
    fun `no signed-in user means no step`() {
        assertFalse(PlanStep.shouldShow(null, emptySet(), null))
        assertFalse(PlanStep.shouldShow("", emptySet(), null))
        assertFalse(PlanStep.shouldShow("   ", emptySet(), null))
    }
}
