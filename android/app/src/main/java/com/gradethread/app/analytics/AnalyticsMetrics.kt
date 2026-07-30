package com.gradethread.app.analytics

import com.gradethread.app.money.DashboardRollup
import com.gradethread.app.money.Money
import com.gradethread.app.money.SalePnL
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity

/**
 * US-1368 (iOS `AnalyticsRollup`): the analytics tab's math, over the Room
 * mirror.
 *
 * Pure functions taking item/sale lists, exactly like [DashboardRollup] and the
 * money rollups — which is what AC3 means by "computed locally": nothing here
 * asks a server what a number is, so the whole tab works offline and every
 * figure is unit-testable without a database.
 *
 * Scope is bounded by what the mirror actually carries: grade tier, brand,
 * status, acquired price, and sales. Anything needing a column Room doesn't have
 * stays web-only rather than being approximated here.
 */

/** One grade-tier slice of the graded inventory. */
data class GradeBucket(val tier: String, val count: Int)

/** Net profit attributed to a brand over the selected window. */
data class BrandProfit(val brand: String, val netProfit: Double, val unitsSold: Int)

/** Sell-through for a brand: how many of the items that reached market sold. */
data class SellThroughRow(val brand: String, val listed: Int, val sold: Int) {
    val rate: Double get() = if (listed > 0) sold.toDouble() / listed else 0.0
}

/** On-hand inventory value grouped by pipeline status. */
data class StatusValue(val status: String, val value: Double, val count: Int)

/** Realized P&L over a period: revenue, fees, COGS, gross profit. */
data class PeriodPnL(
    val grossRevenue: Double,
    val fees: Double,
    val cogs: Double,
    val unitsSold: Int,
) {
    val grossProfit: Double get() = grossRevenue - fees - cogs

    companion object {
        val EMPTY = PeriodPnL(0.0, 0.0, 0.0, 0)
    }
}

/**
 * Graded-vs-ungraded net profit within a sale-price band.
 *
 * The question this answers is the only one that justifies paying for grading:
 * does a graded item actually net more than an ungraded one at the same price?
 */
data class RoiBucket(
    val band: String,
    val gradedCount: Int,
    val ungradedCount: Int,
    val gradedAvgNet: Double?,
    val ungradedAvgNet: Double?,
) {
    val netProfitLift: Double?
        get() = if (gradedAvgNet != null && ungradedAvgNet != null) {
            gradedAvgNet - ungradedAvgNet
        } else {
            null
        }

    /**
     * Both sides have enough samples to be worth reading.
     *
     * Three each is a low bar, but the alternative is showing a "grading adds
     * $40" claim built on one sale, which is how a seller talks themselves into
     * a spending decision on noise.
     */
    val meaningful: Boolean get() = gradedCount >= 3 && ungradedCount >= 3
}

/**
 * The trailing window sales-based analytics are scoped to.
 *
 * [Days] covers the 30/90/180 presets AND a custom count, so "custom" is the
 * same code path as a preset rather than a second, less-tested one.
 */
sealed class AnalyticsRange {
    data class Days(val count: Int) : AnalyticsRange()
    object All : AnalyticsRange()

    val label: String
        get() = when (this) {
            is Days -> when (count) {
                30 -> "30 days"
                90 -> "90 days"
                180 -> "180 days"
                365 -> "12 months"
                else -> "$count days"
            }
            All -> "All time"
        }

    /** Inclusive start of the window in epoch millis, or null for all-time. */
    fun startMs(nowMs: Long): Long? = when (this) {
        is Days -> nowMs - count.coerceAtLeast(1) * DAY_MS
        All -> null
    }

    companion object {
        const val DAY_MS = 86_400_000L

        val presets: List<AnalyticsRange> =
            listOf(Days(30), Days(90), Days(180), All)

        /** Clamped so a typo'd custom range can't ask for a nonsense window. */
        fun custom(days: Int): AnalyticsRange = Days(days.coerceIn(1, 3650))
    }
}

object AnalyticsRollup {

    /** Statuses representing a realized sale. */
    val soldStatuses = setOf("sold", "shipped", "completed")

    /** Statuses representing an item that reached the market. */
    val marketStatuses = setOf("listed", "sold", "shipped", "completed")

    private fun brandKey(item: InventoryItemEntity): String =
        item.brand?.takeIf { it.isNotBlank() } ?: "Unknown"

    /**
     * Sales in the window that count — completed only.
     *
     * Cancelled and refunded orders are excluded everywhere in this file for
     * the same reason migration 00111 excludes them from money: a refunded sale
     * is not revenue, and counting it makes every downstream number optimistic.
     */
    private fun scopedSales(sales: List<SaleEntity>, sinceMs: Long?): List<SaleEntity> =
        sales.filter { SalePnL.isCompleted(it) && (sinceMs == null || it.saleDate >= sinceMs) }

    // ── Grading ──────────────────────────────────────────────────────────────

    fun gradedCount(items: List<InventoryItemEntity>): Int =
        items.count { it.gradeValue != null }

    /** Mean grade across graded items, to one decimal. Null when none. */
    fun averageGrade(items: List<InventoryItemEntity>): Double? {
        val values = items.mapNotNull { it.gradeValue }
        if (values.isEmpty()) return null
        return Math.round(values.sum() / values.size * 10) / 10.0
    }

    /**
     * Graded items by tier, best grade first.
     *
     * "Is graded" is `gradeValue != null` — the SAME predicate as
     * [gradedCount], so the chart's total reconciles with the header count. An
     * item with a score but no tier label lands in "Other" rather than dropping
     * out of the distribution and quietly making the two disagree.
     */
    fun gradeDistribution(items: List<InventoryItemEntity>): List<GradeBucket> {
        val graded = items.filter { it.gradeValue != null }
        val counts = mutableMapOf<String, Int>()
        val scoreSum = mutableMapOf<String, Double>()
        for (item in graded) {
            val tier = item.gradeLabel?.takeIf { it.isNotBlank() } ?: "Other"
            counts[tier] = (counts[tier] ?: 0) + 1
            scoreSum[tier] = (scoreSum[tier] ?: 0.0) + (item.gradeValue ?: 0.0)
        }
        return counts.map { (tier, count) -> GradeBucket(tier, count) }
            .sortedWith(
                compareByDescending<GradeBucket> {
                    (scoreSum[it.tier] ?: 0.0) / maxOf(it.count, 1)
                }.thenBy { it.tier },
            )
    }

    // ── Profit by brand ──────────────────────────────────────────────────────

    fun topBrandsByProfit(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        sinceMs: Long?,
        limit: Int = 5,
    ): List<BrandProfit> {
        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }
        val brandById = items.associate { it.id to brandKey(it) }

        val profit = mutableMapOf<String, MutableList<Double>>()
        val units = mutableMapOf<String, Int>()
        for (sale in scopedSales(sales, sinceMs)) {
            val brand = brandById[sale.inventoryItemId] ?: "Unknown"
            val net = SalePnL.net(sale, costById[sale.inventoryItemId] ?: 0.0)
            profit.getOrPut(brand) { mutableListOf() }.add(net)
            units[brand] = (units[brand] ?: 0) + 1
        }

        return profit
            // Summed through Money, not `sumOf`: these are the figures a seller
            // reconciles against a payout, and float drift passes a cent on the
            // set sizes a real inventory reaches.
            .map { (brand, nets) -> BrandProfit(brand, Money.sum(nets), units[brand] ?: 0) }
            .sortedWith(compareByDescending<BrandProfit> { it.netProfit }.thenBy { it.brand })
            .take(limit)
    }

    // ── Sell-through ─────────────────────────────────────────────────────────

    /**
     * Sell-through by brand, over items that REACHED the market.
     *
     * Items still being catalogued are excluded deliberately: counting them
     * would make a seller who just sourced fifty pieces look like their brands
     * stopped selling.
     */
    fun sellThroughByBrand(
        items: List<InventoryItemEntity>,
        limit: Int = 8,
    ): List<SellThroughRow> {
        val listed = mutableMapOf<String, Int>()
        val sold = mutableMapOf<String, Int>()
        for (item in items.filter { it.status in marketStatuses }) {
            val brand = brandKey(item)
            listed[brand] = (listed[brand] ?: 0) + 1
            if (item.status in soldStatuses) sold[brand] = (sold[brand] ?: 0) + 1
        }
        return listed
            .map { (brand, count) -> SellThroughRow(brand, count, sold[brand] ?: 0) }
            .sortedWith(compareByDescending<SellThroughRow> { it.listed }.thenBy { it.brand })
            .take(limit)
    }

    // ── Period P&L ───────────────────────────────────────────────────────────

    fun periodPnL(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        sinceMs: Long?,
    ): PeriodPnL {
        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }
        val scoped = scopedSales(sales, sinceMs)
        // COGS is item cost basis PLUS per-sale selling costs, so that
        // grossProfit = revenue - fees - cogs equals the sum of SalePnL.net.
        // Splitting them differently is how a P&L stops footing.
        return PeriodPnL(
            grossRevenue = Money.sum(scoped.map { SalePnL.revenue(it) }),
            fees = Money.sum(scoped.map { SalePnL.fees(it) }),
            cogs = Money.sum(
                scoped.map { (costById[it.inventoryItemId] ?: 0.0) + SalePnL.sellerCosts(it) },
            ),
            unitsSold = scoped.size,
        )
    }

    // ── Grading ROI ──────────────────────────────────────────────────────────

    /**
     * Sale-price bands.
     *
     * Labels use the compact chart formatter, which is deliberately US-shaped —
     * these are axis labels, not amounts anyone reconciles against.
     */
    val priceBands: List<Pair<String, ClosedFloatingPointRange<Double>>>
        get() = listOf(
            "Under ${Money.formatCompact(50.0)}" to 0.0..49.999999,
            "${Money.formatCompact(50.0)}–${Money.formatCompact(150.0)}" to 50.0..149.999999,
            "${Money.formatCompact(150.0)}+" to 150.0..Double.MAX_VALUE,
        )

    fun gradingRoiBuckets(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        sinceMs: Long?,
    ): List<RoiBucket> {
        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }
        val gradedById = items.associate { it.id to (it.gradeValue != null) }
        val bands = priceBands

        val graded = mutableMapOf<String, MutableList<Double>>()
        val ungraded = mutableMapOf<String, MutableList<Double>>()
        for (sale in scopedSales(sales, sinceMs)) {
            val band = bands.firstOrNull { sale.salePrice in it.second }?.first
                ?: bands.last().first
            val net = SalePnL.net(sale, costById[sale.inventoryItemId] ?: 0.0)
            val side = if (gradedById[sale.inventoryItemId] == true) graded else ungraded
            side.getOrPut(band) { mutableListOf() }.add(net)
        }

        fun avg(nets: List<Double>): Double? =
            if (nets.isEmpty()) null else Money.sum(nets) / nets.size

        return bands.mapNotNull { (band, _) ->
            val g = graded[band].orEmpty()
            val u = ungraded[band].orEmpty()
            // An empty band is omitted rather than drawn as a zero — a bar at
            // zero says "graded items made nothing", which is a different claim
            // from "nothing sold in this band".
            if (g.isEmpty() && u.isEmpty()) return@mapNotNull null
            RoiBucket(band, g.size, u.size, avg(g), avg(u))
        }
    }

    // ── Inventory value ──────────────────────────────────────────────────────

    /**
     * On-hand value by status.
     *
     * Reuses [DashboardRollup.isOnHand] and the same market-value fallback
     * chain the Home tab uses, so the two screens can't disagree about what the
     * inventory is worth.
     */
    fun inventoryValueByStatus(items: List<InventoryItemEntity>): List<StatusValue> {
        val value = mutableMapOf<String, MutableList<Double>>()
        val count = mutableMapOf<String, Int>()
        for (item in items.filter { DashboardRollup.isOnHand(it.status) }) {
            val amount = item.listingPrice ?: item.targetPrice ?: item.acquiredPrice ?: 0.0
            value.getOrPut(item.status) { mutableListOf() }.add(amount)
            count[item.status] = (count[item.status] ?: 0) + 1
        }
        return value
            .map { (status, amounts) ->
                StatusValue(status, Money.sum(amounts), count[status] ?: 0)
            }
            .sortedWith(compareByDescending<StatusValue> { it.value }.thenBy { it.status })
    }

    // ── Narrative inputs ─────────────────────────────────────────────────────

    /** Overall sell-through across every brand that reached market, or null. */
    fun overallSellThroughRate(items: List<InventoryItemEntity>): Double? {
        val market = items.count { it.status in marketStatuses }
        if (market == 0) return null
        return items.count { it.status in soldStatuses }.toDouble() / market
    }

    /** The single most meaningful grading lift, for the AI summary. */
    fun headlineRoiLift(buckets: List<RoiBucket>): Double? =
        buckets.filter { it.meaningful }.mapNotNull { it.netProfitLift }.maxOrNull()
}
