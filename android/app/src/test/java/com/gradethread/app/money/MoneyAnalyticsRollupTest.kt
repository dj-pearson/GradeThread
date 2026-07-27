package com.gradethread.app.money

import com.gradethread.app.money.MoneyFixtures.ZONE
import com.gradethread.app.money.MoneyFixtures.expense
import com.gradethread.app.money.MoneyFixtures.item
import com.gradethread.app.money.MoneyFixtures.ms
import com.gradethread.app.money.MoneyFixtures.sale
import com.gradethread.app.money.MoneyFixtures.source
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * US-1363 AC1/AC3: aging, time-on-market, cash flow, per-item P&L and
 * ROI-by-source — every panel computed with no I/O.
 */
class MoneyAnalyticsRollupTest {

    private val now = ms(2026, 6, 20)
    private val day = DashboardRollup.DAY_MS

    // ── Inventory aging ──────────────────────────────────────────────────────

    @Test
    fun agingAlwaysReturnsAllFourBracketsInOrder() {
        // A stable x-axis: brackets that vanish when empty make the histogram
        // re-scale on every refresh.
        val brackets = MoneyAnalyticsRollup.inventoryAging(emptyList(), now, ZONE)
        assertEquals(
            listOf("0-14 days", "15-30 days", "31-60 days", "60+ days"),
            brackets.map { it.label },
        )
        assertTrue(brackets.all { it.count == 0 && it.value == 0.0 })
    }

    @Test
    fun agingBucketsOnTheInclusiveUpperBound() {
        // The bounds are INCLUSIVE, so day 14 is the last of "0-14" and day 30
        // the last of "15-30". Both edges are pinned here because an off-by-one
        // silently moves capital between brackets on the panel sellers use to
        // decide what to discount.
        val items = listOf(
            item("edge14", createdAt = now - 14 * day, acquiredPrice = 1.0),
            item("first15", createdAt = now - 15 * day, acquiredPrice = 2.0),
            item("edge30", createdAt = now - 30 * day, acquiredPrice = 4.0),
            item("first31", createdAt = now - 31 * day, acquiredPrice = 8.0),
            item("old", createdAt = now - 61 * day, acquiredPrice = 16.0),
        )
        val byLabel = MoneyAnalyticsRollup.inventoryAging(items, now, ZONE).associateBy { it.label }
        assertEquals(1, byLabel.getValue("0-14 days").count)
        assertEquals(1.0, byLabel.getValue("0-14 days").value, 1e-9)
        // Day 15 AND day 30 both live here — 2 + 4.
        assertEquals(2, byLabel.getValue("15-30 days").count)
        assertEquals(6.0, byLabel.getValue("15-30 days").value, 1e-9)
        assertEquals(8.0, byLabel.getValue("31-60 days").value, 1e-9)
        assertEquals(16.0, byLabel.getValue("60+ days").value, 1e-9)
    }

    @Test
    fun agingAnchorsOnAcquiredDateWhenKnown() {
        // US-1246: `createdAt` is when the LOCAL MIRROR row appeared. An item
        // bought a year ago and imported today would otherwise show as brand new
        // and never trigger an aging nudge.
        val imported = item(
            "old",
            createdAt = now,
            acquiredDate = now - 200 * day,
            acquiredPrice = 3.0,
        )
        val byLabel = MoneyAnalyticsRollup.inventoryAging(listOf(imported), now, ZONE)
            .associateBy { it.label }
        assertEquals(1, byLabel.getValue("60+ days").count)
        assertEquals(0, byLabel.getValue("0-14 days").count)
    }

    @Test
    fun agingIgnoresSoldStock() {
        val items = listOf(item("sold", status = "sold", createdAt = now - 90 * day, acquiredPrice = 9.0))
        assertTrue(MoneyAnalyticsRollup.inventoryAging(items, now, ZONE).all { it.count == 0 })
    }

    // ── Time on market ───────────────────────────────────────────────────────

    @Test
    fun timeOnMarketAveragesDaysFromAcquisitionToSale() {
        val items = listOf(
            item("a", createdAt = now - 40 * day),
            item("b", createdAt = now - 20 * day),
        )
        val sales = listOf(
            sale("s1", "a", saleDate = now - 30 * day), // 10 days
            sale("s2", "b", saleDate = now - 16 * day), // 4 days
        )
        val stats = MoneyAnalyticsRollup.timeOnMarket(items, sales, now, ZONE)
        // (10 + 4) / 2
        assertEquals(7.0, stats.averageDays!!, 1e-9)
        assertEquals(2, stats.soldCount)
        assertTrue(stats.hasData)
        val byLabel = stats.distribution.associateBy { it.label }
        assertEquals(1, byLabel.getValue("≤7 days").count)
        assertEquals(1, byLabel.getValue("8-30 days").count)
        assertEquals(0, byLabel.getValue("90+ days").count)
    }

    @Test
    fun timeOnMarketSkipsSalesWhoseItemIsUnknown() {
        // No acquisition date to anchor on — assuming one would invent a
        // holding period. (The P&L list deliberately does the opposite.)
        val stats = MoneyAnalyticsRollup.timeOnMarket(
            emptyList(),
            listOf(sale("s1", "missing", saleDate = now)),
            now,
            ZONE,
        )
        assertEquals(TimeOnMarketStats.EMPTY, stats)
        assertFalse(stats.hasData)
        assertNull(stats.averageDays)
    }

    @Test
    fun timeOnMarketExcludesRefundedSales() {
        val items = listOf(item("a", createdAt = now - 40 * day))
        val stats = MoneyAnalyticsRollup.timeOnMarket(
            items,
            listOf(sale("s1", "a", status = "refunded", saleDate = now - 30 * day)),
            now,
            ZONE,
        )
        assertFalse(stats.hasData)
    }

    @Test
    fun aSaleBeforeItsCachedAcquisitionDateClampsToZeroDays() {
        val items = listOf(item("a", createdAt = now))
        val stats = MoneyAnalyticsRollup.timeOnMarket(
            items,
            listOf(sale("s1", "a", saleDate = now - 5 * day)),
            now,
            ZONE,
        )
        assertEquals(0.0, stats.averageDays!!, 1e-9)
    }

    // ── Cash flow ────────────────────────────────────────────────────────────

    @Test
    fun cashFlowSeparatesRevenueExpensesAndCogs() {
        val items = listOf(item("i1", acquiredPrice = 12.0))
        val sales = listOf(sale("s1", "i1", salePrice = 100.0, saleDate = ms(2026, 6, 10)))
        val expenses = listOf(expense("e1", amount = 30.0, spentOn = ms(2026, 6, 11)))

        val june = MoneyAnalyticsRollup
            .cashFlow(items, sales, expenses, now, 6, ZONE, Locale.US)
            .single { it.id == "2026-6" }

        assertEquals(100.0, june.revenue, 1e-9)
        assertEquals(30.0, june.expenses, 1e-9)
        assertEquals(12.0, june.costBasis, 1e-9)
        // net is ONE subtraction over already-rounded components, so no drift.
        assertEquals(58.0, june.net, 1e-9)
    }

    @Test
    fun expensesAreNotSaleStatusFiltered() {
        // Money that left is gone regardless of how any sale turned out.
        val expenses = listOf(expense("e1", amount = 25.0, spentOn = ms(2026, 6, 2)))
        val refunded = listOf(sale("s1", "i1", salePrice = 90.0, status = "refunded", saleDate = ms(2026, 6, 3)))
        val june = MoneyAnalyticsRollup
            .cashFlow(emptyList(), refunded, expenses, now, 6, ZONE, Locale.US)
            .single { it.id == "2026-6" }
        assertEquals(0.0, june.revenue, 1e-9)
        assertEquals(25.0, june.expenses, 1e-9)
        // A month that only spent money nets negative — that's the signal.
        assertEquals(-25.0, june.net, 1e-9)
    }

    @Test
    fun cashFlowCoversTheRequestedMonthsOldestFirst() {
        val series = MoneyAnalyticsRollup
            .cashFlow(emptyList(), emptyList(), emptyList(), now, 6, ZONE, Locale.US)
        assertEquals(6, series.size)
        assertEquals("2026-1", series.first().id)
        assertEquals("2026-6", series.last().id)
    }

    // ── Per-item P&L ─────────────────────────────────────────────────────────

    @Test
    fun profitRowsJoinTheItemForTitleAndCostBasis() {
        val items = listOf(item("i1", title = "Wool coat", acquiredPrice = 20.0))
        val sales = listOf(
            sale(
                "s1", "i1",
                salePrice = 100.0,
                shippingCollected = 10.0,
                platformFees = 13.0,
                shippingCost = 7.0,
                saleDate = now,
            ),
        )
        val row = MoneyAnalyticsRollup.itemProfitRows(items, sales).single()
        assertEquals("Wool coat", row.title)
        assertEquals(110.0, row.revenue, 1e-9)
        assertEquals(13.0, row.fees, 1e-9)
        assertEquals(20.0, row.costBasis, 1e-9)
        // 110 − 13 − 7 − 20
        assertEquals(70.0, row.netProfit, 1e-9)
        assertEquals(3.5, row.roi!!, 1e-9)
    }

    @Test
    fun aSaleWithNoLocalItemStillProducesARow() {
        // Dropping it would lose realized revenue from the list; the item may
        // just not have synced yet.
        val row = MoneyAnalyticsRollup
            .itemProfitRows(emptyList(), listOf(sale("s1", "gone", salePrice = 40.0)))
            .single()
        assertEquals("Untitled item", row.title)
        assertEquals(0.0, row.costBasis, 1e-9)
        assertNull(row.roi)
    }

    @Test
    fun profitRowsExcludeReversedSales() {
        val sales = listOf(
            sale("ok", "i1", saleDate = now),
            sale("bad", "i1", status = "refunded", saleDate = now),
        )
        assertEquals(
            listOf("ok"),
            MoneyAnalyticsRollup.itemProfitRows(emptyList(), sales).map { it.saleId },
        )
    }

    @Test
    fun roiSortPutsUnknownCostBasisLastNotFirst() {
        // A no-cost-basis row sorting as 0% would take the top slots on a
        // loss-making set, which is exactly when the panel matters.
        val items = listOf(
            item("hi", acquiredPrice = 10.0),
            item("lo", acquiredPrice = 100.0),
        )
        val sales = listOf(
            sale("s-hi", "hi", salePrice = 50.0, saleDate = now - day),
            sale("s-lo", "lo", salePrice = 40.0, saleDate = now - 2 * day),
            sale("s-none", "unknown", salePrice = 60.0, saleDate = now - 3 * day),
        )
        val sorted = MoneyAnalyticsRollup.sortProfitRows(
            MoneyAnalyticsRollup.itemProfitRows(items, sales),
            ItemProfitSort.ROI,
        )
        assertEquals("s-hi", sorted.first().saleId)
        assertEquals("s-none", sorted.last().saleId)
        assertNull(sorted.last().roi)
    }

    @Test
    fun profitSortIsHighestFirstAndTiesBreakOnRecency() {
        val sales = listOf(
            sale("older", "x", salePrice = 50.0, saleDate = now - 5 * day),
            sale("newer", "x", salePrice = 50.0, saleDate = now - day),
        )
        val sorted = MoneyAnalyticsRollup.sortProfitRows(
            MoneyAnalyticsRollup.itemProfitRows(emptyList(), sales),
            ItemProfitSort.PROFIT,
        )
        // A total order, so the list doesn't reshuffle between recompositions.
        assertEquals(listOf("newer", "older"), sorted.map { it.saleId })
    }

    @Test
    fun recentSortIsMostRecentFirst() {
        val sales = listOf(
            sale("a", "x", saleDate = now - 9 * day),
            sale("b", "x", saleDate = now - day),
        )
        val sorted = MoneyAnalyticsRollup.sortProfitRows(
            MoneyAnalyticsRollup.itemProfitRows(emptyList(), sales),
            ItemProfitSort.RECENT,
        )
        assertEquals(listOf("b", "a"), sorted.map { it.saleId })
    }

    // ── ROI by source ────────────────────────────────────────────────────────

    @Test
    fun sourceRoiGroupsSpendAndRealizedProfit() {
        val sources = listOf(source("src1", "Goodwill"))
        val items = listOf(
            item("i1", sourceId = "src1", acquiredPrice = 10.0),
            item("i2", sourceId = "src1", acquiredPrice = 20.0),
        )
        val sales = listOf(
            sale("s1", "i1", salePrice = 60.0, platformFees = 6.0, saleDate = now),
        )
        val row = SourceRoiRollup.bySource(items, sales, sources).single()

        assertEquals("Goodwill", row.sourceName)
        assertEquals(2, row.acquiredCount)
        assertEquals(1, row.soldCount)
        // Spend is ALL items from the source, not just the sold one.
        assertEquals(30.0, row.spend, 1e-9)
        assertEquals(60.0, row.revenue, 1e-9)
        assertEquals(10.0, row.cogs, 1e-9)
        // 60 − 6 − 10
        assertEquals(44.0, row.netProfit, 1e-9)
        // ROI is on TOTAL sourcing spend: 44 / 30
        assertEquals(44.0 / 30.0, row.roi!!, 1e-9)
        assertEquals(0.5, row.sellThrough, 1e-9)
    }

    @Test
    fun sourceRoiCountsAllFeesNotJustPlatformFees() {
        // platformFees alone understated fees and overstated every source's ROI.
        val items = listOf(item("i1", sourceId = "s", acquiredPrice = 10.0))
        val sales = listOf(
            sale("x", "i1", salePrice = 50.0, platformFees = 5.0, paymentProcessingFees = 2.0, saleDate = now),
        )
        val row = SourceRoiRollup.bySource(items, sales, listOf(source("s", "Estate"))).single()
        assertEquals(7.0, row.fees, 1e-9)
    }

    @Test
    fun unattributedItemsRollUpSoSpendAlwaysReconciles() {
        val items = listOf(
            item("i1", sourceId = null, acquiredPrice = 15.0),
            item("i2", sourceId = "src1", acquiredPrice = 5.0),
        )
        val rows = SourceRoiRollup.bySource(items, emptyList(), listOf(source("src1", "Bins")))
        val total = Money.sum(rows) { it.spend }
        assertEquals(20.0, total, 1e-9)
        assertTrue(rows.any { it.sourceName == SourceRoiRollup.UNATTRIBUTED_NAME })
    }

    @Test
    fun anUnknownSourceIdFallsBackToAShortIdRatherThanBlank() {
        val items = listOf(item("i1", sourceId = "abcdef123456", acquiredPrice = 1.0))
        val row = SourceRoiRollup.bySource(items, emptyList(), emptyList()).single()
        // Never blank — the source row may simply not have synced yet.
        assertEquals("Source abcdef", row.sourceName)
    }

    @Test
    fun sourceRoiIsRealizedNotMarkToMarket() {
        // Spent, nothing sold yet: net profit is 0 and ROI is 0%, NOT −100%.
        //
        // This surprises people, so it is pinned deliberately. `netProfit` is
        // revenue − fees − COGS *of sold items*, so unsold stock contributes to
        // `spend` but not to profit. It is a REALIZED figure: the source hasn't
        // lost the money, it just hasn't returned any yet. iOS defines it the
        // same way, and diverging here would make the same source read
        // differently on phone and tablet.
        val items = listOf(item("i1", sourceId = "s", acquiredPrice = 100.0))
        val row = SourceRoiRollup.bySource(items, emptyList(), listOf(source("s", "Estate"))).single()
        assertEquals(100.0, row.spend, 1e-9)
        assertEquals(0.0, row.netProfit, 1e-9)
        assertEquals(0.0, row.roi!!, 1e-9)
        assertEquals(0.0, row.sellThrough, 1e-9)
    }

    @Test
    fun sourceRoiExcludesReversedSales() {
        val items = listOf(item("i1", sourceId = "s", acquiredPrice = 10.0))
        val sales = listOf(sale("x", "i1", salePrice = 500.0, status = "refunded", saleDate = now))
        val row = SourceRoiRollup.bySource(items, sales, listOf(source("s", "Estate"))).single()
        assertEquals(0, row.soldCount)
        assertEquals(0.0, row.revenue, 1e-9)
    }

    @Test
    fun sourceRoiIsHighestProfitFirst() {
        val items = listOf(
            item("a", sourceId = "s1", acquiredPrice = 5.0),
            item("b", sourceId = "s2", acquiredPrice = 5.0),
        )
        val sales = listOf(
            sale("sa", "a", salePrice = 20.0, saleDate = now),
            sale("sb", "b", salePrice = 90.0, saleDate = now),
        )
        val rows = SourceRoiRollup.bySource(
            items,
            sales,
            listOf(source("s1", "Alpha"), source("s2", "Beta")),
        )
        assertEquals(listOf("Beta", "Alpha"), rows.map { it.sourceName })
    }
}
