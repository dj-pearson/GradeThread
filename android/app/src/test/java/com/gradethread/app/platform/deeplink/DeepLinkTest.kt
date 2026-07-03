package com.gradethread.app.platform.deeplink

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1314: the Uri→route matrix, the rate-limit gate, and the pre-sign-in
 * queue/replay — mirroring DeepLinkRoute / DeepLinkGate / pendingDeepLink.
 */
@RunWith(RobolectricTestRunner::class)
class DeepLinkTest {

    // ── Uri → route ──

    @Test
    fun appLinks_parseTheContentDestinations() {
        fun route(s: String) = DeepLinkRoute.fromUri(Uri.parse(s))
        assertEquals(
            DeepLinkRoute.InventoryItem("abc"),
            route("https://gradethread.com/app/item/abc"),
        )
        assertEquals(DeepLinkRoute.InventoryTab, route("https://gradethread.com/app/inventory"))
        assertEquals(
            DeepLinkRoute.SalesTab("i9"),
            route("https://gradethread.com/app/sales/i9"),
        )
        assertEquals(DeepLinkRoute.SalesTab(null), route("https://gradethread.com/app/sales"))
        assertEquals(DeepLinkRoute.MarketplacesTab, route("https://gradethread.com/app/marketplaces"))
        assertEquals(DeepLinkRoute.ReconnectEbay, route("https://gradethread.com/app/reconnect"))
        assertEquals(
            DeepLinkRoute.NegotiationInbox("i1"),
            route("https://gradethread.com/app/negotiation/i1"),
        )
        assertEquals(DeepLinkRoute.GradesList, route("https://gradethread.com/app/grades"))
        assertEquals(
            DeepLinkRoute.SupportTickets("t7"),
            route("https://gradethread.com/app/support/t7"),
        )
        assertEquals(DeepLinkRoute.CaptureItem, route("https://gradethread.com/app/capture"))
        assertEquals(DeepLinkRoute.AddItem, route("https://gradethread.com/app/add"))
    }

    @Test
    fun authCallback_isNeverContentRouted() {
        // AC4: the auth redirect belongs to AuthCallbackActivity exclusively.
        assertNull(DeepLinkRoute.fromUri(Uri.parse("https://gradethread.com/app/auth-callback?code=x")))
        assertNull(DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://auth-callback?code=x")))
    }

    @Test
    fun widgetLinks_parse() {
        assertEquals(
            DeepLinkRoute.MarketplacesTab,
            DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://widget/marketplaces")),
        )
        assertEquals(
            DeepLinkRoute.SalesTab(null),
            DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://widget/money")),
        )
        assertNull(DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://widget/unknown")))
    }

    @Test
    fun foreignUris_fallThrough() {
        assertNull(DeepLinkRoute.fromUri(null))
        assertNull(DeepLinkRoute.fromUri(Uri.parse("https://evil.com/app/item/x")))
        assertNull(DeepLinkRoute.fromUri(Uri.parse("https://gradethread.com/pricing")))
        assertNull(DeepLinkRoute.fromUri(Uri.parse("mailto:a@b.co")))
    }

    @Test
    fun everyRoute_mapsToARegisteredNavTarget() {
        val routes = listOf(
            DeepLinkRoute.SalesTab("x"), DeepLinkRoute.MarketplacesTab,
            DeepLinkRoute.ReconnectEbay, DeepLinkRoute.InventoryItem("x"),
            DeepLinkRoute.InventoryTab, DeepLinkRoute.NegotiationInbox(null),
            DeepLinkRoute.GradesList, DeepLinkRoute.CaptureItem,
            DeepLinkRoute.AddItem, DeepLinkRoute.SupportTickets(null),
        )
        // The registered graph today (shell roots + capture + add + settings).
        val registered = setOf(
            "home", "inventory", "add", "money", "marketplaces",
            "settings", "search", "tools",
            "capture/photos", "capture/details", "capture/autolister",
        )
        for (route in routes) {
            assertTrue(
                "${route::class.simpleName} → ${route.toNavRoute()} is unregistered",
                route.toNavRoute() in registered,
            )
        }
    }

    // ── Gate + pending queue ──

    @Test
    fun gate_rateLimitsBursts() {
        val controller = DeepLinkController(minIntervalMs = 250)
        assertTrue(controller.shouldAccept(lastMs = null, nowMs = 1_000))
        assertFalse(controller.shouldAccept(lastMs = 1_000, nowMs = 1_100))
        assertTrue(controller.shouldAccept(lastMs = 1_000, nowMs = 1_250))
    }

    @Test
    fun linkBeforeSignIn_isQueuedAndReplayedOnce() {
        var now = 0L
        val controller = DeepLinkController(clock = { now.also { now += 1_000 } })

        controller.offer(Uri.parse("https://gradethread.com/app/sales"), isReady = false)
        // A newer link supersedes the queued one (single slot).
        controller.offer(Uri.parse("https://gradethread.com/app/grades"), isReady = false)
        assertEquals(DeepLinkRoute.GradesList, controller.peekPending())

        controller.replayPending()
        assertNull(controller.peekPending())
        // A second replay is a no-op.
        controller.replayPending()
        assertNull(controller.peekPending())
    }

    @Test
    fun spamBurst_doesNotConsumeTheGateForForeignUris() {
        var now = 0L
        val controller = DeepLinkController(minIntervalMs = 250, clock = { now })
        // A foreign URI must not advance the accepted-at timestamp…
        controller.offer(Uri.parse("https://evil.com/x"), isReady = true)
        now = 100
        // …so a real link 100ms later still routes.
        controller.offer(Uri.parse("https://gradethread.com/app/grades"), isReady = false)
        assertEquals(DeepLinkRoute.GradesList, controller.peekPending())
    }
}
