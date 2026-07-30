package com.gradethread.app.billing

import com.gradethread.app.platform.net.EdgeApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1366: the decisions that cost money when they're wrong.
 */
class PlayPurchaseRulesTest {

    private fun purchase(
        productId: String,
        state: PlayPurchaseState = PlayPurchaseState.PURCHASED,
        acknowledged: Boolean = false,
    ) = PlayPurchase(
        productIds = listOf(productId),
        purchaseToken = "token-$productId",
        state = state,
        acknowledged = acknowledged,
    )

    @Test
    fun `credit packs are consumed and subscriptions are acknowledged`() {
        // Getting this backwards is not a cosmetic bug: consuming a
        // subscription cancels it, and an unacknowledged one is auto-refunded
        // by Play after three days.
        assertEquals(
            PlayPurchaseRules.Settlement.CONSUME,
            PlayPurchaseRules.settlement(purchase("credits_25")),
        )
        assertEquals(
            PlayPurchaseRules.Settlement.ACKNOWLEDGE,
            PlayPurchaseRules.settlement(purchase("flipdesk_pro_monthly")),
        )
    }

    @Test
    fun `an already acknowledged subscription is left alone`() {
        assertEquals(
            PlayPurchaseRules.Settlement.NONE,
            PlayPurchaseRules.settlement(
                purchase("flipdesk_pro_yearly", acknowledged = true),
            ),
        )
    }

    @Test
    fun `a consumable is consumed even if Play already acknowledged it`() {
        // Acknowledgement says nothing about a consumable's re-buyability, and
        // skipping the consume would leave the buyer unable to purchase again.
        assertEquals(
            PlayPurchaseRules.Settlement.CONSUME,
            PlayPurchaseRules.settlement(purchase("credits_10", acknowledged = true)),
        )
    }

    @Test
    fun `an unknown product is never settled`() {
        // Play delivers purchases we didn't start - another device, a promo
        // code, a product from a future release. Consuming one we can't classify
        // would destroy a token the server might still want.
        assertEquals(
            PlayPurchaseRules.Settlement.NONE,
            PlayPurchaseRules.settlement(purchase("flipdesk_enterprise_monthly")),
        )
        assertNull(PlayPurchaseRules.productType("flipdesk_enterprise_monthly"))
    }

    @Test
    fun `pending purchases are not redeemable`() {
        // Play's cash-at-a-kiosk flow. Nothing has been paid, so verifying just
        // produces a failure the buyer can do nothing about.
        assertFalse(
            PlayPurchaseRules.redeemable(
                purchase("credits_25", state = PlayPurchaseState.PENDING),
            ),
        )
        assertTrue(PlayPurchaseRules.redeemable(purchase("credits_25")))
    }

    @Test
    fun `a purchase with no product id is not redeemable`() {
        assertFalse(
            PlayPurchaseRules.redeemable(
                PlayPurchase(emptyList(), "token", PlayPurchaseState.PURCHASED),
            ),
        )
    }

    @Test
    fun `an active Stripe subscription routes to the web`() {
        val error = EdgeApiError.from(
            409,
            """{"error":"ACTIVE_STRIPE_SUBSCRIPTION","action":"cancel_stripe_first"}""",
        )
        val conflict = PlayPurchaseRules.conflict(error)

        assertEquals(PlayPurchaseRules.Conflict.ActiveStripeSubscription, conflict)
        assertTrue(conflict!!.routesToWeb)
        assertTrue(conflict.message.contains("web"))
    }

    @Test
    fun `an active App Store subscription points at the iOS device, not the web`() {
        val error = EdgeApiError.from(
            409,
            """{"error":"ACTIVE_APPSTORE_SUBSCRIPTION","action":"manage_in_app"}""",
        )
        val conflict = PlayPurchaseRules.conflict(error)

        assertEquals(PlayPurchaseRules.Conflict.ActiveAppStoreSubscription, conflict)
        // Sending them to gradethread.com would be a dead end - Apple owns that
        // subscription and only Apple can change it.
        assertFalse(conflict!!.routesToWeb)
    }

    @Test
    fun `a purchase owned by another account does not read as an expired session`() {
        // A bare 403 maps to Unauthorized, whose copy tells the buyer to sign in
        // again. Their session is fine; signing in again as themselves changes
        // nothing.
        val error = EdgeApiError.from(403, """{"error":"PURCHASE_NOT_OWNED_BY_ACCOUNT"}""")

        assertEquals(EdgeApiError.PurchaseNotOwned, error)
        assertEquals(PlayPurchaseRules.Conflict.PurchaseNotOwned, PlayPurchaseRules.conflict(error))
    }

    @Test
    fun `billing not configured is a conflict, not a retry`() {
        val error = EdgeApiError.from(503, """{"error":"Google Play billing is not configured."}""")

        val conflict = PlayPurchaseRules.conflict(error)
        assertEquals(PlayPurchaseRules.Conflict.NotConfigured, conflict)
        assertTrue(conflict!!.routesToWeb)
    }

    @Test
    fun `a transient failure stays retryable`() {
        assertTrue(PlayPurchaseRules.retryable(EdgeApiError.Network("timed out")))
        assertTrue(PlayPurchaseRules.retryable(EdgeApiError.from(500, "")))
        assertNull(PlayPurchaseRules.conflict(EdgeApiError.Network("timed out")))
    }

    @Test
    fun `a conflict is not retryable`() {
        val error = EdgeApiError.from(409, """{"error":"ACTIVE_STRIPE_SUBSCRIPTION"}""")
        assertFalse(PlayPurchaseRules.retryable(error))
    }

    @Test
    fun `a marker in a plain-text body is still recognized`() {
        // A proxy rewrite or an older edge build can deliver the marker without
        // the JSON shape. The buyer's situation hasn't changed, so neither
        // should the answer.
        val error = EdgeApiError.BadRequest("oops", "ACTIVE_STRIPE_SUBSCRIPTION")
        assertEquals(
            PlayPurchaseRules.Conflict.ActiveStripeSubscription,
            PlayPurchaseRules.conflict(error),
        )
    }

    @Test
    fun `only purchased updates trigger a re-verify`() {
        val signal = PlaySignal.Updated(
            listOf(
                purchase("flipdesk_pro_monthly"),
                purchase("credits_25", state = PlayPurchaseState.PENDING),
                purchase("something_else"),
            ),
        )

        assertEquals(
            listOf("flipdesk_pro_monthly"),
            PlayPurchaseRules.shouldReverify(signal).map { it.productId },
        )
        assertTrue(PlayPurchaseRules.shouldReverify(PlaySignal.Cancelled).isEmpty())
        assertTrue(PlayPurchaseRules.shouldReverify(PlaySignal.Error("nope")).isEmpty())
    }
}
