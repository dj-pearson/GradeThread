package com.gradethread.app.analytics

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import com.gradethread.app.money.Money
import kotlinx.serialization.Serializable

/**
 * US-1369 (iOS `CommunityBenchmarks`, US-1064): the `community_benchmarks` RPC
 * payload (migration 00173) plus the pure layer that turns anonymized cohort
 * aggregates into "source more of X" / "price X near Y".
 *
 * The RPC is SECURITY DEFINER and enforces k-anonymity server-side: no cohort is
 * returned below five distinct sellers, and the only per-seller numbers in the
 * payload are the caller's own. Nothing here can widen that, and nothing here
 * should try — the client's job is to present it, not to re-derive it.
 *
 * Thresholds, the confidence model and the copy are deliberately kept in step
 * with the web `src/lib/community-recommendations.ts` and the iOS twin, so a
 * seller who checks both surfaces sees the same advice rather than two.
 */
@Serializable
data class BrandBenchmark(
    val brand: String = "",
    val sellers: Int = 0,
    val listed: Int = 0,
    val sold: Int = 0,
    val sellThrough: Double? = null,
    val avgSalePrice: Double? = null,
)

@Serializable
data class CategoryTrend(
    val category: String = "",
    val sellers: Int = 0,
    val soldRecent: Int = 0,
    val soldPrevious: Int = 0,
    val growth: Double? = null,
)

/** The caller's own numbers, and how they sit against the cohort. */
@Serializable
data class PeerComparison(
    val peerCount: Int = 0,
    val peerMedianSellThrough: Double? = null,
    val yourSellThrough: Double? = null,
    /** 0–1 share of peers at or below the caller's rate. */
    val percentile: Double? = null,
)

@Serializable
data class SellerSummary(
    val listed: Int = 0,
    val sold: Int = 0,
    val sellThrough: Double? = null,
    val peerComparison: PeerComparison? = null,
)

@Serializable
data class CommunityBenchmarks(
    val topBrands: List<BrandBenchmark> = emptyList(),
    val trendingCategories: List<CategoryTrend> = emptyList(),
    val you: SellerSummary = SellerSummary(),
) {
    /**
     * Whether the RPC returned any cohort at all.
     *
     * Distinct from "no recommendations": rows can exist while none clear the
     * action thresholds, and the empty state has to say "nothing worth acting on
     * right now" rather than "not enough community data" — they are different
     * situations and only one of them is about waiting.
     */
    val hasBenchmarkData: Boolean
        get() = topBrands.isNotEmpty() || trendingCategories.isNotEmpty()
}

enum class RecommendationKind { SOURCE, PRICE }

enum class ConfidenceLevel(@StringRes val label: Int) {
    HIGH(R.string.community_confidence_high),
    MEDIUM(R.string.community_confidence_medium),
    LOW(R.string.community_confidence_low),
}

data class CommunityRecommendation(
    val id: String,
    val kind: RecommendationKind,
    /** The brand or category this is about. */
    val subject: String,
    val title: UiMessage,
    val detail: UiMessage,
    /** 0–1, from cohort size and signal strength. */
    val confidence: Double,
    val confidenceLevel: ConfidenceLevel,
    val cohortSize: Int,
    /**
     * Brand to filter inventory by when tapped.
     *
     * Null for category recommendations: the local item mirror carries no
     * category column, so a category filter would silently match nothing.
     */
    val brandFilter: String?,
    /** Ranking score; higher first. */
    val score: Double,
)

object CommunityRecommendations {

    /** Minimum community sell-through before suggesting more of a brand. */
    const val SOURCE_SELL_THROUGH_FLOOR = 0.5

    /** Minimum 30-day-over-30-day growth before a category is "rising". */
    const val TRENDING_GROWTH_FLOOR = 0.15

    /** The RPC's k-anonymity floor. Nothing below this reaches the client. */
    const val MIN_SELLERS = 5

    private fun clamp(n: Double, lo: Double, hi: Double) = minOf(hi, maxOf(lo, n))

    /**
     * Confidence from sample size alone.
     *
     * Five sellers — the k-anonymity floor — is 0.40, climbing to a 0.95 cap at
     * about 23. Capped below 1 on purpose: a cohort is never certainty, and a
     * "100% confidence" badge on someone else's aggregate would be a promise
     * this data cannot make.
     */
    fun cohortConfidence(sellers: Int): Double = clamp(0.4 + (sellers - MIN_SELLERS) * 0.03, 0.4, 0.95)

    fun confidenceLevel(confidence: Double): ConfidenceLevel = when {
        confidence >= 0.75 -> ConfidenceLevel.HIGH
        confidence >= 0.55 -> ConfidenceLevel.MEDIUM
        else -> ConfidenceLevel.LOW
    }

    private fun pct(n: Double): String = "${Math.round(n * 100)}%"

    private fun brandSourceRec(b: BrandBenchmark): CommunityRecommendation? {
        val st = b.sellThrough ?: return null
        if (st < SOURCE_SELL_THROUGH_FLOOR) return null
        val confidence = clamp(cohortConfidence(b.sellers) * (0.6 + 0.4 * minOf(st, 1.0)), 0.0, 1.0)
        val avg = b.avgSalePrice
        return CommunityRecommendation(
            id = "source-brand:${b.brand}",
            kind = RecommendationKind.SOURCE,
            subject = b.brand,
            title = UiMessage(R.string.community_source_brand_title, args = listOf(b.brand)),
            // US-2976: a WHOLE sentence per shape, not one with " · avg sale X"
            // glued on. The optional clause is part of the sentence a
            // translator sees, so they can move it, and the seller count picks
            // the plural form for the whole line rather than for a fragment.
            detail = if (avg == null) {
                UiMessage(
                    R.plurals.community_source_detail,
                    args = listOf(b.sellers, pct(st)),
                    quantity = b.sellers,
                )
            } else {
                UiMessage(
                    R.plurals.community_source_detail_avg,
                    args = listOf(b.sellers, pct(st), Money.format(avg)),
                    quantity = b.sellers,
                )
            },
            confidence = confidence,
            confidenceLevel = confidenceLevel(confidence),
            cohortSize = b.sellers,
            brandFilter = b.brand,
            score = st * confidence,
        )
    }

    private fun brandPriceRec(b: BrandBenchmark): CommunityRecommendation? {
        val avg = b.avgSalePrice ?: return null
        if (avg <= 0) return null
        val confidence = cohortConfidence(b.sellers)
        val st = b.sellThrough
        return CommunityRecommendation(
            id = "price-brand:${b.brand}",
            kind = RecommendationKind.PRICE,
            subject = b.brand,
            title = UiMessage(
                R.string.community_price_brand_title,
                args = listOf(b.brand, Money.format(avg)),
            ),
            detail = if (st == null) {
                UiMessage(
                    R.plurals.community_price_detail,
                    args = listOf(b.sellers),
                    quantity = b.sellers,
                )
            } else {
                UiMessage(
                    R.plurals.community_price_detail_st,
                    args = listOf(b.sellers, pct(st)),
                    quantity = b.sellers,
                )
            },
            confidence = confidence,
            confidenceLevel = confidenceLevel(confidence),
            cohortSize = b.sellers,
            brandFilter = b.brand,
            score = confidence,
        )
    }

    private fun categorySourceRec(c: CategoryTrend): CommunityRecommendation? {
        val growth = c.growth ?: return null
        if (growth < TRENDING_GROWTH_FLOOR) return null
        val confidence =
            clamp(cohortConfidence(c.sellers) * (0.7 + 0.3 * minOf(growth, 1.0)), 0.0, 1.0)
        return CommunityRecommendation(
            id = "source-category:${c.category}",
            kind = RecommendationKind.SOURCE,
            subject = c.category,
            title = UiMessage(R.string.community_category_title, args = listOf(c.category)),
            detail = UiMessage(
                R.plurals.community_category_detail,
                args = listOf(c.sellers, pct(growth)),
                quantity = c.sellers,
            ),
            confidence = confidence,
            confidenceLevel = confidenceLevel(confidence),
            cohortSize = c.sellers,
            brandFilter = null,
            score = growth * confidence,
        )
    }

    /** Ranked sourcing and pricing suggestions, best first. */
    fun derive(data: CommunityBenchmarks): List<CommunityRecommendation> {
        val recs = mutableListOf<CommunityRecommendation>()
        for (brand in data.topBrands) {
            brandSourceRec(brand)?.let(recs::add)
            brandPriceRec(brand)?.let(recs::add)
        }
        for (category in data.trendingCategories) {
            categorySourceRec(category)?.let(recs::add)
        }
        return recs.sortedWith(compareByDescending<CommunityRecommendation> { it.score }.thenBy { it.id })
    }

    /**
     * How the caller's sell-through reads against the cohort.
     *
     * Null whenever the comparison would be made up: the RPC withholds
     * `peerComparison` below five peers, and a percentile with no rate behind it
     * is not a position.
     */
    fun peerStanding(you: SellerSummary): String? {
        val peers = you.peerComparison ?: return null
        val yours = peers.yourSellThrough ?: return null
        val median = peers.peerMedianSellThrough ?: return null
        val where = when {
            yours > median -> "above"
            yours < median -> "below"
            else -> "right at"
        }
        val percentile = peers.percentile
            ?.let { ", ahead of ${pct(it)} of them" }
            ?: ""
        return "Your sell-through is ${pct(yours)}, $where the ${pct(median)} median " +
            "across ${peers.peerCount} sellers$percentile."
    }

    /**
     * Why the caller has no comparison yet, when they don't.
     *
     * The RPC needs three listed items before it will compute a rate at all,
     * which is a fixable state and worth naming rather than showing a blank.
     */
    @StringRes
    fun peerStandingBlocker(you: SellerSummary): Int? {
        if (you.peerComparison?.yourSellThrough != null) return null
        return if (you.listed < 3) {
            R.string.community_need_three
        } else {
            R.string.community_no_peers
        }
    }
}
