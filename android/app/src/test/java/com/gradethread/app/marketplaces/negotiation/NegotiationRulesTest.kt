package com.gradethread.app.marketplaces.negotiation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1354: the negotiation inbox's decisions.
 *
 * The capability gate is the one with teeth: the `sell.negotiation` scope is
 * not licensed on the production keyset, so a send-offer button that renders
 * anyway is a button that always fails — and telling a seller to "reconnect"
 * when reconnecting cannot help is worse than saying nothing.
 */
class NegotiationRulesTest {

    // ── send-offer capability gate ───────────────────────────────────────────

    @Test
    fun `an unprobed capability keeps the entry point visible`() {
        // Hiding a working feature because a probe hasn't answered yet is the
        // worse error; the send path gates on its own 501 regardless.
        assertTrue(NegotiationRules.showSendOfferEntry(null))
    }

    @Test
    fun `an available capability shows the entry point`() {
        assertTrue(
            NegotiationRules.showSendOfferEntry(
                NegotiationCapability(sendOfferAvailable = true),
            ),
        )
    }

    @Test
    fun `an unfixable capability hides the entry point entirely`() {
        // The deployment doesn't license the scope. Nothing the seller does will
        // help, so the button is a dead end.
        assertFalse(
            NegotiationRules.showSendOfferEntry(
                NegotiationCapability(
                    sendOfferAvailable = false,
                    code = "feature_unavailable",
                    detail = "Sending offers isn't available yet.",
                ),
            ),
        )
    }

    @Test
    fun `a reconnectable capability keeps the entry so the sheet can say so`() {
        val cap = NegotiationCapability(
            sendOfferAvailable = false,
            code = "reconnect_required",
            detail = "Your eBay authorization predates the send-offers permission.",
        )
        assertTrue(NegotiationRules.showSendOfferEntry(cap))
        assertTrue(cap.needsReconnect)
    }

    // ── deep-link filter (US-999) ────────────────────────────────────────────

    private fun offer(id: String, itemId: String) =
        BestOffer(bestOfferId = id, itemId = itemId)

    @Test
    fun `no filter shows everything`() {
        val offers = listOf(offer("o1", "i1"), offer("o2", "i2"))
        assertEquals(offers, NegotiationRules.offersForItem(offers, null))
        assertEquals(offers, NegotiationRules.offersForItem(offers, "   "))
    }

    @Test
    fun `a filter narrows to one listing`() {
        val offers = listOf(offer("o1", "i1"), offer("o2", "i2"))
        assertEquals(listOf("o1"), NegotiationRules.offersForItem(offers, "i1").map { it.bestOfferId })
    }

    @Test
    fun `a message with no item id cannot match a filter`() {
        // It would otherwise silently appear under every listing's inbox.
        val messages = listOf(
            BuyerMessage(messageId = "m1", itemId = "i1"),
            BuyerMessage(messageId = "m2", itemId = null),
        )
        assertEquals(listOf("m1"), NegotiationRules.messagesForItem(messages, "i1").map { it.messageId })
    }

    // ── counters ─────────────────────────────────────────────────────────────

    @Test
    fun `a counter price must be a positive amount`() {
        assertNull(NegotiationRules.counterPrice(""))
        assertNull(NegotiationRules.counterPrice("0"))
        assertNull(NegotiationRules.counterPrice("-5"))
        assertEquals(42.5, NegotiationRules.counterPrice("\$42.50")!!, 1e-9)
    }

    @Test
    fun `an unknown cost basis shows no margin rather than a flattering one`() {
        assertNull(NegotiationRules.counterOutcome(50.0, itemCost = null))
        assertFalse(NegotiationRules.losesMoney(50.0, itemCost = null))
    }

    @Test
    fun `a counter below break-even is flagged`() {
        // 20 - (20*0.1325 + 0.40) - 25 is well under water.
        assertTrue(NegotiationRules.losesMoney(20.0, itemCost = 25.0))
        assertFalse(NegotiationRules.losesMoney(60.0, itemCost = 25.0))
    }

    @Test
    fun `the counter outcome uses the same fee model as the composer`() {
        val outcome = NegotiationRules.counterOutcome(100.0, itemCost = 20.0)!!
        assertEquals(66.35, outcome.net, 1e-9)
    }

    // ── send-offer discount ──────────────────────────────────────────────────

    @Test
    fun `a discount snaps to a value eBay accepts`() {
        assertEquals(10, NegotiationRules.discountPercent(11))
        assertEquals(15, NegotiationRules.discountPercent(13))
        assertEquals(5, NegotiationRules.discountPercent(1))
        assertEquals(50, NegotiationRules.discountPercent(500))
        assertEquals("20", NegotiationRules.discountWire(20))
    }

    @Test
    fun `the confirmation names the count and says it is final`() {
        assertEquals(
            "This sends a 10% offer to interested buyers on 1 listing. It can't be undone.",
            NegotiationRules.sendOfferConfirmation(1, 10),
        )
        assertTrue(
            NegotiationRules.sendOfferConfirmation(7, 25).contains("7 listings"),
        )
    }
}
