package com.gradethread.app.money

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.PayoutEntity
import com.gradethread.app.ui.text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1365. These assertions are about money a seller will act on, so they check
 * the awkward cases rather than the happy path: a one-cent rounding gap, an
 * estimated share dressed up as a fact, a payout id that differs only by case,
 * and a cancelled order sneaking into a deposit total.
 *
 * US-2976: the wording lives in strings.xml now, so rendering it needs a
 * Context and Robolectric supplies one. The sentences stay asserted WHOLE.
 * These are numbers a seller acts on, and "less than recorded" and "more than
 * recorded" differ by one word - a resource id would prove which branch ran
 * and nothing about which direction the money went.
 */
@RunWith(RobolectricTestRunner::class)
class PayoutReconciliationTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun payout(id: String, payoutId: String = id, amountCents: Int? = 0, payoutDate: Long? = 0L) = PayoutEntity(
        id = id,
        payoutId = payoutId,
        amountCents = amountCents,
        currency = "USD",
        status = "SUCCEEDED",
        payoutDate = payoutDate,
        transactionCount = null,
        updatedAt = 0L,
    )

    @Test
    fun `payout matching its sales reconciles`() {
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 8000)),
            listOf(
                MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0),
                MoneyFixtures.sale("s2", "i2", payoutReference = "p1", payoutAmount = 30.0),
            ),
        )

        assertEquals(1, result.size)
        assertTrue(result[0].matched)
        assertEquals(2, result[0].saleCount)
        assertEquals(0, result[0].deltaCents)
        assertFalse(result[0].estimated)
    }

    @Test
    fun `one cent apart still counts as matching`() {
        // Sale rows carry dollar decimals, payouts carry integer cents. A single
        // cent of rounding is arithmetic, not a discrepancy.
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 5001)),
            listOf(MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0)),
        )

        assertTrue(result[0].matched)
        assertEquals(1, result[0].deltaCents)
        assertTrue(PayoutReconciliation.mismatches(result).isEmpty())
    }

    @Test
    fun `two cents apart is a real mismatch`() {
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 4998)),
            listOf(MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0)),
        )

        assertFalse(result[0].matched)
        assertEquals(-2, result[0].deltaCents)
        assertEquals(1, PayoutReconciliation.mismatches(result).size)
        // Built through Money.format rather than hardcoded: the symbol and
        // separators follow the device locale, so a literal would fail on a CI
        // runner that isn't in the US. The sign wording is what's under test.
        assertEquals(
            Money.format(0.02) + " less than recorded.",
            PayoutReconciliation.deltaLabel(result[0]).text(context),
        )
    }

    @Test
    fun `a payout larger than the books says so`() {
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 5500)),
            listOf(MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0)),
        )

        assertEquals(
            Money.format(5.00) + " more than recorded.",
            PayoutReconciliation.deltaLabel(result[0]).text(context),
        )
    }

    @Test
    fun `a missing payout amount falls back to price minus fees and is flagged`() {
        val sale = MoneyFixtures.sale(
            "s1",
            "i1",
            salePrice = 60.0,
            platformFees = 10.0,
            payoutReference = "p1",
        )
        val (cents, estimated) = PayoutReconciliation.expectedCents(sale)

        assertEquals(5000, cents)
        assertTrue(estimated)

        val result = PayoutReconciliation.reconcile(listOf(payout("p1", amountCents = 4800)), listOf(sale))
        assertTrue(result[0].estimated)
        // The note only appears when the estimate actually produced a mismatch —
        // a caveat on a clean row is noise.
        assertTrue(
            PayoutReconciliation.estimateNote(result[0])!!.text(context).contains("estimated"),
        )
    }

    @Test
    fun `a reported payout amount beats the price-minus-fees fallback`() {
        val sale = MoneyFixtures.sale(
            "s1",
            "i1",
            salePrice = 60.0,
            platformFees = 10.0,
            payoutReference = "p1",
            payoutAmount = 47.5,
        )
        val (cents, estimated) = PayoutReconciliation.expectedCents(sale)

        assertEquals(4750, cents)
        assertFalse(estimated)
    }

    @Test
    fun `no estimate note on a matched payout`() {
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 5000)),
            listOf(
                MoneyFixtures.sale(
                    "s1",
                    "i1",
                    salePrice = 60.0,
                    platformFees = 10.0,
                    payoutReference = "p1",
                ),
            ),
        )

        assertNull(PayoutReconciliation.estimateNote(result[0]))
    }

    @Test
    fun `payout reference matching is case sensitive`() {
        // eBay's payout id is an opaque string. Case-folding one side is how a
        // join quietly stops finding anything.
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", payoutId = "PAY-ABC")),
            listOf(MoneyFixtures.sale("s1", "i1", payoutReference = "pay-abc", payoutAmount = 50.0)),
        )

        assertEquals(0, result[0].saleCount)
    }

    @Test
    fun `cancelled and refunded sales stay out of the deposit total`() {
        val result = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 5000)),
            listOf(
                MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0),
                MoneyFixtures.sale(
                    "s2",
                    "i2",
                    status = "cancelled",
                    payoutReference = "p1",
                    payoutAmount = 25.0,
                ),
                MoneyFixtures.sale(
                    "s3",
                    "i3",
                    status = "refunded",
                    payoutReference = "p1",
                    payoutAmount = 25.0,
                ),
            ),
        )

        assertEquals(1, result[0].saleCount)
        assertTrue(result[0].matched)
    }

    @Test
    fun `sales pointing at an unsynced payout are separated from mismatches`() {
        val sales = listOf(
            MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0),
            MoneyFixtures.sale("s2", "i2", payoutReference = "p-not-here", payoutAmount = 20.0),
        )
        val payouts = listOf(payout("p1", amountCents = 5000))

        val unknown = PayoutReconciliation.salesWithUnknownPayout(payouts, sales)
        assertEquals(listOf("s2"), unknown.map { it.id })
        // And it is NOT a mismatch — nothing is wrong with the numbers.
        assertTrue(PayoutReconciliation.mismatches(PayoutReconciliation.reconcile(payouts, sales)).isEmpty())
    }

    @Test
    fun `a cancelled sale on an unsynced payout is not outstanding money`() {
        val sales = listOf(
            MoneyFixtures.sale(
                "s1",
                "i1",
                status = "cancelled",
                payoutReference = "p-not-here",
                payoutAmount = 20.0,
            ),
        )

        assertTrue(PayoutReconciliation.salesWithUnknownPayout(emptyList(), sales).isEmpty())
    }

    @Test
    fun `completed sales with no payout reference are awaiting payout`() {
        val sales = listOf(
            MoneyFixtures.sale("s1", "i1"),
            MoneyFixtures.sale("s2", "i2", payoutReference = "p1"),
            MoneyFixtures.sale("s3", "i3", status = "cancelled"),
        )

        assertEquals(listOf("s1"), PayoutReconciliation.salesAwaitingPayout(sales).map { it.id })
    }

    @Test
    fun `a payout with no sales attached reads as fully unexplained`() {
        val result = PayoutReconciliation.reconcile(listOf(payout("p1", amountCents = 5000)), emptyList())

        assertEquals(0, result[0].saleCount)
        assertEquals(5000, result[0].deltaCents)
        assertFalse(result[0].matched)
    }

    @Test
    fun `newest payouts sort first`() {
        val result = PayoutReconciliation.reconcile(
            listOf(
                payout("old", payoutDate = 1_000L),
                payout("new", payoutDate = 9_000L),
                payout("undated", payoutDate = null),
            ),
            emptyList(),
        )

        assertEquals(listOf("new", "old", "undated"), result.map { it.payout.id })
    }

    @Test
    fun `summary counts the payouts that do not match`() {
        assertEquals(
            "No payouts synced yet.",
            PayoutReconciliation.summary(emptyList()).text(context),
        )

        val clean = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 5000)),
            listOf(MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0)),
        )
        // US-2976: "All 1 payout matches" - the old wording said "All 1
        // payouts match", which nobody filed and everybody read past. A
        // plurals resource has to be given the singular form to fill in, so
        // writing one was not optional this time.
        assertEquals(
            "All 1 payout matches your records.",
            PayoutReconciliation.summary(clean).text(context),
        )

        val dirty = PayoutReconciliation.reconcile(
            listOf(payout("p1", amountCents = 5000), payout("p2", amountCents = 100)),
            listOf(MoneyFixtures.sale("s1", "i1", payoutReference = "p1", payoutAmount = 50.0)),
        )
        assertEquals(
            "1 of 2 payouts don't match.",
            PayoutReconciliation.summary(dirty).text(context),
        )
    }
}
