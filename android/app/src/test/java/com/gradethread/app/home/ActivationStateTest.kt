package com.gradethread.app.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-1370 AC2 / US-647: the activation checklist's visibility rules.
 */
class ActivationStateTest {

    @Test
    fun aFreshAccountShowsAllThreeSteps() {
        val state = ActivationState()
        assertTrue(state.shouldShow)
        assertEquals(0, state.completedCount)
        assertEquals(3, state.steps.size)
        assertTrue(state.steps.none { it.done })
    }

    @Test
    fun completedStepsAreTickedInPlace() {
        val state = ActivationState(hasItem = true, ebayConnected = true)
        assertEquals(2, state.completedCount)
        assertTrue(state.steps.single { it.id == ActivationStep.ADD_ITEM.id }.done)
        assertFalse(state.steps.single { it.id == ActivationStep.NOTIFICATIONS.id }.done)
    }

    @Test
    fun theCardHidesItselfOnceEveryStepIsDone() {
        // Even without a dismissal: a checklist with three ticks is clutter, and
        // making the seller dismiss it to be rid of it is a chore we'd be
        // choosing to give them.
        val done = ActivationState(
            hasItem = true,
            ebayConnected = true,
            notificationsEnabled = true,
        )
        assertTrue(done.allComplete)
        assertFalse(done.shouldShow)
    }

    @Test
    fun aDismissalHidesItRegardlessOfProgress() {
        assertFalse(ActivationState(dismissed = true).shouldShow)
        assertFalse(ActivationState(hasItem = true, dismissed = true).shouldShow)
    }

    @Test
    fun theStepOrderIsFixedSoProgressCopyCannotDisagreeWithTheList() {
        assertEquals(
            listOf(
                ActivationStep.ADD_ITEM.id,
                ActivationStep.CONNECT_EBAY.id,
                ActivationStep.NOTIFICATIONS.id,
            ),
            ActivationState().steps.map { it.id },
        )
    }

    @Test
    fun stepCopyIsValueFramedNotMechanical() {
        // US-647: the row explains WHY before the OS asks, which is the
        // difference between a considered yes and a reflexive no.
        //
        // US-2976: the copy is in strings.xml now, so this reads the XML in
        // BOTH locales. Asserting the resource id instead would prove a
        // subtitle exists and nothing about what it says - and a translator
        // who wrote "Activa las notificaciones" for the subtitle would have
        // dropped the US-647 claim with every test still green.
        //
        // The test working directory is app/, not android/.
        for ((dir, sells) in listOf("values" to "sells", "values-es" to "venda")) {
            val xml = File("src/main/res/$dir/strings.xml").readText()
            val subtitle = value(xml, "activation_notifications_subtitle")
            assertTrue("$dir says nothing about selling: $subtitle", subtitle.contains(sells))
            assertTrue(dir, value(xml, "activation_connect_ebay_subtitle").isNotBlank())
        }
    }

    /** The body of one `<string name="…">` from a strings.xml. */
    private fun value(xml: String, name: String): String {
        val line = xml.lines().firstOrNull { it.contains("\"$name\"") }
        assertNotNull("missing $name", line)
        return line!!.substringAfter(">").substringBefore("</string>")
    }
}
