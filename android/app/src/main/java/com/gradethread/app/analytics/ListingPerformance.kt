package com.gradethread.app.analytics

/**
 * US-1368 AC2 (iOS `ListingPerformance`, US-1128): the per-listing engagement
 * drill-down — views, watchers, impressions, click-through, days live.
 *
 * The numbers come from eBay's Sell Analytics traffic report, which the backend
 * writes onto `listings` every six hours. Pure sort/filter/derive here so the
 * whole thing is testable without a network.
 */
data class ListingPerformanceRow(
    val id: String,
    val inventoryItemId: String,
    val title: String?,
    val listingUrl: String?,
    val listingPrice: Double = 0.0,
    /** Epoch millis, or null when the row predates a metrics pull. */
    val listedAtMs: Long? = null,
    val viewsTotal: Int = 0,
    val watchersCount: Int = 0,
    val impressions7d: Int = 0,
    val clickThroughRate: Double? = null,
    val lastMetricsSyncedAtMs: Long? = null,
) {
    val displayTitle: String get() = title?.takeIf { it.isNotBlank() } ?: "Untitled listing"
}

enum class ListingPerformanceSort(val label: String) {
    VIEWS("Views"),
    WATCHERS("Watchers"),
    IMPRESSIONS("Impressions (7d)"),
    CTR("Click-through"),
    DAYS_LISTED("Days listed"),
    TITLE("Title"),
    ;

    /** Text reads better A→Z; metrics default highest-first. */
    val defaultAscending: Boolean get() = this == TITLE
}

object ListingPerformance {

    /** The "no views in N days" filter windows, mirroring the web page. */
    val noViewWindows = listOf(7, 14, 30)

    private const val DAY_MS = 86_400_000L

    /** Whole days since the listing went live; 0 when unknown. */
    fun daysListed(listedAtMs: Long?, nowMs: Long): Int {
        if (listedAtMs == null) return 0
        return maxOf(0, ((nowMs - listedAtMs) / DAY_MS).toInt())
    }

    /**
     * Zero views after two weeks live.
     *
     * The threshold matters: flagging a listing on day two would mark every new
     * listing as failing, and a warning everything triggers is a warning nobody
     * reads.
     */
    fun isStale(row: ListingPerformanceRow, nowMs: Long): Boolean =
        row.viewsTotal == 0 && daysListed(row.listedAtMs, nowMs) >= 14

    /**
     * Views per day live — the velocity half of the drill-down.
     *
     * Null on day zero rather than equal to the view count: a listing that got
     * 40 views in its first hours has not proven it gets 40 a day, and printing
     * that number would be the most flattering possible reading of no data.
     */
    fun viewsPerDay(row: ListingPerformanceRow, nowMs: Long): Double? {
        val days = daysListed(row.listedAtMs, nowMs)
        if (days < 1) return null
        return row.viewsTotal.toDouble() / days
    }

    /** Watchers as a share of views — how many lookers actually cared. */
    fun watchRate(row: ListingPerformanceRow): Double? {
        if (row.viewsTotal <= 0) return null
        return row.watchersCount.toDouble() / row.viewsTotal
    }

    fun sortValue(row: ListingPerformanceRow, sort: ListingPerformanceSort, nowMs: Long): Double =
        when (sort) {
            ListingPerformanceSort.VIEWS -> row.viewsTotal.toDouble()
            ListingPerformanceSort.WATCHERS -> row.watchersCount.toDouble()
            ListingPerformanceSort.IMPRESSIONS -> row.impressions7d.toDouble()
            // A listing with no CTR reading sorts below any real value, rather
            // than above every one of them as a 0.0 would.
            ListingPerformanceSort.CTR -> row.clickThroughRate ?: -1.0
            ListingPerformanceSort.DAYS_LISTED -> daysListed(row.listedAtMs, nowMs).toDouble()
            ListingPerformanceSort.TITLE -> 0.0
        }

    /**
     * Filter (zero-view, aged at least [minNoViewDays]) then sort.
     *
     * A null [minNoViewDays] means the chip is off and every row is kept.
     */
    fun resolve(
        rows: List<ListingPerformanceRow>,
        sort: ListingPerformanceSort,
        ascending: Boolean,
        minNoViewDays: Int? = null,
        nowMs: Long,
    ): List<ListingPerformanceRow> {
        val filtered = if (minNoViewDays == null) {
            rows
        } else {
            rows.filter {
                it.viewsTotal == 0 && daysListed(it.listedAtMs, nowMs) >= minNoViewDays
            }
        }

        val comparator = if (sort == ListingPerformanceSort.TITLE) {
            compareBy<ListingPerformanceRow> { it.displayTitle.lowercase() }
        } else {
            compareBy { sortValue(it, sort, nowMs) }
        }
        return filtered.sortedWith(if (ascending) comparator else comparator.reversed())
    }

    /** One line summarising the set, so an empty-ish list still says something. */
    fun summary(rows: List<ListingPerformanceRow>, nowMs: Long): String {
        if (rows.isEmpty()) return "No active eBay listings with metrics yet."
        val stale = rows.count { isStale(it, nowMs) }
        val views = rows.sumOf { it.viewsTotal }
        val base = "${rows.size} active ${if (rows.size == 1) "listing" else "listings"} · " +
            "$views total views"
        return if (stale == 0) base else "$base · $stale with no views after two weeks"
    }
}
