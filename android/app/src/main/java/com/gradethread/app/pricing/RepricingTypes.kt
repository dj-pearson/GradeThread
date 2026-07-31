package com.gradethread.app.pricing

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1358: repricing rules and the suggestions a scan produces.
 *
 * Two different things share this screen. A RULE is standing automation — drop
 * this much, this often, never below this floor. A SUGGESTION is a one-off the
 * scan found by comparing a listing to condition-matched comps. Only the rule
 * acts on its own, which is why the rule editor asks for a floor and the
 * suggestion list asks for a decision.
 */
@Serializable
data class RepricingRule(
    val id: String = "",
    val name: String = "",
    val enabled: Boolean = true,
    @SerialName("inventory_item_id") val inventoryItemId: String? = null,
    @SerialName("filter_brand") val filterBrand: String? = null,
    @SerialName("filter_category_id") val filterCategoryId: String? = null,
    @SerialName("min_age_days") val minAgeDays: Int = 0,
    @SerialName("drop_pct") val dropPct: Double = 0.0,
    @SerialName("interval_days") val intervalDays: Int = 7,
    /** Never price below this. Null means no floor, which is worth saying out loud. */
    @SerialName("floor_price_cents") val floorPriceCents: Int? = null,
    @SerialName("auto_accept_confidence") val autoAcceptConfidence: Double? = null,
    @SerialName("last_run_at") val lastRunAt: String? = null,
)

/** One automatic price change a rule made — the applied-changes feed. */
@Serializable
data class RepricingAction(
    val id: String = "",
    @SerialName("rule_id") val ruleId: String? = null,
    @SerialName("listing_id") val listingId: String? = null,
    @SerialName("old_price_cents") val oldPriceCents: Int = 0,
    @SerialName("new_price_cents") val newPriceCents: Int = 0,
    val reason: String = "",
    /**
     * False means the local price moved but eBay didn't take it. Surfaced,
     * because a seller believing a price dropped when the listing still shows
     * the old one is worse than no automation at all.
     */
    @SerialName("ebay_synced") val ebaySynced: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
)

/** One scan finding. */
@Serializable
data class RepricingSuggestion(
    val id: String = "",
    @SerialName("current_price_cents") val currentPriceCents: Int = 0,
    @SerialName("suggested_price_cents") val suggestedPriceCents: Int = 0,
    @SerialName("comp_median_cents") val compMedianCents: Int? = null,
    @SerialName("comp_count") val compCount: Int? = null,
    @SerialName("reason_code") val reasonCode: String = "",
    val message: String? = null,
    val confidence: Double? = null,
    @SerialName("inventory_items") val item: SuggestionItem? = null,
    val listings: SuggestionListing? = null,
) {
    /** Positive = raise, negative = cut. */
    val deltaCents: Int get() = suggestedPriceCents - currentPriceCents

    /** Change as a fraction of the current price; null when there's no price. */
    val deltaFraction: Double?
        get() = if (currentPriceCents > 0) deltaCents.toDouble() / currentPriceCents else null

    val title: String get() = item?.title?.takeIf { it.isNotBlank() } ?: "Untitled item"
}

@Serializable
data class SuggestionItem(
    val title: String? = null,
    val brand: String? = null,
    @SerialName("grade_value") val gradeValue: Double? = null,
    @SerialName("grade_label") val gradeLabel: String? = null,
)

@Serializable
data class SuggestionListing(
    @SerialName("listing_url") val listingUrl: String? = null,
    @SerialName("listing_status") val listingStatus: String? = null,
)

/** What a scan pass did. */
@Serializable
data class ScanResult(
    val scanned: Int = 0,
    val actionable: Int = 0,
    @SerialName("skipped_no_category") val skippedNoCategory: Int = 0,
    val errors: Int = 0,
)

@Serializable
internal data class RulesResponse(val rules: List<RepricingRule> = emptyList())

@Serializable
internal data class RuleResponse(val rule: RepricingRule? = null)

@Serializable
internal data class ActionsResponse(val actions: List<RepricingAction> = emptyList())

@Serializable
internal data class SuggestionsResponse(
    val suggestions: List<RepricingSuggestion> = emptyList(),
)

/** The rule editor's working copy — floor price is typed in dollars. */
data class RuleDraft(
    val id: String? = null,
    val name: String = "",
    val enabled: Boolean = true,
    val filterBrand: String = "",
    val filterCategoryId: String = "",
    val minAgeDays: Int = 0,
    val dropPct: Double = 10.0,
    val intervalDays: Int = 7,
    val floorPriceText: String = "",
    val autoAcceptEnabled: Boolean = false,
    val autoAcceptConfidence: Double = 0.8,
) {
    companion object {
        fun from(rule: RepricingRule) = RuleDraft(
            id = rule.id,
            name = rule.name,
            enabled = rule.enabled,
            filterBrand = rule.filterBrand.orEmpty(),
            filterCategoryId = rule.filterCategoryId.orEmpty(),
            minAgeDays = rule.minAgeDays,
            dropPct = rule.dropPct,
            intervalDays = rule.intervalDays,
            floorPriceText = rule.floorPriceCents
                ?.let { com.gradethread.app.capture.CurrencyAmount.formatRaw(it.toLong()) }
                .orEmpty(),
            autoAcceptEnabled = rule.autoAcceptConfidence != null,
            autoAcceptConfidence = rule.autoAcceptConfidence ?: 0.8,
        )
    }
}

@Serializable
internal data class RuleRequest(
    val name: String,
    val enabled: Boolean,
    @SerialName("inventory_item_id") val inventoryItemId: String? = null,
    @SerialName("filter_brand") val filterBrand: String? = null,
    @SerialName("filter_category_id") val filterCategoryId: String? = null,
    @SerialName("min_age_days") val minAgeDays: Int,
    @SerialName("drop_pct") val dropPct: Double,
    @SerialName("interval_days") val intervalDays: Int,
    @SerialName("floor_price_cents") val floorPriceCents: Int? = null,
    @SerialName("auto_accept_confidence") val autoAcceptConfidence: Double? = null,
)

@Serializable
internal data class ScanRequest(val limit: Int)
