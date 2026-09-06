package com.gradethread.app.scout

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

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
data class ScoutScanRequest(val categoryId: String, val q: String? = null, val brand: String? = null, val limit: Int)

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

    private fun money(cents: Int?): String = cents?.let { Money.format(it / 100.0) } ?: "—"
}

enum class ScoutSort(@StringRes val label: Int) {
    MARGIN(R.string.scout_sort_margin),
    GRADE(R.string.scout_sort_grade),
    CONFIDENCE(R.string.scout_sort_confidence),
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

    /**
     * US-2976: the resource and the PLAN NAME, not the sentence.
     *
     * The plan name is a product name and stays as the server sent it (Pro,
     * Business); the sentence around it is ours and translates. A UiMessage
     * would be wrong here - there is no server sentence to prefer, only a
     * server-supplied noun to substitute.
     */
    @get:StringRes
    val message: Int
        get() = when (this) {
            is PlanLocked -> R.string.scout_plan_locked
            QuotaReached -> R.string.scout_quota_reached
        }

    /** The plan name to substitute, or null when the message takes no argument. */
    val messageArg: String?
        get() = when (this) {
            is PlanLocked -> requiredPlan?.replaceFirstChar { it.uppercaseChar() } ?: "Pro"
            QuotaReached -> null
        }

    companion object {
        /** Null for anything that isn't a plan wall — those keep their retry. */
        fun from(error: Throwable): ScoutError? {
            val gate = (error as? EdgeApiError.PlanGated)?.gate ?: return null
            return if (gate.isFeatureLock) PlanLocked(gate.requiredPlan) else QuotaReached
        }
    }
}

/**
 * The error line for a Scout or Prospect failure, in one place.
 *
 * US-2976: three sources with a precedence, and the precedence is the point.
 * A PLAN WALL wins - it is the specific answer and it is ours to translate.
 * Otherwise the SERVER's sentence, which we did not write and cannot localize
 * but which usually says what actually happened. Only if both are absent does
 * our own fallback run, and that one translates.
 */
fun errorMessage(wall: ScoutError?, error: Throwable?, @StringRes fallback: Int): UiMessage {
    if (wall != null) {
        return UiMessage(wall.message, args = listOfNotNull(wall.messageArg))
    }
    return UiMessage(fallback, (error as? EdgeApiError)?.userMessage())
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
    fun display(candidates: List<ScoutCandidate>, sort: ScoutSort, actionableOnly: Boolean): List<ScoutCandidate> {
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

    /**
     * The line under the results, so an empty scan still says something.
     *
     * US-2976: the resource and its NUMBERS.
     *
     * "Scanned 40 - showing 12" fixes an order English chose. `note` is the
     * SERVER's sentence for an empty result and is preferred when there is one,
     * so this returns a UiMessage-shaped pair rather than a string.
     */
    fun summary(response: ScoutScanResponse?, shown: Int): UiMessage = when {
        response == null -> UiMessage(R.string.scout_summary_idle)
        response.candidates.isEmpty() ->
            UiMessage(R.string.scout_summary_empty, detail = response.note)
        shown == 0 ->
            UiMessage(R.string.scout_summary_none_cleared, args = listOf(response.scanned))
        else ->
            UiMessage(R.string.scout_summary_showing, args = listOf(response.scanned, shown))
    }

    // US-3115: this was a `data class Summary(@StringRes res, args, detail)` -
    // the THIRD copy of UiMessage's shape in this app, after BulkPricing's, and
    // its own KDoc already called it "a UiMessage-shaped pair". Each copy also
    // carried the @StringRes-on-a-union bug waiting to happen, and each screen
    // that rendered one hand-rolled `detail ?: stringResource(res, ...)`,
    // which is what text() does and is where the plurals support lives.
}
