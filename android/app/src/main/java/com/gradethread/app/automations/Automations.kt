package com.gradethread.app.automations

import com.gradethread.app.money.Money
import java.util.Locale

/**
 * US-1362: what an automation rule says it will do, and what gets sent.
 *
 * These rules end listings and cut prices without anyone watching, so the
 * summaries have to read as promises the server will keep: the bounds mirror
 * `lib/automation-rules.ts`, and every number shown goes through the shared
 * locale-aware money formatter rather than a hardcoded dollar sign.
 */
object Automations {

    /** Server bounds (`automation-rules.ts`). */
    const val NAME_MAX = 80
    const val MAX_PRICE_DROP_PCT = 90.0
    const val MAX_PROMO_RATE_PCT = 100.0
    const val DEFAULT_COOLDOWN_DAYS = 7
    const val DEFAULT_MARGIN_FLOOR_PCT = 10

    // ── vocabulary ───────────────────────────────────────────────────────────

    val triggerTypes = listOf(
        "days_listed_gt" to "Listed more than…",
        "no_views_in_days" to "No views after…",
        "watchers_lt_after_days" to "Few watchers after…",
    )

    val actionTypes = listOf(
        "price_drop_pct" to "Drop price by %",
        "set_promo_rate_pct" to "Set promo rate %",
        "end_listing" to "End the listing",
    )

    val scopeFields = listOf(
        "brand" to "Brand",
        "category" to "Category",
        "size" to "Size",
        "source" to "Source",
        "cost" to "Cost",
        "target_price" to "Target price",
        "status" to "Status",
        "grade" to "Grade",
        "days_in_status" to "Days in status",
    )

    val scopeOps = listOf(
        "eq" to "is",
        "neq" to "is not",
        "contains" to "contains",
        "in" to "is any of",
        "nin" to "is none of",
        "gt" to ">",
        "gte" to "≥",
        "lt" to "<",
        "lte" to "≤",
        "isnull" to "is empty",
        "notnull" to "is set",
    )

    /** Operators that take NO value — "is empty" needs nothing to compare to. */
    val valuelessOps = setOf("isnull", "notnull")

    fun label(pairs: List<Pair<String, String>>, value: String): String =
        pairs.firstOrNull { it.first == value }?.second ?: value

    // ── how a rule reads ─────────────────────────────────────────────────────

    fun triggerSummary(trigger: AutomationTrigger): String = when (trigger.type) {
        "no_views_in_days" -> "no views after ${trigger.days} days"
        "watchers_lt_after_days" ->
            "fewer than ${trigger.watchers ?: 0} watchers after ${trigger.days} days"

        else -> "listed more than ${trigger.days} days"
    }

    fun actionSummary(action: AutomationAction): String = when (action.type) {
        "set_promo_rate_pct" -> "set promo rate to ${formatPct(action.pct ?: 0.0)}%"
        "end_listing" -> "end the listing"
        else -> "drop price ${formatPct(action.pct ?: 0.0)}%"
    }

    /** Short badge for the action kind. */
    fun actionLabel(action: AutomationAction): String = when (action.type) {
        "set_promo_rate_pct" -> "Promo rate"
        "end_listing" -> "End listing"
        else -> "Price drop"
    }

    /**
     * "All active listings" or "Filtered (2)".
     *
     * The unscoped case is spelled out: a rule with no filter reaches every live
     * listing the seller has, and one that ENDS listings deserves to say so.
     */
    fun scopeSummary(scope: AutomationScope): String {
        val rules = scope.rules
        return if (scope.type == "filter" && !rules.isNullOrEmpty()) {
            "Filtered (${rules.size})"
        } else {
            "All active listings"
        }
    }

    /** The whole rule in one sentence: when → what → to which listings. */
    fun sentence(rule: AutomationRule): String =
        "When ${triggerSummary(rule.trigger)}, ${actionSummary(rule.action)} " +
            "(${scopeSummary(rule.scope).lowercase()})."

    /**
     * The warning worth showing before a rule goes live.
     *
     * An unscoped end-listing rule can take down a seller's entire shop on a
     * timer. That is a legitimate thing to want and a catastrophic thing to do
     * by accident, so it is named rather than left to be discovered.
     */
    fun scopeWarning(rule: AutomationRule): String? = when {
        !rule.isActive -> null
        rule.action.type == "end_listing" && rule.scope.type != "filter" ->
            "This ends EVERY active listing that matches the trigger. Add a filter " +
                "if you meant a subset."

        else -> null
    }

    // ── the draft ────────────────────────────────────────────────────────────

    private fun needsPct(draft: AutomationDraft) = draft.actionType != "end_listing"

    fun isValid(draft: AutomationDraft): Boolean = validationError(draft) == null

    /** Why the draft can't be saved, in the words the seller needs. */
    fun validationError(draft: AutomationDraft): String? {
        val name = draft.name.trim()
        return when {
            name.isEmpty() -> "Give the rule a name."
            name.length > NAME_MAX -> "That name is too long — keep it under $NAME_MAX characters."
            !needsPct(draft) -> null
            draft.actionPct < 1 -> "Set a percentage of at least 1."
            draft.actionType == "price_drop_pct" && draft.actionPct > MAX_PRICE_DROP_PCT ->
                "A price drop can't be more than ${formatPct(MAX_PRICE_DROP_PCT)}%."

            draft.actionType == "set_promo_rate_pct" && draft.actionPct > MAX_PROMO_RATE_PCT ->
                "A promo rate can't be more than ${formatPct(MAX_PROMO_RATE_PCT)}%."

            else -> null
        }
    }

    fun trigger(draft: AutomationDraft): AutomationTrigger {
        val days = maxOf(1, draft.triggerDays)
        val cooldown = maxOf(1, draft.cooldownDays)
        return if (draft.triggerType == "watchers_lt_after_days") {
            AutomationTrigger(draft.triggerType, days, cooldown, maxOf(1, draft.triggerWatchers))
        } else {
            // watchers is omitted rather than zeroed for the other triggers — a
            // 0 would read as a real threshold nobody set.
            AutomationTrigger(draft.triggerType, days, cooldown, null)
        }
    }

    fun action(draft: AutomationDraft): AutomationAction = when (draft.actionType) {
        "set_promo_rate_pct" -> AutomationAction("set_promo_rate_pct", draft.actionPct, null)
        "end_listing" -> AutomationAction("end_listing", null, null)
        else -> AutomationAction(
            "price_drop_pct",
            draft.actionPct,
            maxOf(0, draft.marginFloorPct),
        )
    }

    /**
     * The scope, with incomplete clauses dropped.
     *
     * A clause with no value would match everything, quietly turning a filtered
     * rule into an unfiltered one — the most dangerous silent widening this
     * screen can produce. If every clause drops out, the scope falls back to
     * `all`, which the UI then labels honestly.
     */
    fun scope(draft: AutomationDraft): AutomationScope {
        val rules = draft.scopeRules.mapNotNull { rule ->
            val value = rule.value.trim()
            val valueless = rule.op in valuelessOps
            if (!valueless && value.isEmpty()) return@mapNotNull null
            AutomationScopeRule(rule.field, rule.op, value)
        }
        return if (draft.scopeMode == "filter" && rules.isNotEmpty()) {
            AutomationScope("filter", draft.combinator, rules)
        } else {
            AutomationScope("all", null, null)
        }
    }

    internal fun input(draft: AutomationDraft) = AutomationRuleInput(
        name = draft.name.trim(),
        isActive = draft.isActive,
        trigger = trigger(draft),
        action = action(draft),
        scope = scope(draft),
    )

    /**
     * True when the seller asked for a filter but every clause was incomplete.
     * The rule would run against everything — so the editor says so first.
     */
    fun scopeSilentlyWidened(draft: AutomationDraft): Boolean =
        draft.scopeMode == "filter" && scope(draft).type == "all"

    // ── dry run + activity ───────────────────────────────────────────────────

    fun dryRunSummary(result: AutomationDryRunResult): String = when {
        result.scanned == 0 -> "No active listings to check."
        result.matches.isEmpty() -> "Checked ${result.scanned}. Nothing matches yet."
        else -> "Would change ${result.matches.size} of ${result.scanned}."
    }

    /** "$48.00 → $43.20" for a price row; the promo rows read as percentages. */
    fun matchSummary(match: AutomationDryRunMatch): String = when {
        match.newPriceCents != null ->
            "${money(match.currentPriceCents)} → ${money(match.newPriceCents)}" +
                if (match.floored) " (stopped at your margin floor)" else ""

        match.newPromoRatePct != null ->
            "promo ${match.currentPromoRatePct ?: 0}% → ${match.newPromoRatePct}%"

        match.actionType == "end_listing" -> "would be ended"
        else -> "would change"
    }

    fun runSummary(result: AutomationRunResult): String = when {
        result.skipped == true ->
            result.reason?.takeIf { it.isNotBlank() }?.let { "Skipped: $it" } ?: "Skipped."

        result.appliedCount == 0 -> "Checked ${result.scannedCount}. Nothing to change."
        else -> "Changed ${result.appliedCount} of ${result.scannedCount}."
    }

    /** A change the local row took but eBay didn't — the listing still shows the old value. */
    fun unsyncedWarning(rows: List<AutomationActionRow>): String? {
        val unsynced = rows.count { !it.ebaySynced }
        if (unsynced == 0) return null
        return "$unsynced ${if (unsynced == 1) "change" else "changes"} didn't reach eBay — " +
            "those listings still show the old value."
    }

    // ── formatting (AC2: locale-aware) ───────────────────────────────────────

    /** Whole percents lose the ".0"; anything else keeps one decimal. */
    fun formatPct(pct: Double): String =
        if (pct == Math.floor(pct)) pct.toInt().toString() else String.format(Locale.US, "%.1f", pct)

    /**
     * Money through the shared formatter, which follows the DEVICE locale for
     * separators and symbol position — a hardcoded "$12.34" is wrong for most
     * of the world even when the amount is USD.
     */
    fun money(cents: Int, locale: Locale = Locale.getDefault()): String =
        Money.format(cents / 100.0, locale)
}
