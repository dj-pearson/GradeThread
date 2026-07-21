package com.gradethread.app.billing

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1338: the window between "the buyer paid" and "submit unblocks".
 */
class CreditTopUpFlowTest {

    private val slept = mutableListOf<Long>()

    private suspend fun run(
        baseline: Int,
        verifiedBalance: Int? = null,
        balances: List<Int?> = emptyList(),
        maxPolls: Int = CreditTopUpFlow.MAX_POLLS,
    ): CreditTopUpFlow.State {
        var index = 0
        return CreditTopUpFlow.awaitGrant(
            baseline = baseline,
            verifiedBalance = verifiedBalance,
            fetchBalance = { balances.getOrNull(index++) },
            sleep = { slept += it },
            maxPolls = maxPolls,
        )
    }

    @Test
    fun `the balance verify already reported short-circuits the poll entirely`() = runTest {
        // The Android verify endpoint applies the grant BEFORE responding, so
        // the common path never polls at all — unlike iOS, where StoreKit
        // confirms first and the grant lands out of band.
        val state = run(baseline = 2, verifiedBalance = 12)
        assertEquals(CreditTopUpFlow.State.Granted(12), state)
        assertTrue("should not have slept", slept.isEmpty())
    }

    @Test
    fun `a verify balance that did not move still falls through to polling`() = runTest {
        // e.g. the response was for a purchase already granted earlier.
        val state = run(baseline = 5, verifiedBalance = 5, balances = listOf(5, 15))
        assertEquals(CreditTopUpFlow.State.Granted(15), state)
    }

    @Test
    fun `a transient read failure just retries`() = runTest {
        val state = run(baseline = 0, balances = listOf(null, null, 10))
        assertEquals(CreditTopUpFlow.State.Granted(10), state)
    }

    @Test
    fun `the grant is a strict increase, not an absolute target`() {
        assertTrue(CreditTopUpFlow.granted(baseline = 3, balance = 4))
        assertFalse(CreditTopUpFlow.granted(baseline = 3, balance = 3))
        assertFalse(CreditTopUpFlow.granted(baseline = 3, balance = 2))
        assertFalse(CreditTopUpFlow.granted(baseline = 0, balance = null))
    }

    @Test
    fun `an unmoved balance times out rather than hanging`() = runTest {
        val state = run(baseline = 4, balances = List(4) { 4 }, maxPolls = 4)
        assertEquals(CreditTopUpFlow.State.TimedOut, state)
    }

    @Test
    fun `there is no sleep after the final attempt`() = runTest {
        run(baseline = 0, balances = List(3) { 0 }, maxPolls = 3)
        // Three polls, two gaps — sleeping after the last would delay giving up
        // by up to 8s for nothing.
        assertEquals(2, slept.size)
    }

    @Test
    fun `polling backs off instead of hammering`() {
        assertEquals(1_000L, CreditTopUpFlow.delayFor(0))
        assertEquals(2_000L, CreditTopUpFlow.delayFor(1))
        assertEquals(4_000L, CreditTopUpFlow.delayFor(2))
        assertEquals(8_000L, CreditTopUpFlow.delayFor(3))
        assertEquals(8_000L, CreditTopUpFlow.delayFor(9))
    }

    // ── the product catalog ──────────────────────────────────────────────

    @Test
    fun `product ids match the edge catalog exactly`() {
        // ANDROID_CATALOG in lib/google-play/products.ts. The server classifies
        // from the reported id alone and FAILS CLOSED on an unknown one, so a
        // typo here is a purchase the buyer completes and is never credited for.
        assertEquals(
            listOf("credits_10", "credits_25", "credits_50", "credits_100"),
            CreditPack.productIds,
        )
        assertEquals(
            listOf(10, 25, 50, 100),
            CreditPack.entries.map { it.credits },
        )
    }

    @Test
    fun `an unknown product id resolves to no pack`() {
        assertNull(CreditPack.fromProductId("credits_999"))
        assertNull(CreditPack.fromProductId("flipdesk_pro_monthly"))
        assertNull(CreditPack.fromProductId(null))
        assertEquals(CreditPack.PACK_25, CreditPack.fromProductId("credits_25"))
    }

    @Test
    fun `Play's localized price wins over the compiled fallback`() {
        // The fallback is USD; quoting it to someone who will be charged euros
        // is a broken promise, so it is only ever a placeholder.
        val offer = CreditPackOffer(CreditPack.PACK_10, formattedPrice = "€22,99")
        assertEquals("€22,99", offer.priceLabel)
        assertEquals("$24.99", CreditPackOffer(CreditPack.PACK_10).priceLabel)
    }
}
