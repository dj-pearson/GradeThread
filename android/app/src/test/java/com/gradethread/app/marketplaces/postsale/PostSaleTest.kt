package com.gradethread.app.marketplaces.postsale

import com.gradethread.app.sync.db.SaleEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1357: what the post-sale surface puts in front of the seller.
 *
 * Both lists are derived from synced rows, so the filters ARE the feature: a
 * cancelled order in "to post" sends someone looking for a parcel that
 * shouldn't exist, and a shipped one left in the list invites a second label.
 */
class PostSaleTest {

    private fun sale(
        id: String,
        status: String = "completed",
        shippedAt: Long? = null,
        orderId: String? = "order-$id",
        buyer: String? = "buyer_$id",
        saleDate: Long = 1_000,
    ) = SaleEntity(
        id = id,
        inventoryItemId = "i1",
        listingId = null,
        salePrice = 40.0,
        platformFees = 5.0,
        paymentProcessingFees = null,
        shippingCollected = null,
        shippingCost = null,
        gradingCost = null,
        otherCosts = null,
        tax = null,
        netProfit = null,
        status = status,
        buyerUsername = buyer,
        platformOrderId = orderId,
        payoutReference = null,
        saleDate = saleDate,
        soldAt = saleDate,
        shippedAt = shippedAt,
        trackingNumber = null,
        createdAt = saleDate,
    )

    // ── to post ──────────────────────────────────────────────────────────────

    @Test
    fun `only unshipped orders are waiting to be posted`() {
        val sales = listOf(sale("a"), sale("b", shippedAt = 2_000))
        assertEquals(listOf("a"), PostSale.awaitingShipment(sales).map { it.id })
    }

    @Test
    fun `cancelled and refunded orders are not waiting to be posted`() {
        // Nothing is going in the post for those.
        val sales = listOf(
            sale("a"),
            sale("cancelled", status = "cancelled"),
            sale("refunded", status = "refunded"),
        )
        assertEquals(listOf("a"), PostSale.awaitingShipment(sales).map { it.id })
    }

    @Test
    fun `a pending order still needs posting`() {
        val sales = listOf(sale("p", status = "pending"))
        assertEquals(listOf("p"), PostSale.awaitingShipment(sales).map { it.id })
    }

    @Test
    fun `an order with no eBay id can't be marked shipped`() {
        // The server would refuse it, so offering the action would be a dead end.
        val sales = listOf(sale("a", orderId = null), sale("b"))
        assertEquals(listOf("b"), PostSale.awaitingShipment(sales).map { it.id })
    }

    @Test
    fun `oldest orders come first`() {
        // The one that has been waiting longest is the one to worry about.
        val sales = listOf(sale("new", saleDate = 5_000), sale("old", saleDate = 1_000))
        assertEquals(listOf("old", "new"), PostSale.awaitingShipment(sales).map { it.id })
    }

    // ── feedback ─────────────────────────────────────────────────────────────

    @Test
    fun `feedback is offered on shipped orders with a known buyer`() {
        val sales = listOf(
            sale("shipped", shippedAt = 2_000),
            sale("unshipped"),
            sale("anonymous", shippedAt = 2_000, buyer = null),
        )
        assertEquals(listOf("shipped"), PostSale.readyForFeedback(sales).map { it.id })
    }

    @Test
    fun `a refunded order is not a thank-you`() {
        val sales = listOf(sale("r", status = "refunded", shippedAt = 2_000))
        assertTrue(PostSale.readyForFeedback(sales).isEmpty())
    }

    @Test
    fun `already-left feedback is reported as such, not as an error`() {
        // eBay owns whether feedback exists; a duplicate is a no-op, not a failure.
        assertEquals(
            "You'd already left feedback for jane_doe.",
            PostSale.feedbackMessage(FeedbackResponse(ok = true, alreadyLeft = true), "jane_doe"),
        )
        assertEquals(
            "Feedback left for jane_doe.",
            PostSale.feedbackMessage(FeedbackResponse(ok = true, count = 1), "jane_doe"),
        )
    }

    // ── tracking ─────────────────────────────────────────────────────────────

    @Test
    fun `tracking numbers survive being pasted with spaces`() {
        // Labels and carrier apps wrap them; the seller shouldn't have to tidy up.
        assertEquals("1Z999AA10123456784", PostSale.trackingNumber(" 1Z999 AA10 1234 5678 4 "))
        assertNull(PostSale.trackingNumber("   "))
        assertNull(PostSale.trackingNumber(""))
    }

    @Test
    fun `a blank carrier is left off rather than sent empty`() {
        assertNull(PostSale.carrier("  "))
        assertEquals("USPS", PostSale.carrier(" USPS "))
    }
}
