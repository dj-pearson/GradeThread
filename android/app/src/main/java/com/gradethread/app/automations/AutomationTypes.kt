package com.gradethread.app.automations

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1362: trigger → action → scope rules the server cron applies.
 *
 * Distinct from repricing rules (US-1358): those only move prices on a
 * schedule, these fire on a CONDITION (age, views, watchers) and can end a
 * listing outright. Same screen family, different consequences — which is why
 * the two are kept apart rather than merged into one "rules" surface.
 */
@Serializable
data class AutomationTrigger(
    /** `days_listed_gt` | `no_views_in_days` | `watchers_lt_after_days`. */
    val type: String = "days_listed_gt",
    val days: Int = 30,
    @SerialName("cooldown_days") val cooldownDays: Int = 7,
    /** Only meaningful for `watchers_lt_after_days`. */
    val watchers: Int? = null,
)

@Serializable
data class AutomationAction(
    /** `price_drop_pct` | `set_promo_rate_pct` | `end_listing`. */
    val type: String = "price_drop_pct",
    val pct: Double? = null,
    /** The margin a price drop won't cut below. Price-drop only. */
    @SerialName("margin_floor_pct") val marginFloorPct: Int? = null,
)

@Serializable
data class AutomationScopeRule(
    val field: String = "brand",
    val op: String = "eq",
    val value: String = "",
)

@Serializable
data class AutomationScope(
    /** `all` | `filter`. */
    val type: String = "all",
    /** `and` | `or`; filter only. */
    val combinator: String? = null,
    val rules: List<AutomationScopeRule>? = null,
)

@Serializable
data class AutomationRule(
    val id: String = "",
    val name: String = "",
    @SerialName("trigger_json") val trigger: AutomationTrigger = AutomationTrigger(),
    @SerialName("action_json") val action: AutomationAction = AutomationAction(),
    @SerialName("scope_json") val scope: AutomationScope = AutomationScope(),
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("last_run_at") val lastRunAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
internal data class AutomationRuleInput(
    val name: String,
    @SerialName("is_active") val isActive: Boolean,
    @SerialName("trigger_json") val trigger: AutomationTrigger,
    @SerialName("action_json") val action: AutomationAction,
    @SerialName("scope_json") val scope: AutomationScope,
)

/** One listing a dry run says the rule WOULD touch. Nothing is applied. */
@Serializable
data class AutomationDryRunMatch(
    @SerialName("listing_id") val listingId: String = "",
    val title: String? = null,
    @SerialName("action_type") val actionType: String = "",
    @SerialName("current_price_cents") val currentPriceCents: Int = 0,
    @SerialName("new_price_cents") val newPriceCents: Int? = null,
    @SerialName("current_promo_rate_pct") val currentPromoRatePct: Int? = null,
    @SerialName("new_promo_rate_pct") val newPromoRatePct: Int? = null,
    /**
     * The drop was stopped by the margin floor. Worth showing: the rule
     * matched, but it did less than the seller asked for.
     */
    val floored: Boolean = false,
) {
    val displayTitle: String get() = title?.takeIf { it.isNotBlank() } ?: "Untitled item"
}

@Serializable
data class AutomationDryRunResult(
    @SerialName("listings_scanned") val listingsScanned: Int? = null,
    val affected: List<AutomationDryRunMatch>? = null,
) {
    val scanned: Int get() = listingsScanned ?: 0
    val matches: List<AutomationDryRunMatch> get() = affected.orEmpty()
}

@Serializable
data class AutomationActionDetail(
    @SerialName("price_cents") val priceCents: Int? = null,
    @SerialName("promo_rate_pct") val promoRatePct: Int? = null,
    @SerialName("listing_status") val listingStatus: String? = null,
)

/** One change a rule actually made — the per-rule activity feed. */
@Serializable
data class AutomationActionRow(
    val id: String = "",
    @SerialName("action_type") val actionType: String = "",
    @SerialName("before_json") val before: AutomationActionDetail? = null,
    @SerialName("after_json") val after: AutomationActionDetail? = null,
    /**
     * False means the local row changed but eBay didn't take it — the listing
     * a buyer sees still shows the old price.
     */
    @SerialName("ebay_synced") val ebaySynced: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
)

/** Result of an on-demand run. Optional counts so a disabled-feature reply decodes. */
@Serializable
data class AutomationRunResult(
    val ok: Boolean = false,
    val applied: Int? = null,
    @SerialName("listings_scanned") val listingsScanned: Int? = null,
    val errors: Int? = null,
    val skipped: Boolean? = null,
    val reason: String? = null,
) {
    val appliedCount: Int get() = applied ?: 0
    val scannedCount: Int get() = listingsScanned ?: 0
}

@Serializable
internal data class AutomationRulesResponse(val rules: List<AutomationRule> = emptyList())

@Serializable
internal data class AutomationRuleResponse(val rule: AutomationRule? = null)

@Serializable
internal data class AutomationActionsResponse(
    val actions: List<AutomationActionRow> = emptyList(),
)

/** The editor's working copy. */
data class AutomationDraft(
    val id: String? = null,
    val name: String = "",
    val isActive: Boolean = true,
    val triggerType: String = "days_listed_gt",
    val triggerDays: Int = 30,
    val triggerWatchers: Int = 2,
    val cooldownDays: Int = 7,
    val actionType: String = "price_drop_pct",
    val actionPct: Double = 10.0,
    val marginFloorPct: Int = 10,
    val scopeMode: String = "all",
    val combinator: String = "and",
    val scopeRules: List<ScopeRuleDraft> = emptyList(),
) {
    companion object {
        fun from(rule: AutomationRule): AutomationDraft {
            val filtered = rule.scope.type == "filter" && !rule.scope.rules.isNullOrEmpty()
            return AutomationDraft(
                id = rule.id,
                name = rule.name,
                isActive = rule.isActive,
                triggerType = rule.trigger.type,
                triggerDays = maxOf(1, rule.trigger.days),
                triggerWatchers = rule.trigger.watchers ?: 2,
                cooldownDays = maxOf(1, rule.trigger.cooldownDays),
                actionType = rule.action.type,
                actionPct = rule.action.pct ?: 10.0,
                marginFloorPct = rule.action.marginFloorPct ?: 10,
                scopeMode = if (filtered) "filter" else "all",
                combinator = rule.scope.combinator ?: "and",
                scopeRules = rule.scope.rules.orEmpty().map {
                    ScopeRuleDraft(it.field, it.op, it.value)
                },
            )
        }
    }
}

data class ScopeRuleDraft(
    val field: String = "brand",
    val op: String = "eq",
    val value: String = "",
)
