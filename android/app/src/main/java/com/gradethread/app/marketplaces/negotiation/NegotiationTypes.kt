package com.gradethread.app.marketplaces.negotiation

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1354: the negotiation inbox's wire shapes.
 *
 * The offer and message payloads arrive from eBay through the edge in
 * camelCase already; only the capability probe is snake_case. Modelled as it
 * arrives rather than normalised, so the field names match what you'd see in a
 * network log.
 */

/** An incoming buyer best offer. */
@Serializable
data class BestOffer(
    val bestOfferId: String = "",
    val itemId: String = "",
    val itemTitle: String? = null,
    val buyerUsername: String? = null,
    val price: Double? = null,
    val currency: String = "USD",
    val quantity: Int? = null,
    val status: String? = null,
    /** The buyer's note attached to the offer. */
    val message: String? = null,
    val expiresAt: String? = null,
    /**
     * What the seller paid for the item, when a local row could be matched.
     * Null means unknown — the counter sheet then shows no margin rather than
     * implying the offer is all profit.
     */
    val itemCost: Double? = null,
)

/** A buyer member-message. */
@Serializable
data class BuyerMessage(
    val messageId: String = "",
    val itemId: String? = null,
    val senderUsername: String? = null,
    val subject: String? = null,
    val body: String? = null,
    val creationDate: String? = null,
    val answered: Boolean = false,
)

/**
 * Whether this connection can send offers to interested buyers.
 *
 * The `sell.negotiation` scope is not licensed on the production keyset, so
 * those endpoints answer 501 there. The inbox probes this BEFORE rendering an
 * entry point — a button that always fails is worse than no button.
 */
@Serializable
data class NegotiationCapability(
    @SerialName("send_offer_available") val sendOfferAvailable: Boolean = true,
    /**
     * `feature_unavailable` (nothing the seller can do) or `reconnect_required`
     * (a re-consent genuinely fixes it). Null when the feature works.
     */
    val code: String? = null,
    /** Server-authored copy for the disabled state. */
    val detail: String? = null,
) {
    val needsReconnect: Boolean get() = code == "reconnect_required"
}

/** A listing eligible for a seller-initiated offer to interested buyers. */
@Serializable
data class EligibleItem(
    val listingId: String = "",
    val title: String? = null,
    val price: Double? = null,
    val currency: String = "USD",
    val imageUrl: String? = null,
    val condition: String? = null,
    /** "local" | "browse" | "ebay" — "ebay" means only the bare id resolved. */
    val source: String? = null,
)

@Serializable
internal data class OffersResponse(val offers: List<BestOffer> = emptyList())

@Serializable
internal data class MessagesResponse(val messages: List<BuyerMessage> = emptyList())

@Serializable
internal data class EligibleResponse(val items: List<EligibleItem> = emptyList())

/** What the seller can do with an offer. The wire values eBay expects. */
enum class OfferAction(val wire: String) {
    ACCEPT("Accept"),
    COUNTER("Counter"),
    DECLINE("Decline"),
}
