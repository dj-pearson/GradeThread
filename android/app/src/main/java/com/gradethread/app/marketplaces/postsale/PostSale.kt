package com.gradethread.app.marketplaces.postsale

import com.gradethread.app.sync.db.SaleEntity
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1357: what still needs doing after a sale.
 *
 * Fed entirely from the SYNCED `sales` rows — no extra fetch. The two questions
 * a seller has after something sells are "what do I still have to post?" and
 * "who haven't I left feedback for?", and both are answerable from data already
 * on the device.
 */
object PostSale {

    /**
     * Sales still waiting to be marked shipped.
     *
     * Cancelled and refunded orders are excluded: nothing is going in the post
     * for those, and listing them would send a seller looking for a parcel that
     * shouldn't exist. A sale with no eBay order id is excluded too — there is
     * nothing to mark shipped ON eBay, and the server would refuse it.
     */
    fun awaitingShipment(sales: List<SaleEntity>): List<SaleEntity> = sales
        .filter { it.shippedAt == null }
        .filter { it.status == "completed" || it.status == "pending" }
        .filter { !it.platformOrderId.isNullOrBlank() }
        .sortedBy { it.saleDate }

    /**
     * Shipped sales where feedback can still be left.
     *
     * We don't track locally whether feedback was already left — eBay owns that,
     * and it reports a duplicate as "already left" rather than an error. So this
     * offers the action and lets the server be the authority, instead of
     * guessing and hiding a buyer who is still waiting.
     */
    fun readyForFeedback(sales: List<SaleEntity>): List<SaleEntity> = sales
        .filter { it.shippedAt != null }
        .filter { it.status == "completed" }
        .filter { !it.buyerUsername.isNullOrBlank() }
        .sortedByDescending { it.shippedAt }

    /**
     * A tracking number, or null.
     *
     * Whitespace is stripped because carriers' apps and labels wrap them; a
     * blank is refused because the server requires one, and an empty POST would
     * come back as an error the seller can't act on.
     */
    fun trackingNumber(text: String): String? =
        text.filterNot { it.isWhitespace() }.takeIf { it.isNotEmpty() }

    fun carrier(text: String): String? = text.trim().takeIf { it.isNotEmpty() }

    /** What the feedback call reported. */
    fun feedbackMessage(response: FeedbackResponse, buyer: String?): String {
        val who = buyer?.takeIf { it.isNotBlank() } ?: "the buyer"
        return if (response.alreadyLeft) {
            "You'd already left feedback for $who."
        } else {
            "Feedback left for $who."
        }
    }
}

@Serializable
internal data class ShipRequest(
    @SerialName("tracking_number") val trackingNumber: String,
    val carrier: String? = null,
)

@Serializable
internal data class FeedbackRequest(
    @SerialName("buyer_username") val buyerUsername: String,
    @SerialName("order_id") val orderId: String? = null,
    val comment: String? = null,
)

@Serializable
data class FeedbackResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    @SerialName("already_left") val alreadyLeft: Boolean = false,
)
