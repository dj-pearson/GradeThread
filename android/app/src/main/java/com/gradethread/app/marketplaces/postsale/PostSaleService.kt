package com.gradethread.app.marketplaces.postsale

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1357: the two post-sale actions that leave the device — telling eBay a
 * parcel is on its way, and leaving the buyer feedback.
 */
@Singleton
class PostSaleService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        fun shipPath(saleId: String) = "/api/flipdesk/ebay/orders/$saleId/ship"
        const val FEEDBACK_PATH = "/api/flipdesk/ebay/feedback"
    }

    /**
     * Mark the order shipped with its tracking number.
     *
     * Idempotent server-side: re-sending the same tracking for an already-shipped
     * sale re-asserts local state rather than failing, so a retry after a lost
     * response is safe.
     */
    suspend fun markShipped(saleId: String, trackingNumber: String, carrier: String? = null) {
        edge.postRaw(
            shipPath(saleId),
            edge.json.encodeToString(
                ShipRequest.serializer(),
                ShipRequest(trackingNumber, carrier),
            ),
        )
    }

    /**
     * Leave the buyer positive feedback. Sellers can only leave positive
     * feedback on eBay, so there is no rating to choose — only the note.
     */
    suspend fun leaveFeedback(
        buyerUsername: String,
        orderId: String?,
        comment: String? = null,
    ): FeedbackResponse = edge.json.decodeFromString(
        FeedbackResponse.serializer(),
        edge.postRaw(
            FEEDBACK_PATH,
            edge.json.encodeToString(
                FeedbackRequest.serializer(),
                FeedbackRequest(buyerUsername, orderId, comment?.trim()?.takeIf { it.isNotEmpty() }),
            ),
        ),
    )

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "eBay wouldn't accept that."
}
