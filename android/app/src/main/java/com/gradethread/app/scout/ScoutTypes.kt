package com.gradethread.app.scout

import com.gradethread.app.money.Money
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.Serializable

/**
 * US-1374 (iOS `ScoutTypes`): ScoutAI — grade what you don't own.
 *
 * A keyword/brand search returns live eBay listings, each privately
 * shadow-graded from its own photos and ranked by condition-adjusted margin, so
 * underpriced items rise to the top.
 *
 * The edge speaks camelCase here, matching the property names one for one, so
 * there are no `@SerialName` overrides in this file. That is deliberate rather
 * than an oversight — adding snake_case names would silently stop the payload
 * decoding.
 */
@Serializable
data class ScoutScanRequest(
    val categoryId: String,
    val q: String? = null,
    val brand: String? = null,
    val limit: Int,
)

@Serializable
data class ScoutScanResponse(
    val scanned: Int = 0,
    val candidates: List<ScoutCandidate> = emptyList(),
    val disclaimer: String? = null,
    /** Present when nothing matched, explaining why. */
    val note: String? = null,
)

/**
 * One ranked candidate with its private shadow grade and the arbitrage math.
 *
 * Money is integer CENTS on the wire. Kept that way through the model and
 * converted only for display — a Double dollar amount parsed from someone
 * else's listing is a rounding error waiting to be compared against a real one.
 */
@Serializable
data class ScoutCandidate(
    val itemId: String = "",
    val title: String = "",
    val imageUrl: String? = null,
    val itemWebUrl: String? = null,
    val askingCents: Int? = null,
    val shadowGrade: Double? = null,
    val gradeConfidence: Double = 0.0,
    val valueLowCents: Int? = null,
    val valueMedianCents: Int? = null,
    val valueHighCents: Int? = null,
    /** Net-of-fees estimated profit against the asking price. */
    val estMarginCents: Int? = null,
    val estMarginPct: Double? = null,
    val underpriced: Boolean = false,
    /** A real buy signal: enough comps, a confident grade, positive margin. */
    val actionable: Boolean = false,
    val reason: String = "",
) {
    val askingLabel: String get() = money(askingCents)
    val marginLabel: String get() = money(estMarginCents)
    val valueLabel: String
        get() = valueMedianCents?.let { Money.format(it / 100.0) } ?: "No comps"

    /**
     * Grade to one decimal, or a dash.
     *
     * A dash, not 0.0: a candidate the grader couldn't read is not a candidate
     * in terrible condition, and showing a zero would sink a perfectly good
     * item to the bottom of a grade sort while looking like a real reading.
     */
    val gradeLabel: String get() = shadowGrade?.let { "%.1f".format(it) } ?: "—"

    private fun money(cents: Int?): String =
        cents?.let { Money.format(it / 100.0) } ?: "—"
}

enum class ScoutSort(val label: String) {
    MARGIN("Margin"),
    GRADE("Shadow grade"),
    CONFIDENCE("Confidence"),
}

/**
 * The plan walls Scout runs into.
 *
 * Every one of these is a 402 that the shell's plan-gate host is already
 * showing a dialog for. They exist so this screen can hide its Try-again
 * button: retrying a plan wall re-hits the same wall, and a button that never
 * works reads as the app being broken rather than the plan being the limit.
 */
sealed class ScoutError {
    data class PlanLocked(val requiredPlan: String?) : ScoutError()
    object QuotaReached : ScoutError()

    val message: String
        get() = when (this) {
            is PlanLocked -> {
                val tier = requiredPlan?.replaceFirstChar { it.uppercaseChar() } ?: "Pro"
                "ScoutAI is a $tier feature. Upgrade your plan to start scouting deals."
            }
            QuotaReached ->
                "You've hit your monthly AI scan limit. It resets next cycle, or upgrade " +
                    "for a higher cap."
        }

    companion object {
        /** Null for anything that isn't a plan wall — those keep their retry. */
        fun from(error: Throwable): ScoutError? {
            val gate = (error as? EdgeApiError.PlanGated)?.gate ?: return null
            return if (gate.isFeatureLock) PlanLocked(gate.requiredPlan) else QuotaReached
        }
    }
}

object ScoutDisplay {

    /** eBay "Clothing, Shoes & Accessories" — the fallback when nothing resolves. */
    const val APPAREL_ROOT_ID = "11450"
    const val APPAREL_ROOT_NAME = "Clothing, Shoes & Accessories"

    /** Candidates graded per scan; matches the edge's own cap. */
    const val SCAN_LIMIT = 8

    /**
     * Filter then sort, descending.
     *
     * Missing values sink rather than float: a candidate with no margin reading
     * has not proven it is a bad deal, but putting it above one with a measured
     * margin would be presenting an absence as a result.
     */
    fun display(
        candidates: List<ScoutCandidate>,
        sort: ScoutSort,
        actionableOnly: Boolean,
    ): List<ScoutCandidate> {
        val list = if (actionableOnly) candidates.filter { it.actionable } else candidates
        val comparator = when (sort) {
            ScoutSort.MARGIN -> compareByDescending<ScoutCandidate> {
                it.estMarginCents ?: Int.MIN_VALUE
            }
            ScoutSort.GRADE -> compareByDescending { it.shadowGrade ?: -Double.MAX_VALUE }
            ScoutSort.CONFIDENCE -> compareByDescending { it.gradeConfidence }
        }
        return list.sortedWith(comparator.thenBy { it.itemId })
    }

    /**
     * The most descriptive term to resolve a category from.
     *
     * Keyword first, brand as the fallback: "Patagonia" alone lands on the
     * apparel root, while "Patagonia fleece" resolves to something narrow
     * enough for the scan to be worth running.
     */
    fun categoryProbe(keyword: String, brand: String): String =
        keyword.trim().takeIf { it.isNotEmpty() } ?: brand.trim()

    fun canScan(keyword: String, brand: String, busy: Boolean): Boolean =
        !busy && (keyword.isNotBlank() || brand.isNotBlank())

    /** The line under the results, so an empty scan still says something. */
    fun summary(response: ScoutScanResponse?, shown: Int): String = when {
        response == null -> "Search a brand or a keyword to scan live listings."
        response.candidates.isEmpty() ->
            response.note ?: "Nothing matched. Try a broader keyword."
        shown == 0 ->
            // The filter is why the list is empty, and that IS the answer:
            // nothing in this scan was worth buying.
            "Scanned ${response.scanned}. None of them cleared the buy bar."
        else -> "Scanned ${response.scanned} · showing $shown"
    }
}
