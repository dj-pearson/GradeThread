package com.gradethread.app.billing

import android.app.Activity
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * US-1366 AC4: the whole purchase path, driven against a fake Play Store.
 *
 * Robolectric only for the [Activity] `launchBillingFlow` needs — everything
 * under test is ordinary Kotlin.
 */
@RunWith(RobolectricTestRunner::class)
class BillingRepositoryTest {

    private lateinit var play: FakePlayBilling
    private lateinit var verifier: FakePurchaseVerifier
    private lateinit var repo: BillingRepository
    private lateinit var activity: Activity

    @Before
    fun setUp() {
        play = FakePlayBilling()
        verifier = FakePurchaseVerifier()
        repo = BillingRepository(play, verifier)
        activity = Robolectric.buildActivity(Activity::class.java).get()
    }

    private fun purchase(
        productId: String,
        state: PlayPurchaseState = PlayPurchaseState.PURCHASED,
        acknowledged: Boolean = false,
    ) = PlayPurchase(listOf(productId), "token-$productId", state, acknowledged)

    // ── Catalog ──────────────────────────────────────────────────────────────

    @Test
    fun `subscription offers carry Play's price and offer token`() = runTest {
        play.catalog[PlayProductType.SUBS] = listOf(
            PlayProduct("flipdesk_pro_monthly", "€54,99", "offer-1"),
        )

        val offers = repo.subscriptionOffers()

        assertEquals(SubscriptionProduct.entries.size, offers.size)
        val pro = offers.first { it.product == SubscriptionProduct.PRO_MONTHLY }
        assertEquals("€54,99", pro.priceLabel)
        assertTrue(pro.purchasable)
    }

    @Test
    fun `a plan Play didn't return falls back to its listed price and is unbuyable`() = runTest {
        play.catalog[PlayProductType.SUBS] = emptyList()

        val offers = repo.subscriptionOffers()
        val starter = offers.first { it.product == SubscriptionProduct.STARTER_MONTHLY }

        // The paywall still renders. It just cannot promise a purchase it has
        // no offer token for.
        assertEquals("$29.00", starter.priceLabel)
        assertFalse(starter.purchasable)
    }

    @Test
    fun `with Play unavailable every plan shows its fallback price`() = runTest {
        play.connected = false

        val offers = repo.subscriptionOffers()

        assertEquals(SubscriptionProduct.entries.size, offers.size)
        assertTrue(offers.none { it.purchasable })
        assertEquals("$99.00", offers.first { it.product == SubscriptionProduct.BUSINESS_MONTHLY }.priceLabel)
    }

    // ── Launch ───────────────────────────────────────────────────────────────

    @Test
    fun `a subscription with no offer token never reaches Play`() = runTest {
        val offer = SubscriptionOffer(SubscriptionProduct.PRO_YEARLY, "$590.00", null)

        assertFalse(repo.launchSubscription(activity, offer))
        // Not merely a false return: Play was never asked, so the buyer never
        // sees a dialog open and immediately fail.
        assertTrue(play.launched.isEmpty())
    }

    @Test
    fun `launching a subscription passes the offer token through`() = runTest {
        val offer = SubscriptionOffer(SubscriptionProduct.PRO_YEARLY, "$590.00", "offer-9")

        assertTrue(repo.launchSubscription(activity, offer))
        assertEquals(1, play.launched.size)
        assertEquals(PlayProductType.SUBS, play.launched[0].second)
        assertEquals("offer-9", play.launched[0].first.offerToken)
    }

    @Test
    fun `launching a credit pack asks for a one-time product`() = runTest {
        assertTrue(repo.launchPurchase(activity, CreditPack.PACK_25))
        assertEquals(PlayProductType.INAPP, play.launched[0].second)
        assertEquals("credits_25", play.launched[0].first.productId)
    }

    // ── Verify and settle ────────────────────────────────────────────────────

    @Test
    fun `a verified subscription is acknowledged, never consumed`() = runTest {
        verifier.response = GooglePlayVerifyResponse(plan = "pro", interval = "monthly", status = "active")

        val outcome = repo.verifyAndSettle(purchase("flipdesk_pro_monthly"))

        assertTrue(outcome is BillingRepository.PurchaseOutcome.Verified)
        assertEquals(listOf("token-flipdesk_pro_monthly"), play.acknowledged)
        assertTrue(play.consumed.isEmpty())
        assertEquals(PlanTier.PRO, (outcome as BillingRepository.PurchaseOutcome.Verified).entitlement.tier)
        assertTrue(outcome.entitlement.subscribed)
    }

    @Test
    fun `a verified credit pack is consumed, never acknowledged`() = runTest {
        verifier.response = GooglePlayVerifyResponse(creditsBalance = 42)

        val outcome = repo.verifyAndSettle(purchase("credits_25"))

        assertEquals(42, (outcome as BillingRepository.PurchaseOutcome.Verified).creditsBalance)
        assertEquals(listOf("token-credits_25"), play.consumed)
        assertTrue(play.acknowledged.isEmpty())
    }

    @Test
    fun `nothing is settled until the server has granted it`() = runTest {
        // The whole reason for the ordering: consuming first makes the token
        // unusable, so a buyer who loses signal between paying and verifying
        // would have paid for nothing.
        verifier.error = EdgeApiError.Network("timed out")

        val outcome = repo.verifyAndSettle(purchase("credits_50"))

        assertTrue(outcome is BillingRepository.PurchaseOutcome.Failed)
        assertTrue(play.consumed.isEmpty())
        assertTrue(play.acknowledged.isEmpty())
    }

    @Test
    fun `a failed settlement does not undo a granted purchase`() = runTest {
        // The credits are already on the account. Reporting a failure would tell
        // the buyer their purchase didn't work when it did.
        play.settlementSucceeds = false
        verifier.response = GooglePlayVerifyResponse(creditsBalance = 10)

        val outcome = repo.verifyAndSettle(purchase("credits_10"))

        assertTrue(outcome is BillingRepository.PurchaseOutcome.Verified)
    }

    @Test
    fun `a Stripe conflict comes back named, not as a generic failure`() = runTest {
        verifier.error = EdgeApiError.from(
            409,
            """{"error":"ACTIVE_STRIPE_SUBSCRIPTION","action":"cancel_stripe_first"}""",
        )

        val outcome = repo.verifyAndSettle(purchase("flipdesk_starter_monthly"))
                as BillingRepository.PurchaseOutcome.Failed

        assertEquals(PlayPurchaseRules.Conflict.ActiveStripeSubscription, outcome.conflict)
        assertTrue(outcome.message.contains("web"))
        // Not acknowledged: the server refused, so Play's three-day auto-refund
        // is the correct outcome for a subscription we can't honour.
        assertTrue(play.acknowledged.isEmpty())
    }

    @Test
    fun `a pending purchase is not sent to the server at all`() = runTest {
        val outcome = repo.verifyAndSettle(
            purchase("credits_25", state = PlayPurchaseState.PENDING),
        )

        assertTrue(outcome is BillingRepository.PurchaseOutcome.Failed)
        assertTrue(verifier.calls.isEmpty())
    }

    @Test
    fun `a product we don't sell is not sent to the server`() = runTest {
        val outcome = repo.verifyAndSettle(purchase("some_other_app_product"))

        assertTrue(outcome is BillingRepository.PurchaseOutcome.Failed)
        assertTrue(verifier.calls.isEmpty())
        assertTrue(play.consumed.isEmpty())
    }

    // ── Recovery ─────────────────────────────────────────────────────────────

    @Test
    fun `outstanding purchases across both product types are redeemed`() = runTest {
        // The case this exists for: the app died between paying and verifying,
        // so the buyer is out the money with nothing on their account.
        play.owned[PlayProductType.INAPP] = listOf(purchase("credits_10"))
        play.owned[PlayProductType.SUBS] = listOf(purchase("flipdesk_pro_yearly"))

        val outcomes = repo.redeemOutstanding()

        assertEquals(2, outcomes.size)
        assertTrue(outcomes.all { it is BillingRepository.PurchaseOutcome.Verified })
        assertEquals(listOf("token-credits_10"), play.consumed)
        assertEquals(listOf("token-flipdesk_pro_yearly"), play.acknowledged)
    }

    @Test
    fun `pending and unknown purchases are skipped during recovery`() = runTest {
        play.owned[PlayProductType.INAPP] = listOf(
            purchase("credits_10", state = PlayPurchaseState.PENDING),
            purchase("mystery_product"),
        )

        assertTrue(repo.redeemOutstanding().isEmpty())
        assertTrue(verifier.calls.isEmpty())
    }

    @Test
    fun `recovery is a no-op when Play can't be reached`() = runTest {
        play.connected = false
        play.owned[PlayProductType.SUBS] = listOf(purchase("flipdesk_pro_monthly"))

        assertTrue(repo.redeemOutstanding().isEmpty())
    }

    @Test
    fun `the active subscription is whichever one Play says is owned`() = runTest {
        play.owned[PlayProductType.SUBS] = listOf(
            purchase("flipdesk_pro_monthly", state = PlayPurchaseState.PENDING),
            purchase("flipdesk_business_yearly"),
        )

        val active = repo.activeSubscription()

        assertNotNull(active)
        assertEquals("flipdesk_business_yearly", active!!.productId)
    }

    @Test
    fun `no subscription means none, not a guess`() = runTest {
        assertNull(repo.activeSubscription())
    }
}
