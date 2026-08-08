package com.gradethread.app.platform.deeplink

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
        // US-1354: the filter rides through to the inbox route, so a push about
        // one listing opens that listing's offers rather than the whole inbox.
        assertEquals(
            "negotiation?item=i1",
            DeepLinkRoute.NegotiationInbox("i1").toNavRoute(),
        )
        assertEquals("negotiation", DeepLinkRoute.NegotiationInbox(null).toNavRoute())
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
    fun supportReply_landsOnTheThread_notOnSettings() {
        // US-1386: this used to fall back to Settings, so a "support replied"
        // push dropped the seller on a preferences screen with no reply in
        // sight.
        assertEquals(
            "support/t7",
            DeepLinkRoute.SupportTickets("t7").toNavRoute(),
        )
        assertEquals("support", DeepLinkRoute.SupportTickets(null).toNavRoute())
        // A push with an empty ticket_id is the same as no ticket, not a route
        // to a thread called "".
        assertEquals("support", DeepLinkRoute.SupportTickets("  ").toNavRoute())
    }

    @Test
    fun shortcutLinks_parse() {
        // US-1381: its own host, not the widget's — the two grammars are edited
        // by different features and a shared one drifts.
        assertEquals(
            DeepLinkRoute.CaptureItem,
            DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://shortcut/capture")),
        )
        assertEquals(
            DeepLinkRoute.AddItem,
            DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://shortcut/add")),
        )
        assertEquals(
            DeepLinkRoute.SalesTab(null),
            DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://shortcut/money")),
        )
        assertNull(DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://shortcut/nope")))
        // The widget host does NOT answer for shortcut paths, or vice versa.
        assertNull(DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://widget/capture")))
        assertNull(DeepLinkRoute.fromUri(Uri.parse("com.gradethread.app://shortcut/shipping")))
    }

    @Test
    fun everyShortcutLink_thatShips_resolves() {
        // Every Uri in shortcuts.xml and in the dynamic spec, parsed back. A
        // typo in the XML is a long-press that opens nothing, with no crash to
        // notice it by.
        val uris = com.gradethread.app.platform.shortcuts.AppShortcuts.STATIC_URIS +
            com.gradethread.app.platform.shortcuts.AppShortcuts.soldTodaySpec(null).uri
        uris.forEach { assertNotNull(it, DeepLinkRoute.fromUri(Uri.parse(it))) }
    }

    @Test
    fun everyWidgetLink_theWidgetActuallyBuilds_resolves() {
        // US-1380: the widget builds these strings itself, in its own file. A
        // typo there is a tap that opens nothing, and there is no crash to
        // notice — so every value the widget can emit is parsed back here.
        com.gradethread.app.widget.WidgetDeepLink.entries.forEach { link ->
            assertNotNull(link.uri, DeepLinkRoute.fromUri(Uri.parse(link.uri)))
        }
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
            // US-1377. Was missing from this list entirely, so the shipping
            // deep link had no coverage here at all — the same drift as
            // "support" below, just invisible because an ABSENT route cannot
            // fail an exhaustiveness check that iterates a hand-written list.
            DeepLinkRoute.Shipping,
        )
        // The registered graph today (shell roots + capture + add + settings).
        //
        // ⚠ This is a HAND-COPIED mirror of AppShell's NavHost, which means
        // every feature that registers a destination has to remember to edit a
        // test file it never opened. US-1386 did not, and this test has been red
        // on main ever since while the support deep link worked perfectly —
        // AppShell.kt registers both `support` and `support/{ticketId}`.
        // Deriving this set from a shared route inventory would make the drift
        // impossible; until then, adding a composable() means adding it here.
        val registered = setOf(
            "home", "inventory", "add", "money", "marketplaces",
            "settings", "search", "tools",
            "capture/photos", "capture/details", "capture/autolister",
            // US-1335 / US-1341: the Tools hub's real destinations.
            "snap", "grades",
            // US-1354: the offers + messages inbox.
            "negotiation",
            // US-1386: the support inbox + thread.
            "support",
            // US-1377: shipping / fulfillment.
            "fulfillment",
        )
        for (route in routes) {
            // Compared on the PATH: an optional query argument (the inbox's
            // item filter) is part of the link, not part of the destination.
            assertTrue(
                "${route::class.simpleName} → ${route.toNavRoute()} is unregistered",
                route.toNavRoute().substringBefore("?") in registered,
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
