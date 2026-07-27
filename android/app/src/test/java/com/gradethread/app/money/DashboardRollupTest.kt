package com.gradethread.app.money

import com.gradethread.app.inventory.InventoryStage
import com.gradethread.app.money.MoneyFixtures.ZONE
import com.gradethread.app.money.MoneyFixtures.item
import com.gradethread.app.money.MoneyFixtures.ms
import com.gradethread.app.money.MoneyFixtures.sale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1370 AC1: the home snapshot + sparkline math.
 */
class DashboardRollupTest {

    private val now = ms(2026, 6, 20)
    private val day = DashboardRollup.DAY_MS

    // ── On-hand / inventory value ────────────────────────────────────────────

    @Test
    fun onHandExcludesRealizedAndParkedStatuses() {
        listOf("sold", "shipped", "completed", "returned", "archived", "keeping", "wearing")
            .forEach { assertFalse(it, DashboardRollup.isOnHand(it)) }
        listOf("sourced", "cataloged", "photographed", "listed", "drafted", "grading")
            .forEach { assertTrue(it, DashboardRollup.isOnHand(it)) }
    }

    @Test
    fun onHandIsDerivedFromTheKnownStatusSetBySubtraction() {
        // The point of deriving rather than listing: a new pipeline status added
        // to InventoryStage counts as on-hand automatically instead of being
        // silently omitted from inventory value.
        assertTrue(DashboardRollup.onHandStatuses.all { it in InventoryStage.allKnownStatuses })
    }

    @Test
    fun inventoryValuePrefersListingThenTargetThenCost() {
        // MARKET value, matching what eBay reports — not cost basis, which is
        // null for imported items and unrelated to the number sellers compare.
        val items = listOf(
            item("a", acquiredPrice = 5.0, targetPrice = 20.0, listingPrice = 30.0),
            item("b", acquiredPrice = 5.0, targetPrice = 20.0),
            item("c", acquiredPrice = 5.0),
            item("d"),
        )
        val metrics = DashboardRollup.compute(items, emptyList(), now)
        assertEquals(55.0, metrics.inventoryValue, 1e-9)
        assertEquals(4, metrics.onHandCount)
    }

    @Test
    fun soldItemsDoNotHoldInventoryValue() {
        val items = listOf(
            item("a", status = "listed", listingPrice = 30.0),
            item("b", status = "sold", listingPrice = 999.0),
        )
        val metrics = DashboardRollup.compute(items, emptyList(), now)
        assertEquals(30.0, metrics.inventoryValue, 1e-9)
        assertEquals(1, metrics.onHandCount)
        assertEquals(1, metrics.listedCount)
    }

    // ── This week ────────────────────────────────────────────────────────────

    @Test
    fun theWeekWindowIsTrailingSevenDays() {
        val sales = listOf(
            sale("in", "i1", salePrice = 50.0, saleDate = now - 6 * day),
            sale("out", "i1", salePrice = 500.0, saleDate = now - 8 * day),
        )
        val metrics = DashboardRollup.compute(emptyList(), sales, now)
        assertEquals(1, metrics.soldThisWeekCount)
        assertEquals(50.0, metrics.revenueThisWeek, 1e-9)
    }

    @Test
    fun weekProfitNetsCostBasisAndAllFees() {
        val items = listOf(item("i1", acquiredPrice = 15.0))
        val sales = listOf(
            sale(
                "s1", "i1",
                salePrice = 100.0,
                platformFees = 12.0,
                paymentProcessingFees = 3.0,
                shippingCost = 5.0,
                gradingCost = 2.0,
                saleDate = now - day,
            ),
        )
        val metrics = DashboardRollup.compute(items, sales, now)
        // 100 − (12+3) − (5+2) − 15
        assertEquals(63.0, metrics.netProfitThisWeek, 1e-9)
    }

    @Test
    fun anOrphanSaleContributesRevenueButNoCostBasis() {
        // The item may simply not have synced yet. Zero cost, never a crash.
        val sales = listOf(sale("s1", "missing-item", salePrice = 40.0, saleDate = now - day))
        val metrics = DashboardRollup.compute(emptyList(), sales, now)
        assertEquals(40.0, metrics.revenueThisWeek, 1e-9)
        assertEquals(40.0, metrics.netProfitThisWeek, 1e-9)
    }

    @Test
    fun refundedSalesAreExcludedFromTheWeek() {
        val sales = listOf(
            sale("ok", "i1", salePrice = 10.0, saleDate = now - day),
            sale("bad", "i1", salePrice = 999.0, status = "refunded", saleDate = now - day),
        )
        val metrics = DashboardRollup.compute(emptyList(), sales, now)
        assertEquals(1, metrics.soldThisWeekCount)
        assertEquals(10.0, metrics.revenueThisWeek, 1e-9)
    }

    // ── Aging ────────────────────────────────────────────────────────────────

    @Test
    fun agingCountsOnHandItemsUntouchedForFourteenDays() {
        val items = listOf(
            item("fresh", status = "listed", updatedAt = now - 2 * day),
            item("stale", status = "listed", updatedAt = now - 30 * day),
            // A sold item sitting untouched is not idle capital.
            item("sold", status = "sold", updatedAt = now - 90 * day),
        )
        val metrics = DashboardRollup.compute(items, emptyList(), now)
        assertEquals(1, metrics.agingCount)
    }

    @Test
    fun aFutureUpdatedAtReadsAsNotAging() {
        // Clock skew, not a 40-year-old garment.
        val skewed = item("x", status = "listed", updatedAt = now + 10 * day)
        assertFalse(DashboardRollup.isAging(skewed, now))
    }

    @Test
    fun theAgingListAndTheAgingCountCannotDisagree() {
        // They drifted on iOS when derived separately, and a card reading
        // "3 items aging" above a list of two is what sellers screenshot.
        val items = (1..8).map {
            item("i$it", status = "listed", updatedAt = now - (it * 5L) * day)
        }
        val metrics = DashboardRollup.compute(items, emptyList(), now)
        val listed = DashboardRollup.agingItems(items, now, limit = 100)
        assertEquals(metrics.agingCount, listed.size)
    }

    @Test
    fun theAgingListIsOldestTouchedFirstAndCapped() {
        val items = (1..10).map {
            item("i$it", status = "listed", updatedAt = now - (20L + it) * day)
        }
        val listed = DashboardRollup.agingItems(items, now, limit = 3)
        assertEquals(3, listed.size)
        assertEquals("i10", listed.first().id)
    }

    // ── Date helpers ─────────────────────────────────────────────────────────

    @Test
    fun daysBetweenCountsLocalDatesNotMillis() {
        // Across a DST boundary a day is 23 or 25 hours. Dividing millis reports
        // 13 days for a fortnight every spring.
        val march1 = ms(2026, 3, 1, hour = 12)
        val march15 = ms(2026, 3, 15, hour = 12)
        assertEquals(14, DashboardRollup.daysBetween(march1, march15, ZONE))
    }

    @Test
    fun daysBetweenClampsAtZeroForAReversedRange() {
        assertEquals(0, DashboardRollup.daysBetween(now, now - 5 * day, ZONE))
    }

    // ── Sparkline ────────────────────────────────────────────────────────────

    @Test
    fun theSparklineSeedsEveryDayIncludingQuietOnes() {
        val sales = listOf(sale("s1", "i1", salePrice = 30.0, saleDate = now - 3 * day))
        val points = DashboardTrend.dailySeries(sales, emptyList(), 14, now, ZONE)

        assertEquals(14, points.size)
        // Oldest first, today last.
        assertTrue(points.first().dayStartMs < points.last().dayStartMs)
        assertEquals(30.0, points.single { it.revenue > 0 }.revenue, 1e-9)
        assertEquals(13, points.count { it.revenue == 0.0 })
        assertTrue(DashboardTrend.hasActivity(points))
    }

    @Test
    fun theSparklineExcludesRefundsSoItAgreesWithTheCardAboveIt() {
        val sales = listOf(
            sale("ok", "i1", salePrice = 20.0, saleDate = now - day),
            sale("bad", "i1", salePrice = 800.0, status = "refunded", saleDate = now - day),
        )
        val points = DashboardTrend.dailySeries(sales, emptyList(), 14, now, ZONE)
        assertEquals(20.0, Money.sum(points) { it.revenue }, 1e-9)
    }

    @Test
    fun salesOutsideTheWindowAreIgnoredNotClamped() {
        val sales = listOf(sale("old", "i1", salePrice = 900.0, saleDate = now - 60 * day))
        val points = DashboardTrend.dailySeries(sales, emptyList(), 14, now, ZONE)
        assertFalse(DashboardTrend.hasActivity(points))
    }

    @Test
    fun anEmptyWindowIsEmptyRatherThanASingleZeroPoint() {
        assertTrue(DashboardTrend.dailySeries(emptyList(), emptyList(), 0, now, ZONE).isEmpty())
    }

    @Test
    fun sparklineProfitNetsCostBasis() {
        val items = listOf(item("i1", acquiredPrice = 5.0))
        val sales = listOf(
            sale("s1", "i1", salePrice = 25.0, platformFees = 2.0, saleDate = now - day),
        )
        val points = DashboardTrend.dailySeries(sales, items, 14, now, ZONE)
        assertEquals(18.0, Money.sum(points) { it.profit }, 1e-9)
    }
}
