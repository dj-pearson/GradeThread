package com.gradethread.app.platform.push

import com.gradethread.app.platform.deeplink.DeepLinkRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1378: the wire contract, the routing, and the inline actions.
 *
 * Every string in here is matched against something a server already sent or a
 * button an installed app already shows, so the tests exist mostly to stop a
 * tidy-up renaming one.
 */
class PushRoutingTest {

    // ── The wire contract ────────────────────────────────────────────────────

    @Test
    fun `category ids match what the server stamps`() {
        // Renaming one silently stops routing every notification of that kind.
        assertEquals(
            listOf(
                "sale.created",
                "payout.cleared",
                "payout.posted",
                "token.expiring",
                "item.review_needed",
                "grade.ready",
                "offer.received",
                "message.received",
                "listing.ended",
                "aging.digest",
                "support.reply",
            ),
            PushCategory.entries.map { it.id },
        )
    }

    @Test
    fun `action ids match the buttons already installed apps show`() {
        assertEquals(
            listOf("offer.accept", "offer.counter", "order.mark_shipped", "ebay.reconnect"),
            PushAction.entries.map { it.id },
        )
    }

    @Test
    fun `an unknown category resolves to nothing rather than a wrong one`() {
        assertNull(PushCategory.of("something.new"))
        assertNull(PushCategory.of(null))
        assertNull(PushAction.of("offer.decline"))
    }

    // ── Channels ─────────────────────────────────────────────────────────────

    @Test
    fun `only the connection channel cuts through do not disturb`() {
        // An expired eBay token stops sync, listings and orders dead, and the
        // window to fix it is days. Everything else can wait for morning.
        assertEquals(PushChannel.URGENT, PushCategory.TOKEN_EXPIRING.channel)
        assertTrue(PushChannel.URGENT.bypassDnd)
        assertTrue(PushChannel.entries.filter { it.bypassDnd }.size == 1)
    }

    @Test
    fun `the urgent channel is high importance`() {
        assertEquals(IMPORTANCE_HIGH, PushChannel.URGENT.importance)
        assertEquals(IMPORTANCE_HIGH, PushChannel.MONEY.importance)
        // The digest shouldn't buzz.
        assertEquals(IMPORTANCE_LOW, PushChannel.UPDATES.importance)
    }

    @Test
    fun `every category has a channel and none is left over`() {
        PushCategory.entries.forEach { category ->
            assertTrue(category.id, PushChannel.entries.contains(category.channel))
        }
        val used = PushCategory.entries.map { it.channel }.toSet()
        assertEquals(PushChannel.entries.toSet(), used)
    }

    // ── Buttons ──────────────────────────────────────────────────────────────

    @Test
    fun `only categories whose action actually works get a button`() {
        // A button that does nothing is worse than none, because the seller
        // believes they have dealt with it.
        assertEquals(
            listOf(PushAction.ACCEPT_OFFER, PushAction.COUNTER_OFFER),
            PushCategory.OFFER_RECEIVED.actions,
        )
        assertEquals(listOf(PushAction.MARK_SHIPPED), PushCategory.SALE_CREATED.actions)
        assertEquals(listOf(PushAction.RECONNECT_EBAY), PushCategory.TOKEN_EXPIRING.actions)
        assertTrue(PushCategory.AGING_DIGEST.actions.isEmpty())
        assertTrue(PushCategory.GRADE_READY.actions.isEmpty())
    }

    @Test
    fun `only the two that need typing take input`() {
        assertTrue(PushAction.COUNTER_OFFER.takesInput)
        assertTrue(PushAction.MARK_SHIPPED.takesInput)
        assertFalse(PushAction.ACCEPT_OFFER.takesInput)
        assertFalse(PushAction.RECONNECT_EBAY.takesInput)
    }

    @Test
    fun `only reconnect has to open the app`() {
        // OAuth needs a browser and a person. Everything else runs in the
        // background so the seller never leaves their lock screen.
        assertTrue(PushAction.RECONNECT_EBAY.opensApp)
        assertFalse(PushAction.MARK_SHIPPED.opensApp)
        assertFalse(PushAction.ACCEPT_OFFER.opensApp)
    }

    // ── Tap routing ──────────────────────────────────────────────────────────

    @Test
    fun `a sale lands on the shipping queue, not a generic tab`() {
        // The next thing after "you made a sale" is posting it.
        assertEquals(DeepLinkRoute.Shipping, PushCategory.SALE_CREATED.route(emptyMap()))
    }

    @Test
    fun `an offer opens the inbox filtered to its item`() {
        assertEquals(
            DeepLinkRoute.NegotiationInbox("i1"),
            PushCategory.OFFER_RECEIVED.route(mapOf("inventory_item_id" to "i1")),
        )
        // Without an id it still opens the inbox rather than nowhere.
        assertEquals(
            DeepLinkRoute.NegotiationInbox(null),
            PushCategory.OFFER_RECEIVED.route(emptyMap()),
        )
    }

    @Test
    fun `a grade opens the item when it names one`() {
        assertEquals(
            DeepLinkRoute.InventoryItem("i1"),
            PushCategory.GRADE_READY.route(mapOf("inventory_item_id" to "i1")),
        )
        assertEquals(DeepLinkRoute.GradesList, PushCategory.GRADE_READY.route(emptyMap()))
    }

    @Test
    fun `a blank id is treated as no id`() {
        assertEquals(
            DeepLinkRoute.GradesList,
            PushCategory.GRADE_READY.route(mapOf("inventory_item_id" to "  ")),
        )
    }

    @Test
    fun `an expiring token lands on the reconnect flow`() {
        assertEquals(DeepLinkRoute.ReconnectEbay, PushCategory.TOKEN_EXPIRING.route(emptyMap()))
    }

    @Test
    fun `every route round-trips through the app-link parser`() {
        // The push tap travels as the SAME link an email or widget uses. If a
        // route can't be expressed as one, the tap goes to the wrong screen.
        val routes = listOf(
            DeepLinkRoute.Shipping,
            DeepLinkRoute.InventoryTab,
            DeepLinkRoute.GradesList,
            DeepLinkRoute.ReconnectEbay,
            DeepLinkRoute.MarketplacesTab,
            DeepLinkRoute.InventoryItem("abc"),
            DeepLinkRoute.NegotiationInbox("i1"),
            DeepLinkRoute.NegotiationInbox(null),
            DeepLinkRoute.SalesTab("s1"),
            DeepLinkRoute.SalesTab(null),
            DeepLinkRoute.SupportTickets("t1"),
            DeepLinkRoute.SupportTickets(null),
            DeepLinkRoute.CaptureItem,
            DeepLinkRoute.AddItem,
        )
        routes.forEach { route ->
            assertTrue(route.toString(), route.toDeepLinkUri().startsWith("https://gradethread.com/app/"))
        }
    }

    // ── Parsing a payload ────────────────────────────────────────────────────

    @Test
    fun `the notification block wins over the data map`() {
        val message = PushMessage.of(
            data = mapOf("category" to "sale.created", "title" to "from data"),
            notificationTitle = "from notification",
            notificationBody = "You sold something",
        )
        assertEquals("from notification", message.title)
        assertEquals(PushCategory.SALE_CREATED, message.category)
    }

    @Test
    fun `a data-only push still renders`() {
        val message = PushMessage.of(
            data = mapOf("category" to "grade.ready", "title" to "Grade ready", "body" to "9.2"),
            notificationTitle = null,
            notificationBody = null,
        )
        assertEquals("Grade ready", message.title)
        assertEquals("9.2", message.body)
        assertTrue(message.renderable)
    }

    @Test
    fun `an unknown category still shows, just without buttons`() {
        // The server can add a category before the app ships its handling.
        // Swallowing those would hide real news.
        val message = PushMessage.of(
            data = mapOf("category" to "brand.new"),
            notificationTitle = "Something happened",
            notificationBody = "Have a look",
        )
        assertNull(message.category)
        assertTrue(message.renderable)
        assertTrue(message.actions.isEmpty())
        assertEquals(PushChannel.UPDATES, message.channel)
        assertNull(message.route)
    }

    @Test
    fun `a categoryless notice naming an item still opens that item`() {
        // US-1379: local sale/grade alerts carry no server category, and the
        // whole point of one is landing on the item it is about.
        val message = PushMessage.of(
            data = mapOf("inventory_item_id" to "i1"),
            notificationTitle = "You made a sale",
            notificationBody = "42.00 to flipfan",
        )
        assertNull(message.category)
        assertEquals(DeepLinkRoute.InventoryItem("i1"), message.route)
    }

    @Test
    fun `an empty push is not rendered`() {
        val message = PushMessage.of(emptyMap(), null, null)
        assertFalse(message.renderable)
    }

    @Test
    fun `the collapse id becomes the tag`() {
        val message = PushMessage.of(mapOf("collapse_id" to "payout-7"), "a", "b")
        assertEquals("payout-7", message.tag)
        assertNull(PushMessage.of(mapOf("collapse_id" to " "), "a", "b").tag)
    }

    // ── Action plans ─────────────────────────────────────────────────────────

    @Test
    fun `accept needs both ids or it opens the inbox instead`() {
        val full = PushActionPlan.of(
            "offer.accept",
            mapOf("best_offer_id" to "o1", "inventory_item_id" to "i1"),
            null,
        )
        assertEquals(PushActionPlan.AcceptOffer("o1", "i1"), full)

        // A half-formed edge call would fail silently on a lock screen. Opening
        // the inbox lets the seller finish it.
        val partial = PushActionPlan.of("offer.accept", mapOf("inventory_item_id" to "i1"), null)
        assertEquals(PushActionPlan.Open(DeepLinkRoute.NegotiationInbox("i1")), partial)
    }

    @Test
    fun `a counter with no typed price never sends a guess`() {
        val data = mapOf("best_offer_id" to "o1", "inventory_item_id" to "i1")
        assertEquals(
            PushActionPlan.Open(DeepLinkRoute.NegotiationInbox("i1")),
            PushActionPlan.of("offer.counter", data, null),
        )
        assertEquals(
            PushActionPlan.Open(DeepLinkRoute.NegotiationInbox("i1")),
            PushActionPlan.of("offer.counter", data, "not a price"),
        )
        assertEquals(
            PushActionPlan.Open(DeepLinkRoute.NegotiationInbox("i1")),
            PushActionPlan.of("offer.counter", data, "0"),
        )
    }

    @Test
    fun `a typed counter price parses through the money parser`() {
        val data = mapOf("best_offer_id" to "o1", "inventory_item_id" to "i1")
        assertEquals(
            PushActionPlan.CounterOffer("o1", "i1", 42.5),
            PushActionPlan.of("offer.counter", data, "$42.50"),
        )
    }

    @Test
    fun `mark shipped works with or without tracking`() {
        assertEquals(
            PushActionPlan.MarkShipped("s1", "1Z999"),
            PushActionPlan.of("order.mark_shipped", mapOf("sale_id" to "s1"), " 1Z 999 "),
        )
        assertEquals(
            PushActionPlan.MarkShipped("s1", null),
            PushActionPlan.of("order.mark_shipped", mapOf("sale_id" to "s1"), "   "),
        )
    }

    @Test
    fun `mark shipped with no sale id opens the queue`() {
        assertEquals(
            PushActionPlan.Open(DeepLinkRoute.Shipping),
            PushActionPlan.of("order.mark_shipped", emptyMap(), "1Z999"),
        )
    }

    @Test
    fun `reconnect always foregrounds`() {
        assertEquals(PushActionPlan.Reconnect, PushActionPlan.of("ebay.reconnect", emptyMap(), null))
    }

    @Test
    fun `an unrecognized action does nothing at all`() {
        assertEquals(PushActionPlan.None, PushActionPlan.of("offer.decline", emptyMap(), null))
        assertEquals(PushActionPlan.None, PushActionPlan.of(null, emptyMap(), null))
    }

    // ── Permission timing ────────────────────────────────────────────────────

    @Test
    fun `we never ask twice, and never for a build with no push`() {
        // Android auto-denies the second dialog, so a wasted ask is permanent.
        assertFalse(PushPermission.shouldAsk(granted = true, pushConfigured = true, alreadyAsked = false))
        assertFalse(PushPermission.shouldAsk(granted = false, pushConfigured = false, alreadyAsked = false))
        assertFalse(PushPermission.shouldAsk(granted = false, pushConfigured = true, alreadyAsked = true))
        assertEquals(
            PushPermission.required,
            PushPermission.shouldAsk(granted = false, pushConfigured = true, alreadyAsked = false),
        )
    }

    // US-2792: `every ask moment says what the seller gets` was here. It
    // asserted that three rationale strings were non-blank — a test of copy
    // for a prompt nothing could show. Removed with the enum.
}
