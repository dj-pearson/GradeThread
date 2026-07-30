package com.gradethread.app.marketplaces.reconciliation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1356: when the shell banner shows, and what it claims.
 *
 * The snooze rule is the one worth pinning: a dismissal that swallowed NEW
 * unmatched listings for a day would quietly hide work the seller asked to be
 * told about, and the count's honesty matters because it is the only number
 * they see before deciding to tap.
 */
class ReconcileBadgeTest {

    private val hour = 60L * 60 * 1000
    private val now = 1_000_000_000L

    @Test
    fun `no orphans means no banner`() {
        assertFalse(ReconcileBadgeState(OrphanCount(0)).visible(now))
    }

    @Test
    fun `orphans with no snooze show the banner`() {
        assertTrue(ReconcileBadgeState(OrphanCount(3)).visible(now))
    }

    @Test
    fun `a live snooze hides it`() {
        val state = ReconcileBadgeState(
            count = OrphanCount(3),
            snoozedUntilMs = now + 5 * hour,
            snoozeBaseline = 3,
        )
        assertTrue(state.isSnoozed(now))
        assertFalse(state.visible(now))
    }

    @Test
    fun `an expired snooze lets it back`() {
        val state = ReconcileBadgeState(
            count = OrphanCount(3),
            snoozedUntilMs = now - hour,
            snoozeBaseline = 3,
        )
        assertTrue(state.visible(now))
    }

    @Test
    fun `new orphans re-surface it inside the snooze window`() {
        // The seller dismissed the pile they had seen, not every pile they will
        // ever have. Four unmatched listings when three were snoozed is new work.
        val state = ReconcileBadgeState(
            count = OrphanCount(4),
            snoozedUntilMs = now + 5 * hour,
            snoozeBaseline = 3,
        )
        assertFalse(state.isSnoozed(now))
        assertTrue(state.visible(now))
    }

    @Test
    fun `fewer orphans than the baseline stays snoozed`() {
        // Reconciling some of them is progress, not a reason to nag again.
        val state = ReconcileBadgeState(
            count = OrphanCount(1),
            snoozedUntilMs = now + 5 * hour,
            snoozeBaseline = 3,
        )
        assertFalse(state.visible(now))
    }

    // ── what the number claims ───────────────────────────────────────────────

    @Test
    fun `a single listing reads in the singular`() {
        assertEquals("1 unmatched eBay listing", OrphanCount(1).label)
        assertEquals("3 unmatched eBay listings", OrphanCount(3).label)
    }

    @Test
    fun `a capped count says so rather than claiming an exact total`() {
        // The count is read with a ceiling. "200" would assert a measurement
        // that was never taken.
        assertEquals("200+ unmatched eBay listings", OrphanCount(200, atLeast = true).label)
    }
}
