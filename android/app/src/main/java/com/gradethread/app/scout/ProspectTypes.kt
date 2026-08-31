package com.gradethread.app.scout

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import com.gradethread.app.money.Money
import kotlinx.serialization.Serializable

/**
 * US-1374 (iOS `ProspectTypes`, US-1107): the thrift-aisle "snap it, don't type
 * it" flow.
 *
 * Send one or two photos (the front, and the brand/size tag), the edge
 * identifies the item from the picture, resolves its eBay category, and runs
 * the condition-matched value and sell-through pipeline.
 *
 * camelCase on the wire, matching the property names, same as Scout.
 */
@Serializable
data class ProspectRequest(
    /** Base64 data URIs. The edge never stores them. */
    val images: List<String>,
    /** What the seller would pay, in cents. Optional; unlocks the verdict. */
    val costCents: Int? = null,
)

@Serializable
data class ProspectResponse(
    val identified: Boolean = false,
    val item: ProspectItem = ProspectItem(),
    val category: ProspectCategory? = null,
    val grade: ProspectGrade? = null,
    val stats: ProspectStats? = null,
    val sellThrough: ProspectSellThrough? = null,
    val costCents: Int? = null,
    val decision: ProspectDecision? = null,
    /** Deep link to eBay's completed-listing search for this item. */
    val ebaySoldSearchUrl: String? = null,
    /**
     * US-3026: the words that link searches for.
     *
     * Shown next to the link rather than hidden behind it. A link whose query is
     * invisible is a link nobody can tell is broken, which is how a brand-only
     * sold search survived: the seller tapped "See sold listings" and had to work
     * out for themselves that they were looking at every We The Free garment ever
     * listed instead of their cropped top.
     */
    val ebaySoldSearchQuery: String? = null,
    /**
     * The wider search: brand plus garment type, nothing else.
     *
     * Offered ALONGSIDE the specific one because precision can overshoot. eBay
     * ANDs every term, so a well-described unusual garment can return an empty
     * page, which reads as "nothing like this ever sold". Null when it would open
     * the same page as the specific link.
     */
    val ebayBroadSearchUrl: String? = null,
    val ebayBroadSearchQuery: String? = null,
    val source: String = "active",
    val disclaimer: String? = null,
    val note: String? = null,
)

@Serializable
data class ProspectItem(
    val brand: String? = null,
    val title: String? = null,
    val keywords: List<String> = emptyList(),
    val identifyConfidence: Double = 0.0,
    // US-3026: the identification in FIELDS rather than only as a title, so the
    // catalog step stops asking the seller to re-type what we just read off the tag.
    /** The head noun: "cropped top", "flannel shirt". */
    val garmentType: String? = null,
    /** The dominant colour, one word. */
    val color: String? = null,
    /** Main fabric, when the care label states it. */
    val material: String? = null,
    /** women | men | unisex | kids. */
    val gender: String? = null,
    /** Size as printed on the tag. */
    val size: String? = null,
    /** The brand's own product code off the tag. */
    val styleCode: String? = null,
)

@Serializable
data class ProspectCategory(val id: String = "", val path: String? = null)

@Serializable
data class ProspectGrade(val value: Double = 0.0, val tier: String? = null, val confidence: Double = 0.0)

@Serializable
data class ProspectStats(
    val count: Int = 0,
    val lowCents: Int? = null,
    val medianCents: Int? = null,
    val highCents: Int? = null,
    val currency: String = "USD",
    val confidence: Double = 0.0,
    /** False when there weren't enough comps to stand behind the number. */
    val sufficient: Boolean = false,
)

@Serializable
data class ProspectSellThrough(
    val sellThroughPct: Double = 0.0,
    val daysLow: Int = 0,
    val daysHigh: Int = 0,
    /** fast | moderate | slow | unknown. */
    val label: String = "unknown",
    val sampleSize: Int = 0,
)

@Serializable
data class ProspectDecision(
    /** buy | maybe | skip. */
    val recommendation: String = "maybe",
    val estProceedsCents: Int? = null,
    val estMarginCents: Int? = null,
    val roiPct: Double? = null,
    val breakevenCents: Int? = null,
    val reason: String = "",
    /** False when the numbers behind the verdict are thin. */
    val confident: Boolean = false,
)

/** `POST /api/flipdesk/scout/buy` — commits a prospect into inventory. */
@Serializable
data class ProspectBuyRequest(
    val title: String,
    val brand: String? = null,
    val size: String? = null,
    val color: String? = null,
    val costCents: Int? = null,
    val targetCents: Int? = null,
    val gradeValue: Double? = null,
    val gradeLabel: String? = null,
    val conditionNotes: String? = null,
)

@Serializable
data class ProspectBuyResponse(val id: String = "", val status: String = "")

/**
 * The wording around a prospect result.
 *
 * Pure, because the whole risk here is overstating a verdict. Someone is stood
 * in a shop about to hand over money on the strength of these sentences.
 */
object ProspectDisplay {

    /** Two photos maximum: the front, and the brand/size tag. */
    const val MAX_PHOTOS = 2

    @StringRes
    fun verdictLabel(decision: ProspectDecision?): Int = when (decision?.recommendation) {
        "buy" -> R.string.prospect_verdict_buy
        "skip" -> R.string.prospect_verdict_skip
        "maybe" -> R.string.prospect_verdict_maybe
        // No cost typed means no verdict was possible. Saying "maybe" here would
        // dress up a missing input as a judgement.
        else -> R.string.prospect_verdict_none
    }

    /**
     * The caveat under the verdict, or null.
     *
     * Two separate reasons to hedge, and they are not the same: too few comps
     * means the price itself is a guess, while low confidence means the verdict
     * built on it is.
     *
     * US-2976: a resource and, for the few-comps case, the COUNT - which goes
     * through a plurals resource because the noun changes.
     */
    fun caveat(response: ProspectResponse): UiMessage? {
        val stats = response.stats
        return when {
            stats == null -> null
            !stats.sufficient && stats.count == 0 ->
                UiMessage(R.string.prospect_caveat_no_comps)

            !stats.sufficient -> UiMessage(
                R.plurals.prospect_caveat_few_comps,
                args = listOf(stats.count),
                quantity = stats.count,
            )

            response.decision?.confident == false ->
                UiMessage(R.string.prospect_caveat_thin_verdict)

            else -> null
        }
    }

    /**
     * The comp price, as a resource and the money strings it names.
     *
     * The amounts stay formatted here - Money.format already localizes the
     * currency - but "median (usually low to high)" is a sentence and its word
     * order is not ours to fix.
     */
    fun priceRange(stats: ProspectStats?): UiMessage {
        val median = stats?.medianCents?.let { Money.format(it / 100.0) }
            ?: return UiMessage(R.string.prospect_no_price_data)
        val low = stats.lowCents?.let { Money.format(it / 100.0) }
        val high = stats.highCents?.let { Money.format(it / 100.0) }
        return if (low != null && high != null) {
            UiMessage(R.string.prospect_price_range, args = listOf(median, low, high))
        } else {
            UiMessage(R.string.prospect_price_median, args = listOf(median))
        }
    }

    /**
     * How fast it sells.
     *
     * US-2976: `sellThrough.label` is a WIRE value - "fast", "slow", "unknown" -
     * that was interpolated straight into an English sentence. It is mapped to a
     * resource now, so a Spanish seller does not read "Sells fast".
     */
    fun sellThroughLabel(sellThrough: ProspectSellThrough?): SellThrough? {
        if (sellThrough == null || sellThrough.label == "unknown") return null
        val pace = when (sellThrough.label) {
            "fast" -> R.string.prospect_sells_fast
            "slow" -> R.string.prospect_sells_slow
            else -> R.string.prospect_sells_average
        }
        return SellThrough(pace, sellThrough.daysLow, sellThrough.daysHigh)
    }

    /** The pace word, and the day range around it. */
    data class SellThrough(@StringRes val pace: Int, val daysLow: Int, val daysHigh: Int)

    /** The profit line: the money, and the return percentage when there is one. */
    fun marginLabel(decision: ProspectDecision?): Margin? {
        val margin = decision?.estMarginCents ?: return null
        return Margin(Money.format(margin / 100.0), decision.roiPct?.let { Math.round(it).toInt() })
    }

    data class Margin(val profit: String, val roiPercent: Int?)

    /**
     * What the item is called when it goes into inventory.
     *
     * Falls back through brand, then a placeholder - never an empty title,
     * which would land in the list as a blank row nobody can find again.
     *
     * US-2976: null rather than "Prospected item", because the placeholder is
     * COPY and this is called from a ViewModel with no Context. The caller
     * resolves R.string.prospect_untitled_item.
     */
    fun buyTitle(item: ProspectItem): String? = item.title?.trim()?.takeIf { it.isNotEmpty() }
        ?: item.brand?.trim()?.takeIf { it.isNotEmpty() }

    /** Whether the "Add to inventory" action should be offered at all. */
    fun canBuy(response: ProspectResponse?): Boolean = response?.identified == true
}
