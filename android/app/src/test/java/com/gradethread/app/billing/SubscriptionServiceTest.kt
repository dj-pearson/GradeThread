package com.gradethread.app.billing

import android.app.Activity
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * US-1366 AC3: what happens when Play talks to us without being asked.
 */
@RunWith(RobolectricTestRunner::class)
class SubscriptionServiceTest {

    private lateinit var play: FakePlayBilling
    private lateinit var verifier: FakePurchaseVerifier
    private lateinit var service: SubscriptionService
    private lateinit var activity: Activity

    @Before
    fun setUp() {
        play = FakePlayBilling()
        verifier = FakePurchaseVerifier()
        service = SubscriptionService(BillingRepository(play, verifier))
        activity = Robolectric.buildActivity(Activity::class.java).get()
    }

    private fun purchase(productId: String) =
        PlayPurchase(listOf(productId), "token-$productId", PlayPurchaseState.PURCHASED)

    // US-2435: the six tests below drive SubscriptionService through its
    // LISTENER, and they all need runTest(UnconfinedTestDispatcher()).
    //
    // `observe()` is fire-and-forget — `scope.launch { billing.events.collect …
    // }` — so the SharedFlow subscription only exists once that coroutine
    // actually runs. `advanceUntilIdle()` does NOT run background-scope work:
    // it stops at the first non-foreground event, and everything launched in
    // `backgroundScope` is non-foreground by definition. So the collector was
    // never subscribed, and FakePlayBilling's flow (replay = 0, tryEmit)
    // discards a value with no subscribers — silently, returning true.
    //
    // Every one of these five assertions was therefore failing on a signal that
    // was dropped on the floor, not on wrong behaviour. Calling the same code
    // directly passes, which is why `refresh loads prices and redeems…` below
    // has always been green.
    //
    // `a cancelled dialog changes nothing about the plan` is in this list even
    // though it PASSED: it asserts that nothing happened, which a dropped signal
    // satisfies for free. It was a false green, and it is worth strictly more
    // now than it was.
    //
    // Not fixable by raising the fake's replay (the collector still never runs
    // during the test body), and not by passing the test's own scope to
    // observe() (a never-ending collect as a child of the test body makes
    // runTest hang — which is what backgroundScope exists to avoid).
    @Test
    fun `a renewal we never tapped for still moves the plan forward`() = runTest(UnconfinedTestDispatcher()) {
        // Play pushes a renewal through the same listener as a fresh purchase,
        // with a token the server has never seen. Nothing on screen is watching.
        verifier.response = GooglePlayVerifyResponse(
            plan = "pro",
            interval = "yearly",
            status = "active",
        )
        service.observe(backgroundScope)
        advanceUntilIdle()

        play.emit(PlaySignal.Updated(listOf(purchase("flipdesk_pro_yearly"))))
        advanceUntilIdle()

        assertEquals(PlanTier.PRO, service.state.value.plan)
        assertTrue(service.state.value.subscribed)
        assertEquals(listOf("token-flipdesk_pro_yearly"), play.acknowledged)
    }

    @Test
    fun `a cancelled dialog changes nothing about the plan`() = runTest(UnconfinedTestDispatcher()) {
        service.observe(backgroundScope)
        advanceUntilIdle()

        play.emit(PlaySignal.Cancelled)
        advanceUntilIdle()

        assertNull(service.state.value.entitlement)
        assertTrue(verifier.calls.isEmpty())
    }

    @Test
    fun `refresh loads prices and redeems a purchase that was never verified`() = runTest {
        play.catalog[PlayProductType.SUBS] = listOf(
            PlayProduct("flipdesk_starter_monthly", "$29.00", "offer-1"),
        )
        play.owned[PlayProductType.SUBS] = listOf(purchase("flipdesk_starter_monthly"))
        verifier.response = GooglePlayVerifyResponse(
            plan = "starter",
            interval = "monthly",
            status = "active",
        )

        service.refresh()

        assertTrue(service.state.value.loaded)
        assertEquals(PlanTier.STARTER, service.state.value.plan)
        assertTrue(
            service.state.value.offers
                .first { it.product == SubscriptionProduct.STARTER_MONTHLY }
                .purchasable,
        )
    }

    @Test
    fun `a Stripe conflict is kept on state, not flashed and lost`() = runTest(UnconfinedTestDispatcher()) {
        // The buyer has to go somewhere else to fix this. A message that
        // disappears while they read it is no help.
        verifier.error = EdgeApiError.from(
            409,
            """{"error":"ACTIVE_STRIPE_SUBSCRIPTION","action":"cancel_stripe_first"}""",
        )
        service.observe(backgroundScope)
        advanceUntilIdle()

        play.emit(PlaySignal.Updated(listOf(purchase("flipdesk_pro_monthly"))))
        advanceUntilIdle()

        val state = service.state.value
        assertEquals(PlayPurchaseRules.Conflict.ActiveStripeSubscription, state.conflict)
        assertFalse(state.purchasing)
        assertTrue(state.conflict!!.routesToWeb)
        assertTrue(service.webBillingUrl().startsWith("https://"))
    }

    @Test
    fun `an unbuyable plan says so instead of asking the buyer to try again`() = runTest {
        val offer = SubscriptionOffer(SubscriptionProduct.BUSINESS_MONTHLY, "$99.00", null)

        assertFalse(service.purchase(activity, offer))

        val message = service.state.value.errorMessage
        assertTrue(message!!.contains("isn't available"))
        assertFalse(service.state.value.purchasing)
    }

    @Test
    fun `a launch that Play refuses clears the purchasing flag`() = runTest {
        play.launchSucceeds = false
        val offer = SubscriptionOffer(SubscriptionProduct.PRO_MONTHLY, "$59.00", "offer-1")

        assertFalse(service.purchase(activity, offer))
        assertFalse(service.state.value.purchasing)
        assertTrue(service.state.value.errorMessage!!.contains("Try again"))
    }

    @Test
    fun `a launched purchase leaves the flow waiting on Play, not on us`() = runTest {
        val offer = SubscriptionOffer(SubscriptionProduct.PRO_MONTHLY, "$59.00", "offer-1")

        assertTrue(service.purchase(activity, offer))
        // Still purchasing: the outcome arrives on the listener, which is the
        // only place a purchase made on another device could arrive too.
        assertTrue(service.state.value.purchasing)
        assertNull(service.state.value.entitlement)
    }

    @Test
    fun `dismissing an error clears the conflict with it`() = runTest(UnconfinedTestDispatcher()) {
        verifier.error = EdgeApiError.from(403, """{"error":"PURCHASE_NOT_OWNED_BY_ACCOUNT"}""")
        service.observe(backgroundScope)
        advanceUntilIdle()

        play.emit(PlaySignal.Updated(listOf(purchase("flipdesk_pro_monthly"))))
        advanceUntilIdle()
        assertEquals(PlayPurchaseRules.Conflict.PurchaseNotOwned, service.state.value.conflict)

        service.dismissError()
        assertNull(service.state.value.conflict)
        assertNull(service.state.value.errorMessage)
    }

    @Test
    fun `a subscription Play no longer owns stops showing as a plan`() = runTest(UnconfinedTestDispatcher()) {
        verifier.response = GooglePlayVerifyResponse(plan = "pro", status = "active")
        service.observe(backgroundScope)
        advanceUntilIdle()
        play.emit(PlaySignal.Updated(listOf(purchase("flipdesk_pro_monthly"))))
        advanceUntilIdle()
        assertEquals(PlanTier.PRO, service.state.value.plan)

        // Refunded. Play just stops listing it; the downgrade itself already
        // happened server-side through a Real-time Developer Notification.
        play.owned[PlayProductType.SUBS] = emptyList()
        service.refresh()

        assertNull(service.state.value.entitlement)
        assertFalse(service.state.value.subscribed)
    }

    @Test
    fun `already-owned redeems the earlier purchase instead of reporting a failure`() = runTest(UnconfinedTestDispatcher()) {
        play.owned[PlayProductType.SUBS] = listOf(purchase("flipdesk_starter_yearly"))
        verifier.response = GooglePlayVerifyResponse(plan = "starter", status = "active")
        service.observe(backgroundScope)
        advanceUntilIdle()

        play.emit(PlaySignal.Error("already owned", alreadyOwned = true))
        advanceUntilIdle()

        assertEquals(PlanTier.STARTER, service.state.value.plan)
        assertNull(service.state.value.errorMessage)
    }

    @Test
    fun `offers default to the listed prices before anything loads`() {
        val state = service.state.value
        assertEquals(SubscriptionProduct.entries.size, state.offers.size)
        assertFalse(state.loaded)
        assertTrue(state.offers.none { it.purchasable })
    }
}
