package com.gradethread.app.billing

import android.app.Activity
import com.gradethread.app.testing.MainDispatcherRule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * US-2830: buying grades from inside the consumer photo-grade flow.
 *
 * THE PROPERTY EVERY CASE HERE IS ABOUT is that this view model never decides a
 * submission is paid. It buys, and hands back. `POST /api/grade/pay/:id` is the
 * authority, and it is idempotent per submission — so the only mistakes
 * available to this class are calling back when it should not, and NOT calling
 * back when it should. Both cost the seller: the first sends them into a
 * re-charge that will fail, the second leaves them holding a purchase with a
 * flow that never moves.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ConsumerCreditTopUpTest {

    @get:Rule
    val mainDispatcher = MainDispatcherRule()

    private lateinit var play: FakePlayBilling
    private lateinit var verifier: FakePurchaseVerifier
    private lateinit var vm: ConsumerCreditTopUpViewModel
    private lateinit var activity: Activity

    @Before
    fun setUp() {
        play = FakePlayBilling()
        verifier = FakePurchaseVerifier()
        vm = ConsumerCreditTopUpViewModel(BillingRepository(play, verifier))
        activity = Robolectric.buildActivity(Activity::class.java).get()
    }

    private fun purchase(productId: String) =
        PlayPurchase(listOf(productId), "token-$productId", PlayPurchaseState.PURCHASED, false)

    // ── the callback contract ─────────────────────────────────────────────

    @Test
    fun `a verified purchase hands back to the flow`() = runTest {
        var handedBack = 0
        vm.purchase(activity, CreditPack.entries.first()) { handedBack++ }
        advanceUntilIdle()
        play.emit(PlaySignal.Updated(listOf(purchase(CreditPack.entries.first().productId))))
        advanceUntilIdle()

        assertEquals(1, handedBack)
        assertFalse(vm.state.value.purchasing)
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `cancelling is not an error and hands nothing back`() = runTest {
        var handedBack = 0
        vm.purchase(activity, CreditPack.entries.first()) { handedBack++ }
        advanceUntilIdle()
        play.emit(PlaySignal.Cancelled)
        advanceUntilIdle()

        // Backing out of a purchase dialog is a decision. Telling the seller
        // something went wrong would be a lie, and re-charging on it would send
        // them to a pay call that must fail.
        assertEquals(0, handedBack)
        assertNull(vm.state.value.errorMessage)
        assertFalse(vm.state.value.purchasing)
    }

    @Test
    fun `Play refusing to open is reported and hands nothing back`() = runTest {
        play.launchSucceeds = false
        var handedBack = 0
        vm.purchase(activity, CreditPack.entries.first()) { handedBack++ }
        advanceUntilIdle()

        assertEquals(0, handedBack)
        assertTrue(vm.state.value.errorMessage!!.contains("Google Play"))
        assertFalse(vm.state.value.purchasing)
    }

    @Test
    fun `a purchase that fails verification hands nothing back`() = runTest {
        // The money left the buyer's account and the grant did NOT land. Calling
        // creditsPurchased here would re-charge, fail, and put the seller back
        // on the out-of-grades screen with no explanation of where their money
        // went.
        verifier.error = IllegalStateException("verify exploded")
        var handedBack = 0
        vm.purchase(activity, CreditPack.entries.first()) { handedBack++ }
        advanceUntilIdle()
        play.emit(PlaySignal.Updated(listOf(purchase(CreditPack.entries.first().productId))))
        advanceUntilIdle()

        assertEquals(0, handedBack)
        assertFalse(vm.state.value.purchasing)
    }

    @Test
    fun `a second purchase while one is in flight is ignored`() = runTest {
        var handedBack = 0
        vm.purchase(activity, CreditPack.entries.first()) { handedBack++ }
        advanceUntilIdle()
        assertTrue(vm.state.value.purchasing)

        vm.purchase(activity, CreditPack.entries.last()) { handedBack++ }
        advanceUntilIdle()

        // One launch, not two. Double-tapping a pack row must not open two Play
        // sheets and buy twice.
        assertEquals(1, play.launched.size)
    }

    // ── the recovery path (AC5) ───────────────────────────────────────────

    @Test
    fun `open settles a purchase that was paid for and never verified`() = runTest {
        // Otherwise invisible: the app died between Play taking the money and
        // the server granting the credits, and nothing would ever look again.
        play.owned[PlayProductType.INAPP] =
            listOf(purchase(CreditPack.entries.first().productId))
        var recovered = 0
        vm.open { recovered++ }
        advanceUntilIdle()

        assertEquals(1, recovered)
        assertEquals(1, vm.state.value.recoveredCount)
    }

    @Test
    fun `open with nothing outstanding does not claim a recovery`() = runTest {
        var recovered = 0
        vm.open { recovered++ }
        advanceUntilIdle()

        // The negative direction. A callback fired here would re-charge on every
        // open, and the pay route would refuse — which reads to the seller as
        // the purchase having failed.
        assertEquals(0, recovered)
        assertEquals(0, vm.state.value.recoveredCount)
    }

    @Test
    fun `the offers are the real credit packs`() = runTest {
        vm.open { }
        advanceUntilIdle()

        assertEquals(CreditPack.entries.size, vm.state.value.offers.size)
        // Guards the guard: an empty offer list would make every case above
        // pass against a sheet that shows nothing to buy.
        assertTrue(vm.state.value.offers.isNotEmpty())
    }
}
