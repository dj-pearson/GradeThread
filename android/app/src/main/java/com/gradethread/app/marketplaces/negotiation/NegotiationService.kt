package com.gradethread.app.marketplaces.negotiation

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1354: the edge client for eBay best offers, seller-initiated offers and
 * buyer messages.
 *
 * Every call resolves the caller's eBay token server-side, so there is no
 * cross-tenant surface here — the client never names an account.
 */
@Singleton
class NegotiationService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        private const val BASE = "/api/flipdesk/ebay"
        const val OFFERS_PATH = "$BASE/negotiation/offers"
        const val CAPABILITIES_PATH = "$BASE/negotiation/capabilities"
        const val ELIGIBLE_PATH = "$BASE/negotiation/eligible"
        const val SEND_OFFER_PATH = "$BASE/negotiation/send-offer"
        const val MESSAGES_PATH = "$BASE/messages"

        fun respondPath(bestOfferId: String) = "$OFFERS_PATH/$bestOfferId/respond"
        fun replyPath(messageId: String) = "$MESSAGES_PATH/$messageId/reply"
    }

    @Serializable
    private data class RespondRequest(
        @SerialName("item_id") val itemId: String,
        val action: String,
        @SerialName("counter_price") val counterPrice: Double? = null,
        val message: String? = null,
    )

    @Serializable
    private data class SendOfferRequest(
        @SerialName("listing_ids") val listingIds: List<String>,
        @SerialName("discount_percentage") val discountPercentage: String,
        val message: String? = null,
    )

    @Serializable
    private data class ReplyRequest(
        @SerialName("item_id") val itemId: String,
        @SerialName("recipient_id") val recipientId: String,
        val body: String,
    )

    suspend fun offers(): List<BestOffer> =
        edge.json.decodeFromString(OffersResponse.serializer(), edge.getRaw(OFFERS_PATH)).offers

    suspend fun messages(): List<BuyerMessage> =
        edge.json
            .decodeFromString(MessagesResponse.serializer(), edge.getRaw(MESSAGES_PATH))
            .messages

    /**
     * Cheap by design — the endpoint reads a scope list and a flag and never
     * calls eBay, so the inbox can probe it on every open.
     */
    suspend fun capability(): NegotiationCapability =
        edge.json.decodeFromString(
            NegotiationCapability.serializer(),
            edge.getRaw(CAPABILITIES_PATH),
        )

    suspend fun eligibleItems(): List<EligibleItem> =
        edge.json.decodeFromString(EligibleResponse.serializer(), edge.getRaw(ELIGIBLE_PATH)).items

    /**
     * Accept, counter or decline. [counterPrice] is required for a counter and
     * ignored otherwise — the server rejects a non-positive one.
     */
    suspend fun respond(
        bestOfferId: String,
        itemId: String,
        action: OfferAction,
        counterPrice: Double? = null,
        message: String? = null,
    ) {
        edge.postRaw(
            respondPath(bestOfferId),
            edge.json.encodeToString(
                RespondRequest.serializer(),
                RespondRequest(
                    itemId = itemId,
                    action = action.wire,
                    counterPrice = counterPrice.takeIf { action == OfferAction.COUNTER },
                    message = message?.trim()?.takeIf { it.isNotEmpty() },
                ),
            ),
        )
    }

    suspend fun sendOffer(listingIds: List<String>, discountPercent: Int, message: String? = null) {
        edge.postRaw(
            SEND_OFFER_PATH,
            edge.json.encodeToString(
                SendOfferRequest.serializer(),
                SendOfferRequest(
                    listingIds = listingIds,
                    discountPercentage = NegotiationRules.discountWire(discountPercent),
                    message = message?.trim()?.takeIf { it.isNotEmpty() },
                ),
            ),
        )
    }

    suspend fun reply(messageId: String, itemId: String, recipientId: String, body: String) {
        edge.postRaw(
            replyPath(messageId),
            edge.json.encodeToString(
                ReplyRequest.serializer(),
                ReplyRequest(itemId = itemId, recipientId = recipientId, body = body.trim()),
            ),
        )
    }

    /** User-facing copy for a failed call. */
    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Something went wrong talking to eBay."
}
