package com.gradethread.app.money

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

import com.gradethread.app.money.MoneyFixtures.item
import com.gradethread.app.money.MoneyFixtures.ms
import com.gradethread.app.money.MoneyFixtures.sale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1371: the sales list.
 *
 * The load-bearing case is [perItemPnlMatchesTheMoneyRollup] — AC3 asks that the
 * sales list and the Money tab agree, and the only way to keep that true as both
 * change is to assert it against the OTHER rollup rather than against a hardcoded
 * number that could drift with it.
 */
@RunWith(RobolectricTestRunner::class)
class SalesRollupTest {

    // US-2976: these three assert the WORD a seller reads - "Pending" is the
    // whole point of the test that says a pending sale is not folded into
    // completed. Rendered, not asserted as ids.
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private val day = DashboardRollup.DAY_MS
    private val now = ms(2026, 6, 20)

    @Test
    fun everySaleIsListedIncludingReversedOnes() {
        // AC2. Hiding them would make the seller's history disagree with their
        // eBay account, which is the one place they'd go to check.
        val sales = listOf(
            sale("ok", "i1", saleDate = now),
            sale("refund", "i1", status = "refunded", saleDate = now - day),
            sale("cancel", "i1", status = "cancelled", saleDate = now - 2 * day),
            sale("pending", "i1", status = "pending", saleDate = now - 3 * day),
        )
        val state = SalesRollup.compute(sales, emptyList())
        assertEquals(4, state.rows.size)
        assertEquals(1, state.completedCount)
        assertEquals(3, state.excludedCount)
    }

    @Test
    fun onlyCompletedSalesAreSummed() {
        val sales = listOf(
            sale("ok", "i1", salePrice = 100.0, saleDate = now),
            sale("refund", "i1", salePrice = 900.0, status = "refunded", saleDate = now - day),
        )
        val state = SalesRollup.compute(sales, emptyList())
        assertEquals(100.0, state.realizedRevenue, 1e-9)
    }

    @Test
    fun reversedSalesCarryAStatusLabelAndNoPnlFigure() {
        val state = SalesRollup.compute(
            listOf(sale("r", "i1", status = "refunded", saleDate = now)),
            emptyList(),
        )
        val row = state.rows.single()
        assertEquals("Refunded", row.statusLabel.text(context))
        assertFalse(row.countsTowardTotals)
    }

    @Test
    fun pendingIsShownAsItsOwnStateNotAsCompleted() {
        // `pending` is a real 00111 status — an order taken but not settled. It
        // is not revenue yet, and calling it "Completed" would be a lie.
        val row = SalesRollup.compute(
            listOf(sale("p", "i1", status = "pending", saleDate = now)),
            emptyList(),
        ).rows.single()
        assertEquals("Pending", row.statusLabel.text(context))
        assertFalse(row.countsTowardTotals)
    }

    @Test
    fun aLegacyBlankStatusReadsAsCompleted() {
        val row = SalesRollup.compute(
            listOf(sale("s", "i1", status = "", saleDate = now)),
            emptyList(),
        ).rows.single()
        assertEquals("Completed", row.statusLabel.text(context))
        assertTrue(row.countsTowardTotals)
    }

    @Test
    fun rowsAreSortedNewestFirst() {
        val sales = listOf(
            sale("old", "i1", saleDate = now - 5 * day),
            sale("new", "i1", saleDate = now),
            sale("mid", "i1", saleDate = now - 2 * day),
        )
        assertEquals(
            listOf("new", "mid", "old"),
            SalesRollup.compute(sales, emptyList()).rows.map { it.saleId },
        )
    }

    @Test
    fun perItemPnlMatchesTheMoneyRollup() {
        // AC3, asserted against the other rollup rather than a literal so the
        // two cannot drift apart in a later change.
        val items = listOf(
            item("i1", acquiredPrice = 20.0, title = "Wool coat"),
            item("i2", acquiredPrice = 5.0, title = "Tee"),
        )
        val sales = listOf(
            sale(
                "s1",
                "i1",
                salePrice = 100.0,
                shippingCollected = 10.0,
                platformFees = 13.0,
                paymentProcessingFees = 3.0,
                shippingCost = 7.0,
                saleDate = now - day,
            ),
            sale("s2", "i2", salePrice = 30.0, platformFees = 4.0, saleDate = now - 2 * day),
            // A reversed sale, present in both inputs, counted by neither.
            sale("s3", "i1", salePrice = 700.0, status = "refunded", saleDate = now),
        )

        val salesRows = SalesRollup.compute(sales, items).rows.associateBy { it.saleId }
        val moneyRows = MoneyAnalyticsRollup.itemProfitRows(items, sales).associateBy { it.saleId }

        // Same set of P&L-bearing sales…
        assertEquals(
            moneyRows.keys,
            salesRows.filterValues { it.countsTowardTotals }.keys,
        )
        // …and the same figures for each.
        moneyRows.forEach { (id, money) ->
            val row = salesRows.getValue(id)
            assertEquals(id, money.revenue, row.revenue, 0.0)
            assertEquals(id, money.fees, row.fees, 0.0)
            assertEquals(id, money.costBasis, row.costBasis, 0.0)
            assertEquals(id, money.netProfit, row.netProfit, 0.0)
            // Sentinel rather than boxed comparison: both are null exactly when
            // cost basis is zero, and both compute it the same way.
            assertEquals(id, money.roi ?: -1.0, row.roi ?: -1.0, 0.0)
        }
    }

    @Test
    fun realizedTotalsMatchTheMoneyTabsMonthlyFigures() {
        val items = listOf(item("i1", acquiredPrice = 20.0))
        val sales = listOf(
            sale(
                "s1",
                "i1",
                salePrice = 100.0,
                platformFees = 10.0,
                saleDate = ms(2026, 6, 5),
            ),
        )
        val list = SalesRollup.compute(sales, items)
        val money = MoneyRollup.compute(items, sales, now, MoneyFixtures.ZONE)

        // Same month, one sale: the two surfaces must print the same number.
        assertEquals(money.revenueThisMonth, list.realizedRevenue, 0.0)
        assertEquals(money.netProfitThisMonth, list.realizedProfit, 0.0)
    }

    @Test
    fun anOrphanSaleStillListsWithNoCostBasis() {
        val row = SalesRollup.compute(
            listOf(sale("s", "gone", salePrice = 40.0, saleDate = now)),
            emptyList(),
        ).rows.single()
        assertEquals("Untitled item", row.title)
        assertEquals(0.0, row.costBasis, 0.0)
        assertNull(row.roi)
    }

    @Test
    fun emptyInputIsAnEmptyStateNotZeroedRows() {
        val state = SalesRollup.compute(emptyList(), emptyList())
        assertTrue(state.rows.isEmpty())
        assertEquals(0, state.completedCount)
        assertEquals(0.0, state.realizedProfit, 0.0)
    }
}
