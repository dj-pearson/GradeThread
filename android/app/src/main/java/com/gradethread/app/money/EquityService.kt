package com.gradethread.app.money

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2491: what the unsold stock is worth.
 *
 * **This is a LIQUIDATION estimate, not a price list.** The server discounts a
 * comp median by grade, by the seller's own sell-through speed and by how long
 * the item has sat, so the number answers "what would this realistically fetch
 * if I had to move it" rather than "what am I asking". Presenting it as the
 * latter would be the most flattering possible lie about a shelf of unsold
 * inventory.
 *
 * Items the server could NOT value are counted and reasoned separately rather
 * than folded in at zero — see [EquityAggregate.unvaluedByReason]. A total that
 * quietly counted forty ungraded items as worthless would be wrong in the
 * direction a seller cannot detect.
 */
@Serializable
data class EquityBucket(val cents: Long = 0, val count: Int = 0)

@Serializable
data class UnvaluedReasons(
    @SerialName("no_grade") val noGrade: Int = 0,
    @SerialName("no_comps") val noComps: Int = 0,
)

@Serializable
data class EquityAggregate(
    @SerialName("totalEquityCents") val totalEquityCents: Long = 0,
    /** The low and high ends of the server's own range, not a guess here. */
    @SerialName("totalLowCents") val totalLowCents: Long = 0,
    @SerialName("totalHighCents") val totalHighCents: Long = 0,
    @SerialName("valuedCount") val valuedCount: Int = 0,
    @SerialName("unvaluedCount") val unvaluedCount: Int = 0,
    @SerialName("unvaluedByReason") val unvaluedByReason: UnvaluedReasons = UnvaluedReasons(),
    @SerialName("byCategory") val byCategory: Map<String, EquityBucket> = emptyMap(),
    @SerialName("byBrand") val byBrand: Map<String, EquityBucket> = emptyMap(),
    @SerialName("byGradeBand") val byGradeBand: Map<String, EquityBucket> = emptyMap(),
)

@Serializable
data class EquitySummary(
    val currency: String = "USD",
    /**
     * The seller's own median days-to-sell, or null when there is not enough
     * history. It is an input to every item's discount, so it is shown: a
     * number that moves when your selling speed moves should say so.
     */
    @SerialName("personalSellThroughDays") val personalSellThroughDays: Double? = null,
    val aggregate: EquityAggregate = EquityAggregate(),
)

@Serializable
data class EquityPoint(
    @SerialName("snapshot_date") val snapshotDate: String = "",
    @SerialName("total_equity_cents") val totalEquityCents: Long = 0,
    @SerialName("total_low_cents") val totalLowCents: Long = 0,
    @SerialName("total_high_cents") val totalHighCents: Long = 0,
    @SerialName("valued_count") val valuedCount: Int = 0,
    @SerialName("unvalued_count") val unvaluedCount: Int = 0,
)

@Serializable
data class EquityTrend(
    val currency: String = "USD",
    /** Oldest first — the server reverses for charting. */
    val points: List<EquityPoint> = emptyList(),
)

@Singleton
class EquityService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    suspend fun summary(): EquitySummary =
        json.decodeFromString(EquitySummary.serializer(), edge.getRaw(EQUITY_PATH))

    /** Daily snapshots written by the nightly job. Empty until it has run. */
    suspend fun trend(): EquityTrend =
        json.decodeFromString(EquityTrend.serializer(), edge.getRaw(TREND_PATH))

    companion object {
        const val EQUITY_PATH = "/api/flipdesk/equity"
        const val TREND_PATH = "/api/flipdesk/equity/trend"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * A 404 here means the FEATURE is off server-side, not that data is
         * missing. Reported as "not turned on" rather than "we couldn't find
         * that", which would send a seller looking for inventory they have.
         */
        const val NOT_ENABLED = "Inventory value isn't switched on for your account yet."

        fun message(error: Throwable): String = when (error) {
            is EdgeApiError.NotFound -> NOT_ENABLED
            is EdgeApiError -> error.userMessage()
            else -> error.message ?: "We couldn't work out your inventory value just now."
        }
    }
}

/** Presentation rules for the equity card. Pure, so they are testable. */
object Equity {

    /** Cents to whole dollars, for [Money.format]. */
    fun dollars(cents: Long): Double = cents / 100.0

    /**
     * Whether the range is worth showing beside the headline.
     *
     * A low and high that collapse onto the total say nothing and add noise —
     * which is what happens when every valued item had a single comp.
     */
    fun hasRange(aggregate: EquityAggregate): Boolean =
        aggregate.valuedCount > 0 &&
            (aggregate.totalLowCents < aggregate.totalEquityCents ||
                aggregate.totalHighCents > aggregate.totalEquityCents)

    /**
     * The biggest buckets first, capped.
     *
     * Sorted by value rather than count: a shelf of ten cheap tees is not the
     * thing a seller needs to see above one designer coat.
     */
    fun topBuckets(buckets: Map<String, EquityBucket>, limit: Int = 4): List<Pair<String, EquityBucket>> =
        buckets.entries
            .sortedWith(compareByDescending<Map.Entry<String, EquityBucket>> { it.value.cents }.thenBy { it.key })
            .take(limit)
            .map { it.key to it.value }

    /** The last two snapshots' movement in cents, or null when there is no run. */
    fun movementCents(trend: EquityTrend): Long? {
        if (trend.points.size < 2) return null
        val points = trend.points
        return points.last().totalEquityCents - points[points.size - 2].totalEquityCents
    }
}
