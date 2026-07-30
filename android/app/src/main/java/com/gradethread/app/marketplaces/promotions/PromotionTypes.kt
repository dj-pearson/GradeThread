package com.gradethread.app.marketplaces.promotions

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1357: the per-listing promotion + markdown state, as the edge reports it.
 *
 * Two different eBay features share this panel. A PROMOTION is an ad rate — you
 * pay a percentage only when the ad makes the sale. A SALE is a markdown: a
 * strike-through price that notifies watchers. They can run at once, and
 * conflating them would let a seller think they had discounted an item when
 * they had only bid on placement.
 */
@Serializable
data class PromotionState(
    @SerialName("opt_out") val optOut: Boolean = false,
    /** Tri-state per-listing override; null means "inherit the seller default". */
    @SerialName("promote_override") val promoteOverride: Boolean? = null,
    @SerialName("effective_promote") val effectivePromote: Boolean = false,
    @SerialName("promote_by_default") val promoteByDefault: Boolean = false,
    @SerialName("default_rate_pct") val defaultRatePct: Double? = null,
    @SerialName("default_mode") val defaultMode: String? = null,
    @SerialName("rate_pct") val ratePct: Double? = null,
    @SerialName("ad_id") val adId: String? = null,
    val status: String? = null,
    @SerialName("suggested_rate_pct") val suggestedRatePct: Double? = null,
    /**
     * `ebay_trending` or `category_heuristic`. Load-bearing: only the first is
     * eBay's own number, and calling our guess "eBay's rate" would be a lie the
     * seller prices against.
     */
    @SerialName("suggested_rate_basis") val suggestedRateBasis: String? = null,
    @SerialName("sale_active") val saleActive: Boolean = false,
    @SerialName("sale_pct") val salePct: Double? = null,
) {
    val suggestionFromEbay: Boolean get() = suggestedRateBasis == "ebay_trending"

    /** How the suggested rate should be described. Never overclaims its source. */
    val suggestionLabel: String?
        get() = suggestedRatePct?.let {
            val pct = Promotions.formatPct(it)
            if (suggestionFromEbay) {
                "eBay's trending rate for this category is $pct%."
            } else {
                "We suggest about $pct% for this category."
            }
        }
}

@Serializable
internal data class PromotionSetRequest(@SerialName("rate_pct") val ratePct: Double)

@Serializable
internal data class SaleRequest(
    @SerialName("percent_off") val percentOff: Double,
    @SerialName("end_date") val endDate: String? = null,
)

@Serializable
internal data class PromotionSetResponse(
    val ok: Boolean = false,
    @SerialName("rate_pct") val ratePct: Double? = null,
    @SerialName("ad_id") val adId: String? = null,
)
