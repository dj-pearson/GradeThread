package com.gradethread.app.money

import com.gradethread.app.money.MoneyFixtures.ZONE
import com.gradethread.app.money.MoneyFixtures.item
import com.gradethread.app.money.MoneyFixtures.ms
import com.gradethread.app.money.MoneyFixtures.sale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * US-1363 AC2/AC3: the Money KPI + chart math, with no I/O.
 *
 * The property under test throughout is that ONLY COMPLETED SALES COUNT
 * (migration 00111) and that profit is netted through [SalePnL] — the same
 * definition Home, Analytics, the other two clients and the server use. A
 * divergence here is a number a seller reconciles against their eBay payout and
 * finds wrong.
 */
class MoneyRollupTest {

    private val now = ms(2026, 6, 20)

    @Test
    fun revenueAndNetProfitUseTheSharedPnlDefinition() {
        val items = listOf(item("i1", acquiredPrice = 20.0))
        val sales = listOf(
            sale(
                "s1", "i1",
                salePrice = 100.0,
                shippingCollected = 10.0,
                platformFees = 13.0,
                paymentProcessingFees = 3.0,
                shippingCost = 8.0,
                saleDate = ms(2026, 6, 5),
            ),
        )
        val metrics = MoneyRollup.compute(items, sales, now, ZONE, Locale.US)

        // revenue = price + shipping collected
        assertEquals(110.0, metrics.revenueThisMonth, 1e-9)
        // net = 110 − (13+3) − 8 − 20
        assertEquals(66.0, metrics.netProfitThisMonth, 1e-9)
        // ROI is on cost basis: 66 / 20
        assertEquals(3.3, metrics.roiThisMonth!!, 1e-9)
    }

    @Test
    fun taxIsNeitherRevenueNorCost() {
        // Sales tax is pass-through on a marketplace: collected from the buyer,
        // remitted by eBay. Counting it would inflate revenue on every order.
        val sales = listOf(sale("s1", "i1", salePrice = 50.0, saleDate = ms(2026, 6, 2)))
        val withTax = sales.map { it.copy(tax = 9.99) }
        assertEquals(
            MoneyRollup.compute(emptyList(), sales, now, ZONE, Locale.US).revenueThisMonth,
            MoneyRollup.compute(emptyList(), withTax, now, ZONE, Locale.US).revenueThisMonth,
            1e-9,
        )
    }

    @Test
    fun refundedAndCancelledSalesAreExcluded() {
        val items = listOf(item("i1", acquiredPrice = 10.0))
        val sales = listOf(
            sale("ok", "i1", salePrice = 100.0, saleDate = ms(2026, 6, 3)),
            sale("refund", "i1", salePrice = 500.0, status = "refunded", saleDate = ms(2026, 6, 4)),
            sale("cancel", "i1", salePrice = 900.0, status = "cancelled", saleDate = ms(2026, 6, 5)),
            // `pending` is a real 00111 state and is NOT yet realized either.
            sale("pending", "i1", salePrice = 700.0, status = "pending", saleDate = ms(2026, 6, 6)),
        )
        val metrics = MoneyRollup.compute(items, sales, now, ZONE, Locale.US)
        assertEquals(100.0, metrics.revenueThisMonth, 1e-9)
    }

    @Test
    fun aLegacySaleWithBlankStatusStillCounts() {
        // Rows predating 00111 carry no status; excluding them would erase
        // historical revenue.
        val sales = listOf(sale("s1", "i1", salePrice = 42.0, status = "", saleDate = ms(2026, 6, 3)))
        assertEquals(
            42.0,
            MoneyRollup.compute(emptyList(), sales, now, ZONE, Locale.US).revenueThisMonth,
            1e-9,
        )
    }

    @Test
    fun roiIsNullRatherThanZeroWhenNoCostBasisIsRecorded() {
        // 0% would read as "this made no money"; the truth is "we don't know
        // what it cost". The view shows "—".
        val items = listOf(item("i1", acquiredPrice = null))
        val sales = listOf(sale("s1", "i1", salePrice = 80.0, saleDate = ms(2026, 6, 4)))
        assertNull(MoneyRollup.compute(items, sales, now, ZONE, Locale.US).roiThisMonth)
    }

    @Test
    fun lastMonthsSalesDoNotCountTowardThisMonth() {
        val sales = listOf(
            sale("old", "i1", salePrice = 500.0, saleDate = ms(2026, 5, 31, hour = 23)),
            sale("new", "i1", salePrice = 25.0, saleDate = ms(2026, 6, 1, hour = 0)),
        )
        val metrics = MoneyRollup.compute(emptyList(), sales, now, ZONE, Locale.US)
        // The boundary is the seller's LOCAL start-of-month. Bucketing in UTC
        // would pull the 31st 23:00 sale into June for anyone west of Greenwich.
        assertEquals(25.0, metrics.revenueThisMonth, 1e-9)
    }

    @Test
    fun theChartHasSixMonthsOldestFirstIncludingEmptyOnes() {
        val sales = listOf(sale("s1", "i1", salePrice = 60.0, saleDate = ms(2026, 4, 10)))
        val series = MoneyRollup.compute(emptyList(), sales, now, ZONE, Locale.US).monthlyRevenue

        assertEquals(6, series.size)
        // Oldest first, current month last — the chart reads left-to-right.
        assertEquals("2026-1", series.first().id)
        assertEquals("2026-6", series.last().id)
        // A quiet month is PRESENT with zero, not skipped: skipping compresses
        // the x-axis and makes a flat run look like growth.
        assertEquals(60.0, series.single { it.id == "2026-4" }.revenue, 1e-9)
        assertEquals(0.0, series.single { it.id == "2026-5" }.revenue, 1e-9)
    }

    @Test
    fun monthWindowsUseMonthArithmeticNotThirtyDays() {
        // February is 28 days. A fixed 30-day window would leak a March sale
        // into February's bucket.
        val sales = listOf(
            sale("feb", "i1", salePrice = 10.0, saleDate = ms(2026, 2, 27)),
            sale("mar", "i1", salePrice = 20.0, saleDate = ms(2026, 3, 1)),
        )
        val series = MoneyRollup.monthlySeries(sales, ms(2026, 3, 15), 3, ZONE, Locale.US)
        assertEquals(10.0, series.single { it.id == "2026-2" }.revenue, 1e-9)
        assertEquals(20.0, series.single { it.id == "2026-3" }.revenue, 1e-9)
    }

    @Test
    fun manySmallAmountsSumWithoutFloatDrift() {
        // US-790: 100 × 24.99 is 2499.00 exactly. Naive Double accumulation
        // drifts past a cent on sets this size, and the seller reconciles these
        // figures against a payout statement.
        val sales = (1..100).map {
            sale("s$it", "i1", salePrice = 24.99, saleDate = ms(2026, 6, 10))
        }
        val metrics = MoneyRollup.compute(emptyList(), sales, now, ZONE, Locale.US)
        assertEquals(2499.00, metrics.revenueThisMonth, 0.0)
    }

    @Test
    fun emptyInputIsZeroNotAnError() {
        val metrics = MoneyRollup.compute(emptyList(), emptyList(), now, ZONE, Locale.US)
        assertEquals(0.0, metrics.revenueThisMonth, 1e-9)
        assertEquals(0.0, metrics.netProfitThisMonth, 1e-9)
        assertNull(metrics.roiThisMonth)
        assertTrue(metrics.monthlyRevenue.all { it.revenue == 0.0 })
    }
}
