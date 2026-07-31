package com.gradethread.app.platform.push

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.platform.deeplink.DeepLinkRoute

/**
 * US-1378: one push, parsed.
 *
 * FCM data values are always strings on the wire — the edge stringifies
 * anything non-string before sending — so everything here parses from text and
 * refuses rather than guesses when it can't.
 */
data class PushMessage(
    val category: PushCategory?,
    val title: String,
    val body: String,
    val data: Map<String, String>,
    /** Collapse key, so a second payout push replaces the first. */
    val tag: String?,
) {
    val channel: PushChannel get() = category?.channel ?: PushChannel.UPDATES

    val actions: List<PushAction> get() = category?.actions.orEmpty()

    val route: DeepLinkRoute? get() = category?.route(data)

    /**
     * A push we can't classify still shows.
     *
     * The server can add a category before the app ships its handling, and
     * swallowing those would hide real news — the seller just gets a plain
     * notification with no buttons instead of nothing at all.
     */
    val renderable: Boolean get() = title.isNotBlank() || body.isNotBlank()

    companion object {
        fun of(
            data: Map<String, String>,
            notificationTitle: String?,
            notificationBody: String?,
        ): PushMessage = PushMessage(
            category = PushCategory.of(data["category"]),
            // The notification block wins; the data map is the fallback for a
            // data-only send.
            title = notificationTitle?.takeIf { it.isNotBlank() }
                ?: data["title"].orEmpty(),
            body = notificationBody?.takeIf { it.isNotBlank() }
                ?: data["body"].orEmpty(),
            data = data,
            tag = data["collapse_id"]?.takeIf { it.isNotBlank() },
        )
    }
}

/**
 * What an inline button tap means (iOS `NotificationActionPlan`).
 *
 * Pure, and that matters: these run without the app on screen, so there is no
 * way to see them go wrong. Every branch either has the ids it needs or falls
 * back to OPENING the relevant screen — never fires a half-formed edge call.
 */
sealed class PushActionPlan {
    data class AcceptOffer(val bestOfferId: String, val itemId: String) : PushActionPlan()

    data class CounterOffer(
        val bestOfferId: String,
        val itemId: String,
        val price: Double,
    ) : PushActionPlan()

    data class MarkShipped(val saleId: String, val tracking: String?) : PushActionPlan()

    /** OAuth needs a browser and a person; foreground the app. */
    object Reconnect : PushActionPlan()

    /** The ids weren't in the payload — open the screen instead. */
    data class Open(val route: DeepLinkRoute) : PushActionPlan()

    object None : PushActionPlan()

    companion object {
        fun of(
            actionId: String?,
            data: Map<String, String>,
            typedText: String?,
        ): PushActionPlan {
            val action = PushAction.of(actionId) ?: return None
            val itemId = data["inventory_item_id"]?.takeIf { it.isNotBlank() }
            val bestOfferId = data["best_offer_id"]?.takeIf { it.isNotBlank() }
            val saleId = data["sale_id"]?.takeIf { it.isNotBlank() }

            return when (action) {
                PushAction.ACCEPT_OFFER ->
                    if (bestOfferId != null && itemId != null) {
                        AcceptOffer(bestOfferId, itemId)
                    } else {
                        Open(DeepLinkRoute.NegotiationInbox(itemId))
                    }

                PushAction.COUNTER_OFFER -> {
                    val price = parsePrice(typedText)
                    if (bestOfferId != null && itemId != null && price != null && price > 0) {
                        CounterOffer(bestOfferId, itemId, price)
                    } else {
                        // A counter with no price, or an unparseable one, opens
                        // the inbox. Sending a guess would put a real number in
                        // front of a real buyer.
                        Open(DeepLinkRoute.NegotiationInbox(itemId))
                    }
                }

                PushAction.MARK_SHIPPED ->
                    if (saleId != null) {
                        MarkShipped(saleId, tracking(typedText))
                    } else {
                        Open(DeepLinkRoute.Shipping)
                    }

                PushAction.RECONNECT_EBAY -> Reconnect
            }
        }

        /**
         * A typed counter price.
         *
         * Through [CurrencyAmount], which is locale-aware: a digits-and-dots
         * filter reads "42,50" in a comma-decimal locale as 4250 and pushes a
         * hundredfold counter to a live buyer. That happened on iOS (US-1491).
         */
        fun parsePrice(text: String?): Double? =
            CurrencyAmount.parseCents(text)?.takeIf { it > 0 }?.let { it / 100.0 }

        /** Whitespace stripped, blank refused — the same rule as the ship queue. */
        fun tracking(text: String?): String? =
            text?.filterNot { it.isWhitespace() }?.takeIf { it.isNotEmpty() }
    }
}
