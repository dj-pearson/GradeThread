package com.gradethread.app.money

import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity
import java.time.ZoneId

/** One day's rolled-up selling figures — the sparkline's data point. */
data class TrendPoint(val dayStartMs: Long, val revenue: Double, val profit: Double)

/**
 * US-1370 (iOS GradeThreadCore/DashboardTrend.swift): the home sparkline series.
 *
 * Revenue and profit go through [SalePnL] and only COMPLETED sales count, so the
 * sparkline agrees with the KPI card above it instead of double-counting refunds
 * or using a divergent fees-only profit formula. (iOS learned that one the hard
 * way: two definitions of "profit" on one screen.)
 */
object DashboardTrend {

    const val DEFAULT_DAYS = 14

    /**
     * Bucket sales into one point per day across the trailing [days] window,
     * inclusive of today, oldest → newest.
     *
     * Days with no sales are PRESENT with zeros rather than skipped: a sparkline
     * drawn from only the days that had sales compresses a quiet fortnight into
     * a spike and reads as growth.
     */
    fun dailySeries(
        sales: List<SaleEntity>,
        items: List<InventoryItemEntity>,
        days: Int = DEFAULT_DAYS,
        nowMs: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<TrendPoint> {
        if (days <= 0) return emptyList()

        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }
        val today = DashboardRollup.startOfDay(nowMs, zone)

        // Seed every day in the window, then accumulate into it. Keyed by
        // start-of-day millis so a sale lands in the seller's local day.
        val ordered = (0 until days).map { offset ->
            DashboardRollup.startOfDay(today - (days - 1 - offset) * DashboardRollup.DAY_MS, zone)
        }
        val revenue = LinkedHashMap<Long, MutableList<Double>>()
        val profit = LinkedHashMap<Long, MutableList<Double>>()
        ordered.forEach { day ->
            revenue[day] = mutableListOf()
            profit[day] = mutableListOf()
        }

        for (sale in sales) {
            if (!SalePnL.isCompleted(sale)) continue
            val day = DashboardRollup.startOfDay(sale.saleDate, zone)
            // Outside the window — not an error, just not this chart's business.
            val revenueBucket = revenue[day] ?: continue
            revenueBucket += SalePnL.revenue(sale)
            profit[day]?.plusAssign(SalePnL.net(sale, costById[sale.inventoryItemId] ?: 0.0))
        }

        return ordered.map { day ->
            TrendPoint(
                dayStartMs = day,
                // Summed through Money so a day's figure foots against the KPI
                // card, which sums the same values the same way.
                revenue = Money.sum(revenue[day].orEmpty()),
                profit = Money.sum(profit[day].orEmpty()),
            )
        }
    }

    /** Whether the window has anything worth charting. */
    fun hasActivity(points: List<TrendPoint>): Boolean =
        points.any { it.revenue != 0.0 || it.profit != 0.0 }
}
