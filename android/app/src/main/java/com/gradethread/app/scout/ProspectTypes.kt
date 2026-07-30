package com.gradethread.app.scout

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
)

@Serializable
data class ProspectCategory(val id: String = "", val path: String? = null)

@Serializable
data class ProspectGrade(
    val value: Double = 0.0,
    val tier: String? = null,
    val confidence: Double = 0.0,
)

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

    fun verdictLabel(decision: ProspectDecision?): String = when (decision?.recommendation) {
        "buy" -> "Buy it"
        "skip" -> "Walk away"
        "maybe" -> "Could go either way"
        // No cost typed means no verdict was possible. Saying "maybe" here would
        // dress up a missing input as a judgement.
        else -> "Enter what it costs for a verdict"
    }

    /**
     * The caveat under the verdict, or null.
     *
     * Two separate reasons to hedge, and they are not the same: too few comps
     * means the price itself is a guess, while low confidence means the verdict
     * built on it is.
     */
    fun caveat(response: ProspectResponse): String? {
        val stats = response.stats
        return when {
            stats == null -> null
            !stats.sufficient && stats.count == 0 ->
                "No comparable sales found, so there's no price to work from."
            !stats.sufficient ->
                "Only ${stats.count} comparable ${if (stats.count == 1) "sale" else "sales"}. " +
                    "Treat this as a rough guide."
            response.decision?.confident == false ->
                "The numbers behind this verdict are thin."
            else -> null
        }
    }

    fun priceRange(stats: ProspectStats?): String {
        if (stats == null || stats.medianCents == null) return "No price data"
        val median = Money.format(stats.medianCents / 100.0)
        val low = stats.lowCents?.let { Money.format(it / 100.0) }
        val high = stats.highCents?.let { Money.format(it / 100.0) }
        return if (low != null && high != null) "$median (usually $low to $high)" else median
    }

    fun sellThroughLabel(sellThrough: ProspectSellThrough?): String? {
        if (sellThrough == null || sellThrough.label == "unknown") return null
        return "Sells ${sellThrough.label} · around ${sellThrough.daysLow} to " +
            "${sellThrough.daysHigh} days"
    }

    fun marginLabel(decision: ProspectDecision?): String? {
        val margin = decision?.estMarginCents ?: return null
        val roi = decision.roiPct?.let { " · ${Math.round(it)}% return" } ?: ""
        return "About ${Money.format(margin / 100.0)} profit$roi"
    }

    /**
     * What the item is called when it goes into inventory.
     *
     * Falls back through brand, then a plain placeholder — never an empty
     * title, which would land in the list as a blank row nobody can find again.
     */
    fun buyTitle(item: ProspectItem): String =
        item.title?.trim()?.takeIf { it.isNotEmpty() }
            ?: item.brand?.trim()?.takeIf { it.isNotEmpty() }
            ?: "Prospected item"

    /** Whether the "Add to inventory" action should be offered at all. */
    fun canBuy(response: ProspectResponse?): Boolean = response?.identified == true
}
