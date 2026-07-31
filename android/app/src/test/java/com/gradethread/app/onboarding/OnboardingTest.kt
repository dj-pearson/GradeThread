package com.gradethread.app.onboarding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1384: the first-run rules.
 *
 * Onboarding is seen exactly once per account, which means every bug in it is a
 * bug nobody can reproduce on their own device without wiping app data. The
 * rules are pure so they can be checked without that.
 */
class OnboardingTest {

    // ── When it shows ────────────────────────────────────────────────────────

    @Test
    fun `only once, and only when signed in`() {
        // Onboarding before sign-in would ask a stranger to pick a use case and
        // then throw the answer away at the login screen.
        assertTrue(Onboarding.shouldShow(signedIn = true, completed = false))
        assertFalse(Onboarding.shouldShow(signedIn = true, completed = true))
        assertFalse(Onboarding.shouldShow(signedIn = false, completed = false))
    }

    // ── Stepping ─────────────────────────────────────────────────────────────

    @Test
    fun `the carousel advances slide by slide before moving on`() {
        var step = Onboarding.Step.CAROUSEL
        var page = 0
        repeat(Onboarding.pages.size - 1) {
            val next = Onboarding.advance(step, page)
            step = next.first
            page = next.second
            assertEquals(Onboarding.Step.CAROUSEL, step)
        }
        assertEquals(Onboarding.pages.size - 1, page)

        val afterLast = Onboarding.advance(step, page)
        assertEquals(Onboarding.Step.USE_CASE, afterLast.first)
    }

    @Test
    fun `use case leads to activation, and activation is the end`() {
        assertEquals(
            Onboarding.Step.ACTIVATION,
            Onboarding.advance(Onboarding.Step.USE_CASE, 3).first,
        )
        assertEquals(
            Onboarding.Step.ACTIVATION,
            Onboarding.advance(Onboarding.Step.ACTIVATION, 3).first,
        )
    }

    @Test
    fun `the button says what it will do`() {
        assertEquals("Next", Onboarding.primaryLabel(Onboarding.Step.CAROUSEL, 0))
        assertEquals(
            "Get started",
            Onboarding.primaryLabel(Onboarding.Step.CAROUSEL, Onboarding.pages.size - 1),
        )
        assertEquals("Continue", Onboarding.primaryLabel(Onboarding.Step.USE_CASE, 0))
        assertEquals("Start selling", Onboarding.primaryLabel(Onboarding.Step.ACTIVATION, 0))
    }

    // ── Use cases ────────────────────────────────────────────────────────────

    @Test
    fun `every use case routes somewhere real`() {
        // A first ACTION, never a dashboard: a new account has no data, so an
        // empty dashboard teaches the seller the app is empty.
        assertEquals("capture/autolister", OnboardingUseCase.RESELLER.firstActionRoute)
        assertEquals("capture/photos", OnboardingUseCase.GRADER.firstActionRoute)
        assertEquals("marketplaces", OnboardingUseCase.STORE.firstActionRoute)
        OnboardingUseCase.entries.forEach {
            assertTrue(it.wire, it.firstActionRoute.isNotBlank())
        }
    }

    @Test
    fun `wire values round-trip, and an unknown one is null`() {
        // The value is persisted, so a rename would silently route an existing
        // user nowhere.
        OnboardingUseCase.entries.forEach {
            assertEquals(it, OnboardingUseCase.fromWire(it.wire))
        }
        assertNull(OnboardingUseCase.fromWire("influencer"))
        assertNull(OnboardingUseCase.fromWire(null))
    }

    @Test
    fun `the carousel is short`() {
        // Every extra slide is another chance to close the app before seeing it
        // do anything.
        assertTrue(Onboarding.pages.size <= 4)
        Onboarding.pages.forEach {
            assertTrue(it.title.isNotBlank())
            assertTrue(it.body.isNotBlank())
        }
    }

    // ── Activation checklist ─────────────────────────────────────────────────

    @Test
    fun `notifications drop off entirely below Android 13`() {
        // There is no runtime grant to give, so a button there could not do
        // anything, which is worse than not offering it.
        val rows = ActivationChecklist.rows(
            notificationsRequired = false,
            notificationsGranted = true,
            notificationsAsked = false,
            ebayConnected = false,
        )

        assertEquals(listOf(ActivationChecklist.Item.EBAY), rows.map { it.item })
    }

    @Test
    fun `a done item stays on the list, ticked`() {
        // A list that shortens as you work it looks like things are being taken
        // away. A list with ticks looks like progress.
        val rows = ActivationChecklist.rows(
            notificationsRequired = true,
            notificationsGranted = true,
            notificationsAsked = true,
            ebayConnected = false,
        )

        assertEquals(2, rows.size)
        val notifications = rows.first { it.item == ActivationChecklist.Item.NOTIFICATIONS }
        assertTrue(notifications.done)
        assertFalse(notifications.actionable)
    }

    @Test
    fun `an already-refused permission is shown but not tappable`() {
        // Android silently auto-denies the second dialog, so a button here
        // would do nothing and look broken.
        val rows = ActivationChecklist.rows(
            notificationsRequired = true,
            notificationsGranted = false,
            notificationsAsked = true,
            ebayConnected = false,
        )

        val notifications = rows.first { it.item == ActivationChecklist.Item.NOTIFICATIONS }
        assertFalse(notifications.done)
        assertFalse(notifications.actionable)
    }

    @Test
    fun `a fresh install can tap both`() {
        val rows = ActivationChecklist.rows(
            notificationsRequired = true,
            notificationsGranted = false,
            notificationsAsked = false,
            ebayConnected = false,
        )

        assertTrue(rows.all { it.actionable })
        assertFalse(ActivationChecklist.allDone(rows))
        assertEquals("0 of 2 done", ActivationChecklist.progressLabel(rows))
    }

    @Test
    fun `progress counts what is done`() {
        val rows = ActivationChecklist.rows(
            notificationsRequired = true,
            notificationsGranted = true,
            notificationsAsked = true,
            ebayConnected = true,
        )

        assertEquals("2 of 2 done", ActivationChecklist.progressLabel(rows))
        assertTrue(ActivationChecklist.allDone(rows))
    }

    @Test
    fun `an empty checklist reports nothing rather than zero of zero`() {
        assertNull(ActivationChecklist.progressLabel(emptyList()))
        assertFalse(ActivationChecklist.allDone(emptyList()))
    }

    @Test
    fun `an eBay connection that needs reconnecting is not connected`() {
        // Modelled here as the caller passing false; the row must then be
        // actionable, because a broken connection is exactly when the seller
        // needs the button.
        val rows = ActivationChecklist.rows(
            notificationsRequired = false,
            notificationsGranted = true,
            notificationsAsked = true,
            ebayConnected = false,
        )

        assertTrue(rows.single().actionable)
    }
}
