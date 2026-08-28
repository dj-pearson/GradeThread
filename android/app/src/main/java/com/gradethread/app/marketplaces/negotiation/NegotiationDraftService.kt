package com.gradethread.app.marketplaces.negotiation

import com.gradethread.app.inventory.ListingCopyService
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2494: `POST /api/flipdesk/ai/negotiate`.
 *
 * Two things in one round trip: a pure counter-offer guardrail (the suggested
 * price and the warnings, computed from the buyer's offer, the item's asking
 * price and its cost) and an LLM-written note to the buyer.
 *
 * **It spends one AI action**, reserved atomically and refunded when the model
 * call fails, so it is never automatic — the seller asks for it.
 *
 * Nothing here touches eBay, so it works on an account with no eBay connection
 * at all. It is not one of the US-1421 scope-gated endpoints.
 */
@Serializable
data class NegotiationDraft(
    /** The buyer-facing note. May be blank when the model had nothing. */
    val message: String = "",
    /**
     * A counter that is never at or below the buyer's offer and never below
     * cost. Null when there is no offer price to reason from.
     */
    @SerialName("suggested_counter") val suggestedCounter: Double? = null,
    /** Server-authored cautions, already in plain language. */
    val warnings: List<String> = emptyList(),
    @SerialName("below_cost") val belowCost: Boolean = false,
    @SerialName("at_or_below_offer") val atOrBelowOffer: Boolean = false,
    @SerialName("above_asking") val aboveAsking: Boolean = false,
    /** -1 means unlimited. What is LEFT after this call, not before it. */
    @SerialName("actions_remaining") val actionsRemaining: Int = 0,
)

/** Which draft the seller asked for. The wire values the route expects. */
enum class NegotiationDraftMode(val wire: String) {
    COUNTER("counter"),
    REPLY("reply"),
}

@Singleton
class NegotiationDraftService @Inject constructor(
    /**
     * The long-idle profile. This is an Anthropic round trip, and the 20s
     * shared cap would cut a draft the seller is waiting on.
     */
    @Named("ai") private val edge: EdgeApi,
) {

    /**
     * [itemId] is an `inventory_items` id, NOT the eBay item id the offer
     * carries. The two are different keys, and the server answers 404 for
     * anything the caller does not own, so the caller resolves the FlipDesk
     * item first rather than posting whatever id it happens to have.
     */
    suspend fun draft(
        itemId: String,
        mode: NegotiationDraftMode,
        offerPrice: Double? = null,
        currency: String = "USD",
        buyerMessage: String? = null,
        proposedCounter: Double? = null,
    ): NegotiationDraft = try {
        json.decodeFromString(
            NegotiationDraft.serializer(),
            edge.postRaw(
                PATH,
                json.encodeToString(
                    DraftRequest.serializer(),
                    DraftRequest(
                        itemId = itemId,
                        mode = mode.wire,
                        offerPrice = offerPrice,
                        currency = currency,
                        buyerMessage = buyerMessage?.trim()?.takeIf { it.isNotEmpty() },
                        proposedCounter = proposedCounter,
                    ),
                ),
            ),
        )
    } catch (error: EdgeApiError) {
        throw error
    } catch (t: Throwable) {
        throw EdgeApiError.Decoding(t.message ?: "unreadable negotiation draft", t)
    }

    companion object {
        const val PATH = "/api/flipdesk/ai/negotiate"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * The quota, unsynced-item and AI-down statuses are the same ones the
         * listing-copy calls hit, so they get the same words. A second mapping
         * here would drift from that one the first time either message changed.
         */
        fun message(error: Throwable): String = ListingCopyService.message(error)
    }

    @Serializable
    private data class DraftRequest(
        @SerialName("item_id") val itemId: String,
        val mode: String,
        @SerialName("offer_price") val offerPrice: Double? = null,
        val currency: String = "USD",
        @SerialName("buyer_message") val buyerMessage: String? = null,
        @SerialName("proposed_counter") val proposedCounter: Double? = null,
    )
}
