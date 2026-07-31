package com.gradethread.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2367: when the realtime socket should be up.
 *
 * Both failure modes here are silent. A channel left open in the background
 * quietly drains battery and data for updates nobody is looking at; a channel
 * that fails to come back after sign-in just means the app stops updating,
 * which is indistinguishable from a slow sync. Neither shows on screen — which
 * is exactly how RealtimeService ended up with no caller at all for six months.
 */
class RealtimeLifecycleTest {

    private fun decide(
        signedIn: Boolean = true,
        foreground: Boolean = true,
        enabled: Boolean = true,
        phase: RealtimeService.Phase = RealtimeService.Phase.IDLE,
    ) = RealtimeLifecycle.decide(signedIn, foreground, enabled, phase)

    @Test
    fun `signed in and in the foreground starts it`() {
        assertEquals(RealtimeLifecycle.Action.START, decide())
    }

    @Test
    fun `background pauses it`() {
        assertEquals(
            RealtimeLifecycle.Action.PAUSE,
            decide(foreground = false, phase = RealtimeService.Phase.SUBSCRIBED),
        )
    }

    @Test
    fun `signing out pauses it even in the foreground`() {
        // The socket is authenticated with a token that is being thrown away.
        // Racing the server's close is not a state worth being in.
        assertEquals(
            RealtimeLifecycle.Action.PAUSE,
            decide(signedIn = false, phase = RealtimeService.Phase.SUBSCRIBED),
        )
    }

    @Test
    fun `the user's own toggle wins`() {
        assertEquals(RealtimeLifecycle.Action.NONE, decide(enabled = false))
        assertEquals(
            RealtimeLifecycle.Action.PAUSE,
            decide(enabled = false, phase = RealtimeService.Phase.SUBSCRIBED),
        )
    }

    @Test
    fun `an already-open channel is left alone`() {
        // Restarting on every foreground event would drop and re-open the
        // socket each time someone glances at another app.
        assertEquals(
            RealtimeLifecycle.Action.NONE,
            decide(phase = RealtimeService.Phase.SUBSCRIBED),
        )
    }

    @Test
    fun `a channel mid-handshake is not started twice`() {
        // SUBSCRIBING and RECONNECTING both mean one is already on its way; a
        // second start would open a duplicate channel for the same rows.
        assertEquals(
            RealtimeLifecycle.Action.NONE,
            decide(phase = RealtimeService.Phase.SUBSCRIBING),
        )
        assertEquals(
            RealtimeLifecycle.Action.NONE,
            decide(phase = RealtimeService.Phase.RECONNECTING),
        )
    }

    @Test
    fun `a reconnecting channel is paused on background, not left dangling`() {
        assertEquals(
            RealtimeLifecycle.Action.PAUSE,
            decide(foreground = false, phase = RealtimeService.Phase.RECONNECTING),
        )
    }

    @Test
    fun `nothing to do when it is already down and should be`() {
        assertEquals(
            RealtimeLifecycle.Action.NONE,
            decide(signedIn = false, foreground = false),
        )
    }

    // ── Re-homing ────────────────────────────────────────────────────────────

    @Test
    fun `a workspace switch only re-homes a channel that is actually up`() {
        // Re-homing an idle channel would OPEN one in the background, which is
        // the opposite of what the pause just achieved.
        assertTrue(RealtimeLifecycle.shouldRehome(RealtimeService.Phase.SUBSCRIBED))
        assertTrue(RealtimeLifecycle.shouldRehome(RealtimeService.Phase.SUBSCRIBING))
        assertTrue(RealtimeLifecycle.shouldRehome(RealtimeService.Phase.RECONNECTING))
        assertFalse(RealtimeLifecycle.shouldRehome(RealtimeService.Phase.IDLE))
        assertFalse(RealtimeLifecycle.shouldRehome(RealtimeService.Phase.DISABLED))
    }

    // ── The catch-up rule this exists to preserve ────────────────────────────

    @Test
    fun `every transition into subscribed catches up`() {
        // US-1211. Postgres-change events emitted while the socket was down are
        // never replayed by the server, so a re-subscribe that skipped the pull
        // would lose the gap until the next manual refresh.
        assertTrue(
            RealtimeService.shouldCatchUp(
                RealtimeService.Phase.RECONNECTING,
                RealtimeService.Phase.SUBSCRIBED,
            ),
        )
        assertTrue(
            RealtimeService.shouldCatchUp(
                RealtimeService.Phase.IDLE,
                RealtimeService.Phase.SUBSCRIBED,
            ),
        )
        assertFalse(
            RealtimeService.shouldCatchUp(
                RealtimeService.Phase.SUBSCRIBED,
                RealtimeService.Phase.SUBSCRIBED,
            ),
        )
    }
}
