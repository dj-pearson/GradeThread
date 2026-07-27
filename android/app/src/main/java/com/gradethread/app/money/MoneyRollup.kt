package com.gradethread.app.money

import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/** One month's revenue bucket for the chart. */
data class MonthlyRevenue(
    /** `"YYYY-M"` — a stable key for the chart's item loop. */
    val id: String,
    val monthStartMs: Long,
    /** Short month label, e.g. "May". */
    val label: String,
    val revenue: Double,
)

/**
 * This-month financial rollup + a 6-month revenue series (iOS `MoneyMetrics`).
 * Operating expenses are layered on by the caller from the expenses table.
 */
data class MoneyMetrics(
    val revenueThisMonth: Double,
    /**
     * Realized NET profit on this month's completed sales, through
     * [SalePnL.net] — the SAME definition Home and Analytics use. This is BEFORE
     * operating expenses. (On iOS this field was once named `grossProfit` and
     * meant something else; the rename was the fix.)
     */
    val netProfitThisMonth: Double,
    /**
     * Return on cost basis = [netProfitThisMonth] / cost basis. Null when no
     * cost basis is recorded: dividing by zero isn't possible and showing `0%`
     * would read as "made nothing" rather than "cost unknown".
     */
    val roiThisMonth: Double?,
    /** Last 6 months of revenue, oldest → newest (current month last). */
    val monthlyRevenue: List<MonthlyRevenue>,
) {
    companion object {
        val EMPTY = MoneyMetrics(0.0, 0.0, null, emptyList())
    }
}

/** US-1363 (iOS `MoneyRollup`). */
object MoneyRollup {

    const val CHART_MONTHS = 6

    fun compute(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        nowMs: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): MoneyMetrics {
        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }
        val startOfMonth = DashboardRollup.startOfMonth(nowMs, zone)

        // Only COMPLETED sales count toward revenue/profit (00111).
        val monthSales = sales.filter { it.saleDate >= startOfMonth && SalePnL.isCompleted(it) }
        val revenue = Money.sum(monthSales) { SalePnL.revenue(it) }
        val cost = Money.sum(monthSales) { costById[it.inventoryItemId] ?: 0.0 }
        val netProfit = Money.sum(monthSales) {
            SalePnL.net(it, costById[it.inventoryItemId] ?: 0.0)
        }

        return MoneyMetrics(
            revenueThisMonth = revenue,
            netProfitThisMonth = netProfit,
            roiThisMonth = if (cost > 0) netProfit / cost else null,
            monthlyRevenue = monthlySeries(sales, nowMs, CHART_MONTHS, zone, locale),
        )
    }

    /** Revenue per month for the trailing [months], oldest first. */
    fun monthlySeries(
        sales: List<SaleEntity>,
        nowMs: Long,
        months: Int = CHART_MONTHS,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): List<MonthlyRevenue> {
        val thisMonth = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().withDayOfMonth(1)
        return (months - 1 downTo 0).map { offset ->
            val monthStart = thisMonth.minusMonths(offset.toLong())
            val startMs = monthStart.atStartOfDay(zone).toInstant().toEpochMilli()
            // Month-arithmetic, not +30 days: month lengths differ, and a
            // fixed-width window double-counts or skips around February.
            val endMs = monthStart.plusMonths(1).atStartOfDay(zone).toInstant().toEpochMilli()
            MonthlyRevenue(
                id = "${monthStart.year}-${monthStart.monthValue}",
                monthStartMs = startMs,
                label = monthStart.month.getDisplayName(TextStyle.SHORT, locale),
                revenue = Money.sum(
                    sales.filter {
                        it.saleDate >= startMs && it.saleDate < endMs && SalePnL.isCompleted(it)
                    },
                ) { SalePnL.revenue(it) },
            )
        }
    }
}
