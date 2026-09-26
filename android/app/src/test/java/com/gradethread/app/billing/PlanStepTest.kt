package com.gradethread.app.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1367 AC2: who sees the one-time plan step, and who doesn't.
 */
class PlanStepTest {

    @Test
    fun `a brand new account sees it once`() {
        assertTrue(PlanStep.shouldShow("user-1", emptySet(), PlanStep.ServerPlan.FREE))
        assertFalse(PlanStep.shouldShow("user-1", setOf("user-1"), PlanStep.ServerPlan.FREE))
    }

    @Test
    fun `it is per account, not per device`() {
        // Two people share a tablet more often than anyone plans for. A
        // device-wide flag means the second one never sees it.
        assertTrue(PlanStep.shouldShow("user-2", setOf("user-1"), PlanStep.ServerPlan.FREE))
    }

    @Test
    fun `someone who already pays is never asked to pick a plan`() {
        // They may have subscribed on the web and then installed the app.
        // Selling someone the plan they already have is the failure worth
        // designing around.
        assertFalse(PlanStep.shouldShow("user-1", emptySet(), PlanStep.ServerPlan.PAID))
    }

    @Test
    fun `no signed-in user means no step`() {
        assertFalse(PlanStep.shouldShow(null, emptySet(), PlanStep.ServerPlan.FREE))
        assertFalse(PlanStep.shouldShow("", emptySet(), PlanStep.ServerPlan.FREE))
        assertFalse(PlanStep.shouldShow("   ", emptySet(), PlanStep.ServerPlan.FREE))
    }

    @Test
    fun `a plan that could not be read is not a free plan`() {
        // US-3542: a slow start-up used to read as "free" and offer a Business
        // seller the plan they already pay for.
        assertFalse(PlanStep.shouldShow("user-1", emptySet(), PlanStep.ServerPlan.UNKNOWN))
    }

    @Test
    fun `any paid tier counts as paid whatever the subscription status`() {
        assertEquals(PlanStep.ServerPlan.PAID, PlanStep.classify("business"))
        assertEquals(PlanStep.ServerPlan.PAID, PlanStep.classify("Pro"))
        assertEquals(PlanStep.ServerPlan.PAID, PlanStep.classify("starter"))
        assertEquals(PlanStep.ServerPlan.FREE, PlanStep.classify("free"))
        assertEquals(PlanStep.ServerPlan.FREE, PlanStep.classify(null))
        assertEquals(PlanStep.ServerPlan.FREE, PlanStep.classify(" "))
        assertEquals(PlanStep.ServerPlan.UNKNOWN, PlanStep.classify("enterprise"))
    }
}
