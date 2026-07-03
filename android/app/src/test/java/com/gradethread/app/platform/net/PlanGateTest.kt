package com.gradethread.app.platform.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** US-1306: plan-gate decode + header parse (iOS PlanGate). */
class PlanGateTest {

    @Test
    fun gateBody_decodesVerbatimKeys() {
        val gate = PlanGateError.decode(
            """{"error":"CAP_REACHED","cap":"activeListings","used":10,"limit":10,"plan":"free","requiredPlan":"pro"}""",
        )!!
        assertEquals("You've reached your active-listings limit", gate.title)
        assertEquals("10 of 10 used this month", gate.usageDetail)
        assertEquals("Upgrade to Pro to keep going.", gate.recommendation)
    }

    @Test
    fun featureLock_hasNoUsageDetail() {
        val gate = PlanGateError.decode(
            """{"error":"FEATURE_LOCKED","feature":"autolister","limit":5}""",
        )!!
        assertEquals("That's a paid feature", gate.title)
        assertNull(gate.usageDetail)
    }

    @Test
    fun gateBody_rejectsNonGateJson() {
        assertNull(PlanGateError.decode("""{"ok":true}"""))
        assertNull(PlanGateError.decode("not json"))
    }

    @Test
    fun warningHeader_parses() {
        val warning = PlanWarning.parse("CAP_80;kind=aiActions;used=8;limit=10")!!
        assertEquals("aiActions", warning.kind)
        assertEquals(8, warning.used)
        assertEquals(10, warning.limit)
    }

    @Test
    fun warningHeader_ignoresMalformedShapes() {
        assertNull(PlanWarning.parse("CAP_80"))
        assertNull(PlanWarning.parse("kind=x;used=?;limit=10"))
        assertNull(PlanWarning.parse(""))
    }
}
