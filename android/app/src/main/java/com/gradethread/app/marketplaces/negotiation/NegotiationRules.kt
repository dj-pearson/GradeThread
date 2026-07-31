package com.gradethread.app.marketplaces.negotiation

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.marketplaces.publish.ListingProfit

/**
 * US-1354: the inbox's decisions, as pure functions.
 *
 * Three of these carry real consequences — whether a send-offer button renders
 * at all, whether a counter is worth sending, and which offers a deep link is
 * claiming to show — so they live here and are tested, rather than being
 * scattered through a composable.
 */
object NegotiationRules {

    /**
     * Should the send-offer entry point render?
     *
     * Hidden only when the feature is UNFIXABLE — the deployment doesn't
     * license the scope, so no action the seller takes will help, and a button
     * there is a dead end. When a reconnect WOULD enable it, the entry stays so
     * the sheet can say so: that is the one case where "reconnect" is honest
     * rather than misleading.
     */
    fun showSendOfferEntry(capability: NegotiationCapability?): Boolean {
        val cap = capability ?: return true // unprobed: don't hide a working feature
        return cap.sendOfferAvailable || cap.needsReconnect
    }

    /** Offers for one item, for the deep-link filter (US-999). */
    fun offersForItem(offers: List<BestOffer>, itemId: String?): List<BestOffer> {
        val filter = itemId?.trim().orEmpty()
        if (filter.isEmpty()) return offers
        return offers.filter { it.itemId.equals(filter, ignoreCase = true) }
    }

    /** Messages for one item. A message with no item id can't match a filter. */
    fun messagesForItem(messages: List<BuyerMessage>, itemId: String?): List<BuyerMessage> {
        val filter = itemId?.trim().orEmpty()
        if (filter.isEmpty()) return messages
        return messages.filter { it.itemId?.equals(filter, ignoreCase = true) == true }
    }

    /**
     * Parse a typed counter price. Null when it isn't a positive amount —
     * the same refusal the composer applies, and for the same reason: a
     * silently-zeroed counter is an offer to give the item away.
     */
    fun counterPrice(text: String): Double? =
        CurrencyAmount.parseCents(text)?.takeIf { it > 0L }?.let { it / 100.0 }

    /**
     * What the seller keeps if the buyer takes a counter at [price].
     *
     * Reuses the composer's fee model so the inbox and the composer can't
     * disagree about the same listing. Null when the item's cost is unknown —
     * showing "100% margin" for an unknown cost basis would read as profit that
     * isn't there.
     */
    fun counterOutcome(price: Double, itemCost: Double?): ListingProfit? {
        if (itemCost == null) return null
        return ListingProfit.estimate(price = price, costBasis = itemCost)
    }

    /** True when a counter at this price leaves the seller under water. */
    fun losesMoney(price: Double, itemCost: Double?): Boolean =
        counterOutcome(price, itemCost)?.let { it.netCents < 0 } == true

    // ── send-offer ───────────────────────────────────────────────────────────

    /** eBay's own bounds for a seller-initiated discount, in whole percent. */
    const val MIN_DISCOUNT_PCT = 5
    const val MAX_DISCOUNT_PCT = 50
    const val DISCOUNT_STEP = 5

    /**
     * Snap a discount to a value eBay accepts. Out-of-range input clamps rather
     * than being rejected — the control is a slider, and the seller should not
     * be able to produce a number the server will refuse.
     */
    fun discountPercent(value: Int): Int {
        val stepped = (Math.round(value.toDouble() / DISCOUNT_STEP) * DISCOUNT_STEP).toInt()
        return stepped.coerceIn(MIN_DISCOUNT_PCT, MAX_DISCOUNT_PCT)
    }

    /** The wire value — a bare whole-percent string, as the endpoint expects. */
    fun discountWire(value: Int): String = discountPercent(value).toString()

    /**
     * A plain-language confirmation. Blasting a discount to every interested
     * buyer can't be undone, so the copy names the count and says so (US-1238).
     */
    fun sendOfferConfirmation(count: Int, discountPct: Int): String {
        val listings = if (count == 1) "1 listing" else "$count listings"
        return "This sends a ${discountPercent(discountPct)}% offer to interested buyers " +
            "on $listings. It can't be undone."
    }
}
