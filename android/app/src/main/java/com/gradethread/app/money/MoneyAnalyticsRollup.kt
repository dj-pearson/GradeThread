package com.gradethread.app.money

import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/**
 * US-1363 (iOS `MoneyAnalyticsRollup`): the Money tab's panels beyond the KPI
 * row — inventory aging, time-on-market, a cash-flow series and a per-item P&L
 * list. Pure rollups over the Room mirror; no view-layer math, so every figure
 * is unit-testable without a database.
 *
 * ROI-by-source lives in [SourceRoiRollup] (shared with Analytics) rather than
 * being re-derived here.
 */

/** One age bracket of on-hand inventory: how many items, and capital tied up. */
data class AgingBracket(val label: String, val count: Int, val value: Double)

/** One days-to-sell bucket of completed sales. */
data class TimeOnMarketBucket(val label: String, val count: Int)

data class TimeOnMarketStats(
    /** Mean days from acquisition to sale. Null when there's nothing to average. */
    val averageDays: Double?,
    val soldCount: Int,
    val distribution: List<TimeOnMarketBucket>,
) {
    val hasData: Boolean get() = soldCount > 0

    companion object {
        val EMPTY = TimeOnMarketStats(null, 0, emptyList())
    }
}

/** One month of cash flow: money in (revenue) vs money out (expenses + COGS). */
data class CashFlowMonth(
    val id: String,
    val monthStartMs: Long,
    val label: String,
    val revenue: Double,
    val expenses: Double,
    val costBasis: Double,
) {
    /**
     * Revenue minus money out. A SINGLE subtraction — the component sums are
     * already cents-rounded, so no drift accumulates.
     */
    val net: Double get() = revenue - expenses - costBasis
}

/** One sold item's realized profit & loss line. */
data class ItemProfitRow(
    val saleId: String,
    val itemId: String,
    val title: String,
    val saleDateMs: Long,
    /** Gross revenue (sale price + shipping collected). */
    val revenue: Double,
    val fees: Double,
    val costBasis: Double,
    /** revenue − fees − seller costs − cost basis ([SalePnL.net]). */
    val netProfit: Double,
) {
    /** Return on cost basis; null when none was recorded — show "—", not 0%. */
    val roi: Double? get() = if (costBasis > 0) netProfit / costBasis else null
}

enum class ItemProfitSort(val label: String) {
    RECENT("Recent"),
    PROFIT("Profit"),
    ROI("ROI"),
}

object MoneyAnalyticsRollup {

    // ── Inventory aging ──────────────────────────────────────────────────────

    /**
     * Age brackets in display order; `upperDays` is the INCLUSIVE upper bound in
     * days held, and the final open bracket is null. Mirrors the web labels.
     */
    val agingBrackets: List<Pair<String, Int?>> = listOf(
        "0-14 days" to 14,
        "15-30 days" to 30,
        "31-60 days" to 60,
        "60+ days" to null,
    )

    private fun agingLabel(days: Int): String =
        agingBrackets.firstOrNull { (_, upper) -> upper == null || days <= upper }?.first
            ?: agingBrackets.last().first

    /**
     * On-hand inventory bucketed by holding time, with the cost basis in each
     * bracket. ALWAYS returns all four brackets, zero-filled, so the histogram's
     * x-axis is stable between refreshes; the view shows an empty state when
     * every count is zero.
     */
    fun inventoryAging(
        items: List<InventoryItemEntity>,
        nowMs: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<AgingBracket> {
        val counts = mutableMapOf<String, Int>()
        val values = mutableMapOf<String, MutableList<Double>>()
        for (item in items) {
            if (!DashboardRollup.isOnHand(item.status)) continue
            // US-1246: anchor on the real acquisition date when known.
            // `createdAt` is when the LOCAL MIRROR row was created, which
            // understates age for backfilled/imported items — an item bought a
            // year ago would show up in the 0-14 bracket the day it synced.
            val acquired = item.acquiredDate ?: item.createdAt
            val label = agingLabel(DashboardRollup.daysBetween(acquired, nowMs, zone))
            counts[label] = (counts[label] ?: 0) + 1
            values.getOrPut(label) { mutableListOf() } += (item.acquiredPrice ?: 0.0)
        }
        return agingBrackets.map { (label, _) ->
            AgingBracket(
                label = label,
                count = counts[label] ?: 0,
                // Exact sum so the tied-up capital foots to the cent.
                value = Money.sum(values[label].orEmpty()),
            )
        }
    }

    // ── Time on market ───────────────────────────────────────────────────────

    val timeOnMarketBuckets: List<Pair<String, Int?>> = listOf(
        "≤7 days" to 7,
        "8-30 days" to 30,
        "31-60 days" to 60,
        "61-90 days" to 90,
        "90+ days" to null,
    )

    private fun timeOnMarketLabel(days: Int): String =
        timeOnMarketBuckets.firstOrNull { (_, upper) -> upper == null || days <= upper }?.first
            ?: timeOnMarketBuckets.last().first

    /**
     * Average + distribution of days-to-sell across completed sales.
     *
     * A sale whose item isn't in the local mirror is SKIPPED — there is no
     * acquisition date to anchor on, and assuming one would invent a holding
     * period. (The per-item P&L list deliberately does the opposite and keeps
     * such a sale, because dropping it there would lose realized revenue.)
     */
    fun timeOnMarket(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        nowMs: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): TimeOnMarketStats {
        val acquiredById = items.associate { it.id to (it.acquiredDate ?: it.createdAt) }

        val spans = sales.mapNotNull { sale ->
            if (!SalePnL.isCompleted(sale)) return@mapNotNull null
            val acquired = acquiredById[sale.inventoryItemId] ?: return@mapNotNull null
            // Clamped at zero by daysBetween: a sale predating the cached
            // acquisition date is clock skew, not a negative holding period.
            DashboardRollup.daysBetween(acquired, sale.saleDate, zone)
        }
        if (spans.isEmpty()) return TimeOnMarketStats.EMPTY

        val average = spans.sum().toDouble() / spans.size
        val counts = spans.groupingBy { timeOnMarketLabel(it) }.eachCount()
        return TimeOnMarketStats(
            averageDays = Math.round(average * 10) / 10.0,
            soldCount = spans.size,
            distribution = timeOnMarketBuckets.map { (label, _) ->
                TimeOnMarketBucket(label, counts[label] ?: 0)
            },
        )
    }

    // ── Cash flow ────────────────────────────────────────────────────────────

    /**
     * Cash-flow series for the trailing [months] months, oldest → newest.
     * Revenue = completed-sale revenue in the month; expenses = operating
     * expenses dated in the month; cost basis = COGS of the items those sales
     * moved.
     */
    fun cashFlow(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        expenses: List<ExpenseEntity>,
        nowMs: Long,
        months: Int = MoneyRollup.CHART_MONTHS,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): List<CashFlowMonth> {
        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }
        val thisMonth = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().withDayOfMonth(1)

        return (months - 1 downTo 0).map { offset ->
            val monthStart = thisMonth.minusMonths(offset.toLong())
            val startMs = monthStart.atStartOfDay(zone).toInstant().toEpochMilli()
            val endMs = monthStart.plusMonths(1).atStartOfDay(zone).toInstant().toEpochMilli()
            // US-2339: expenses need their OWN boundaries. A sale date is a real
            // moment and belongs in the device zone; `spentOn` is a calendar
            // date anchored at UTC midnight, so bucketing it on device-zone
            // boundaries puts a 1st-of-the-month expense in the previous month
            // for anyone west of Greenwich. One zone for both is the bug.
            val expenseStartMs = ExpenseDraft.startOfDayMs(monthStart)
            val expenseEndMs = ExpenseDraft.startOfDayMs(monthStart.plusMonths(1))

            val monthSales = sales.filter {
                it.saleDate >= startMs && it.saleDate < endMs && SalePnL.isCompleted(it)
            }
            CashFlowMonth(
                id = "${monthStart.year}-${monthStart.monthValue}",
                monthStartMs = startMs,
                label = monthStart.month.getDisplayName(TextStyle.SHORT, locale),
                revenue = Money.sum(monthSales) { SalePnL.revenue(it) },
                // Expenses are NOT status-filtered — an expense is money that
                // left regardless of how any sale turned out.
                expenses = Money.sum(
                    expenses.filter {
                        it.spentOn >= expenseStartMs && it.spentOn < expenseEndMs
                    },
                ) { it.amount },
                costBasis = Money.sum(monthSales) { costById[it.inventoryItemId] ?: 0.0 },
            )
        }
    }

    // ── Per-item P&L ─────────────────────────────────────────────────────────

    /**
     * One P&L row per completed sale, joined to its item for the title and cost
     * basis, most-recent first.
     *
     * A sale with NO matching local item still produces a row (zero cost basis,
     * "Untitled item") so realized revenue is never silently dropped — the item
     * may simply not have synced yet, and a missing row reads as lost money.
     */
    fun itemProfitRows(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
    ): List<ItemProfitRow> {
        val byId = items.associateBy { it.id }
        return sales
            .filter { SalePnL.isCompleted(it) }
            .map { sale ->
                val item = byId[sale.inventoryItemId]
                val cost = item?.acquiredPrice ?: 0.0
                ItemProfitRow(
                    saleId = sale.id,
                    itemId = sale.inventoryItemId,
                    title = item?.title?.takeIf { it.isNotBlank() } ?: "Untitled item",
                    saleDateMs = sale.saleDate,
                    revenue = Money.cents(SalePnL.revenue(sale)),
                    fees = Money.cents(SalePnL.fees(sale)),
                    costBasis = Money.cents(cost),
                    netProfit = Money.cents(SalePnL.net(sale, cost)),
                )
            }
            .sortedByDescending { it.saleDateMs }
    }

    /**
     * Re-order profit rows. ROI sorts rows with NO ROI (no cost basis) last so
     * the meaningful ones surface first; every tie breaks on most-recent sale so
     * the order is total and the list doesn't reshuffle between recompositions.
     */
    fun sortProfitRows(rows: List<ItemProfitRow>, sort: ItemProfitSort): List<ItemProfitRow> =
        when (sort) {
            ItemProfitSort.RECENT -> rows.sortedByDescending { it.saleDateMs }
            ItemProfitSort.PROFIT ->
                rows.sortedWith(
                    compareByDescending<ItemProfitRow> { it.netProfit }
                        .thenByDescending { it.saleDateMs },
                )
            ItemProfitSort.ROI -> {
                // Partitioned rather than sorted with a nulls-last comparator:
                // "descending, but nulls last" is a double negation that reads
                // as correct while doing the opposite, and a no-cost-basis row
                // sorting as 0% would take the top slots on a loss-making set.
                val (known, unknown) = rows.partition { it.roi != null }
                known.sortedWith(
                    compareByDescending<ItemProfitRow> { it.roi ?: 0.0 }
                        .thenByDescending { it.saleDateMs },
                ) + unknown.sortedByDescending { it.saleDateMs }
            }
        }
}
