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

        // US-2409: the three cases with a clock on them.
        const val RETURNS_PATH = "/api/flipdesk/ebay/returns"
        const val CANCELLATIONS_PATH = "/api/flipdesk/ebay/cancellations"
        const val DISPUTES_PATH = "/api/flipdesk/ebay/payment-disputes"
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

    // ── US-2409: returns, cancellations and payment disputes ─────────────

    suspend fun returns(): List<EbayReturn> = edge.json.decodeFromString(
        EbayReturnList.serializer(),
        edge.getRaw(RETURNS_PATH),
    ).returns

    /**
     * Approve or decline a return.
     *
     * [orderId] is passed through even though the edge always sends null for
     * returns — the field is the server's, and hardcoding a null here would
     * hide the day the edge starts populating it.
     */
    suspend fun decideReturn(returnId: String, decision: String, orderId: String? = null) {
        edge.postRaw(
            "$RETURNS_PATH/$returnId/decide",
            edge.json.encodeToString(
                DecideReturnRequest.serializer(),
                DecideReturnRequest(decision = decision, orderId = orderId),
            ),
        )
    }

    /** eBay's return refund carries no amount — it is always the full one. */
    suspend fun refundReturn(returnId: String, orderId: String? = null) {
        edge.postRaw("$RETURNS_PATH/$returnId/refund", orderIdBody(orderId))
    }

    suspend fun cancellations(): List<EbayCancellation> = edge.json.decodeFromString(
        EbayCancellationList.serializer(),
        edge.getRaw(CANCELLATIONS_PATH),
    ).cancellations

    /** [action] is `approve` or `reject`; it is part of the path, not the body. */
    suspend fun decideCancellation(cancelId: String, action: String, orderId: String? = null) {
        edge.postRaw("$CANCELLATIONS_PATH/$cancelId/$action", orderIdBody(orderId))
    }

    suspend fun disputes(): List<EbayPaymentDispute> = edge.json.decodeFromString(
        EbayPaymentDisputeList.serializer(),
        edge.getRaw(DISPUTES_PATH),
    ).disputes

    /**
     * Accept or contest a payment dispute.
     *
     * The server re-reads the dispute first and answers `alreadyResolved` when
     * eBay has already settled it, rather than pushing an action eBay would
     * reject. The caller shows that as a fact, not as a failure.
     */
    suspend fun resolveDispute(
        disputeId: String,
        action: String,
        note: String? = null,
        orderId: String? = null,
    ): DisputeActionResponse = edge.json.decodeFromString(
        DisputeActionResponse.serializer(),
        edge.postRaw(
            "$DISPUTES_PATH/$disputeId/$action",
            if (action == "contest") {
                edge.json.encodeToString(
                    ContestRequest.serializer(),
                    ContestRequest(note = note, orderId = orderId),
                )
            } else {
                orderIdBody(orderId)
            },
        ),
    )

    /**
     * Attach proof to a dispute.
     *
     * Multipart, and NEVER retried automatically: the server does a two-step
     * upload-then-attach, so a blind retry can leave eBay holding the same
     * photo twice. The caller keeps a failed upload and offers the retry.
     */
    suspend fun addDisputeEvidence(
        disputeId: String,
        image: ByteArray,
        fileName: String,
        evidenceType: String? = null,
    ): EvidenceResponse = edge.json.decodeFromString(
        EvidenceResponse.serializer(),
        edge.postMultipartImage(
            path = "$DISPUTES_PATH/$disputeId/evidence",
            fieldName = "file",
            fileName = fileName,
            mimeType = "image/jpeg",
            bytes = image,
            fields = evidenceType?.let { mapOf("evidence_type" to it) } ?: emptyMap(),
        ),
    )

    private fun orderIdBody(orderId: String?): String =
        edge.json.encodeToString(OrderIdRequest.serializer(), OrderIdRequest(orderId))

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "eBay wouldn't accept that."
}
