package com.gradethread.app.money

import com.gradethread.app.inventory.InventoryStage
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity
import java.time.Instant
import java.time.ZoneId

/**
 * US-1370 (iOS `DashboardRollup`/`DashboardMetrics`): the glanceable home
 * rollup over the Room mirror.
 *
 * Pure scalars only, so the arithmetic is unit-testable without a database —
 * the same split the sync engine uses. `HomeViewModel` feeds it the observed
 * lists and `HomeScreen` renders the result.
 *
 * All day arithmetic goes through [java.time] against an explicit [ZoneId]
 * (`minSdk 26`, so no desugaring): a seller's "this month" is their local month,
 * and bucketing in UTC would move sales across month boundaries for anyone west
 * of Greenwich.
 */
data class DashboardMetrics(
    /**
     * MARKET value of goods physically on hand: Σ listing price (→ target price
     * → cost basis) for on-hand items. Matches what eBay reports and the web
     * overview's "inventory value" — NOT cost basis alone, which is null for
     * imported items and unrelated to the figure sellers compare against.
     */
    val inventoryValue: Double,
    /** Unsold items on hand — the [inventoryValue] denominator. */
    val onHandCount: Int,
    val listedCount: Int,
    val soldThisWeekCount: Int,
    val revenueThisWeek: Double,
    /** revenue − fees − seller costs − cost basis, via [SalePnL.net]. */
    val netProfitThisWeek: Double,
    /** On-hand items untouched for [DashboardRollup.AGING_THRESHOLD_DAYS]+. */
    val agingCount: Int,
) {
    companion object {
        val EMPTY = DashboardMetrics(0.0, 0, 0, 0, 0.0, 0.0, 0)
    }
}

object DashboardRollup {

    /**
     * Statuses for unsold inventory still on hand — capital is tied up until the
     * item sells. Everything else is either realized (`sold`, `shipped`,
     * `completed`, `returned`) or deliberately set aside (`archived`, `keeping`,
     * `wearing`), so it isn't on-hand value.
     *
     * Derived by SUBTRACTION from [InventoryStage.allKnownStatuses] rather than
     * listed literally: adding a pipeline status in one place then keeps this
     * honest instead of silently excluding the new stage from inventory value.
     */
    val onHandStatuses: Set<String> = InventoryStage.allKnownStatuses - setOf(
        "sold", "shipped", "completed", "returned",
        "archived", "keeping", "wearing",
    )

    /** Days an on-hand item can sit untouched before it's "aging" (web parity). */
    const val AGING_THRESHOLD_DAYS = 14

    /**
     * Trailing window for the "this week" figures — 7×24h rather than a calendar
     * week, so "Past 7 days" means the same thing regardless of locale and
     * week-start convention.
     */
    const val WEEK_WINDOW_DAYS = 7

    fun isOnHand(status: String): Boolean = status in onHandStatuses

    /**
     * On-hand and untouched for [AGING_THRESHOLD_DAYS]+. A future `updatedAt`
     * (clock skew) reads as not-aging rather than wildly aging.
     */
    fun isAging(item: InventoryItemEntity, nowMs: Long): Boolean {
        if (!isOnHand(item.status)) return false
        return item.updatedAt < nowMs - AGING_THRESHOLD_DAYS * DAY_MS
    }

    fun compute(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        nowMs: Long,
    ): DashboardMetrics {
        val onHand = items.filter { isOnHand(it.status) }
        val inventoryValue = Money.sum(onHand) {
            it.listingPrice ?: it.targetPrice ?: it.acquiredPrice ?: 0.0
        }
        val costById = items.associate { it.id to (it.acquiredPrice ?: 0.0) }

        val windowStart = nowMs - WEEK_WINDOW_DAYS * DAY_MS
        // Only COMPLETED sales count — a cancelled/refunded order was never a
        // real sale (00111).
        val weekSales = sales.filter { it.saleDate >= windowStart && SalePnL.isCompleted(it) }

        return DashboardMetrics(
            inventoryValue = inventoryValue,
            onHandCount = onHand.size,
            listedCount = items.count { it.status == "listed" },
            soldThisWeekCount = weekSales.size,
            revenueThisWeek = Money.sum(weekSales) { SalePnL.revenue(it) },
            netProfitThisWeek = Money.sum(weekSales) {
                SalePnL.net(it, costById[it.inventoryItemId] ?: 0.0)
            },
            agingCount = items.count { isAging(it, nowMs) },
        )
    }

    /**
     * The aging items themselves, oldest-touched first.
     *
     * Shares [isAging] with [compute] deliberately: when the count and the list
     * were derived separately on iOS they drifted, and a card reading "3 items
     * aging" above a list of two is the kind of thing sellers screenshot.
     */
    fun agingItems(
        items: List<InventoryItemEntity>,
        nowMs: Long,
        limit: Int = 5,
    ): List<InventoryItemEntity> =
        items.filter { isAging(it, nowMs) }.sortedBy { it.updatedAt }.take(limit)

    const val DAY_MS = 24L * 60 * 60 * 1000

    /** Start-of-day in the given zone, as epoch millis. */
    fun startOfDay(epochMs: Long, zone: ZoneId): Long =
        Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate()
            .atStartOfDay(zone).toInstant().toEpochMilli()

    /** Start-of-month in the given zone, as epoch millis. */
    fun startOfMonth(epochMs: Long, zone: ZoneId): Long =
        Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate().withDayOfMonth(1)
            .atStartOfDay(zone).toInstant().toEpochMilli()

    /**
     * Whole days between two instants in [zone], clamped at zero.
     *
     * Counted in LOCAL DATES, not by dividing millis: across a DST boundary a
     * day is 23 or 25 hours, and millis-division reports 13 days for a fortnight
     * every spring.
     */
    fun daysBetween(fromMs: Long, toMs: Long, zone: ZoneId): Int {
        val from = Instant.ofEpochMilli(fromMs).atZone(zone).toLocalDate()
        val to = Instant.ofEpochMilli(toMs).atZone(zone).toLocalDate()
        return java.time.temporal.ChronoUnit.DAYS.between(from, to).toInt().coerceAtLeast(0)
    }
}
