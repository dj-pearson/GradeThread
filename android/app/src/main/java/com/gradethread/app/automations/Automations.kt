package com.gradethread.app.automations

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.money.Money
import com.gradethread.app.ui.UiMessage
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

    // US-2976: the WIRE key stays a string - the server compares it - and the
    // words beside it are resource ids. The pairing is the point: these lists
    // are both the picker contents and the wire vocabulary, so splitting them
    // into two lists is how the two drift apart.

    val triggerTypes = listOf(
        "days_listed_gt" to R.string.automation_trigger_days_listed,
        "no_views_in_days" to R.string.automation_trigger_no_views,
        "watchers_lt_after_days" to R.string.automation_trigger_few_watchers,
    )

    val actionTypes = listOf(
        "price_drop_pct" to R.string.automation_action_price_drop,
        "set_promo_rate_pct" to R.string.automation_action_set_promo,
        "end_listing" to R.string.automation_action_end_listing,
    )

    val scopeFields = listOf(
        "brand" to R.string.automation_field_brand,
        "category" to R.string.automation_field_category,
        "size" to R.string.automation_field_size,
        "source" to R.string.automation_field_source,
        "cost" to R.string.automation_field_cost,
        "target_price" to R.string.automation_field_target_price,
        "status" to R.string.automation_field_status,
        "grade" to R.string.automation_field_grade,
        "days_in_status" to R.string.automation_field_days_in_status,
    )

    val scopeOps = listOf(
        "eq" to R.string.automation_op_eq,
        "neq" to R.string.automation_op_neq,
        "contains" to R.string.automation_op_contains,
        "in" to R.string.automation_op_in,
        "nin" to R.string.automation_op_nin,
        // The comparison symbols are resources too. They read the same in
        // Spanish, but a list where some entries are ids and some are literals
        // is one nobody can render with a single call.
        "gt" to R.string.automation_op_gt,
        "gte" to R.string.automation_op_gte,
        "lt" to R.string.automation_op_lt,
        "lte" to R.string.automation_op_lte,
        "isnull" to R.string.automation_op_isnull,
        "notnull" to R.string.automation_op_notnull,
    )

    /** Operators that take NO value — "is empty" needs nothing to compare to. */
    val valuelessOps = setOf("isnull", "notnull")

    /**
     * The resource for a wire key, or null when the server sent one this build
     * has never heard of.
     *
     * It used to fall back to the raw key, which put `watchers_lt_after_days`
     * on screen. The caller decides what to show instead, and at least knows it
     * is showing a fallback.
     */
    fun label(pairs: List<Pair<String, Int>>, value: String): Int? = pairs.firstOrNull { it.first == value }?.second

    // ── how a rule reads ─────────────────────────────────────────────────────

    // US-2976: every summary below returns a UiMessage - a resource plus its
    // numbers - rather than a built sentence. These are clauses that get
    // dropped INTO another sentence, and clause order is the first thing a
    // translation changes.

    fun triggerSummary(trigger: AutomationTrigger): UiMessage = when (trigger.type) {
        "no_views_in_days" ->
            UiMessage(R.string.automation_trigger_summary_no_views, args = listOf(trigger.days))

        "watchers_lt_after_days" -> UiMessage(
            R.string.automation_trigger_summary_watchers,
            args = listOf(trigger.watchers ?: 0, trigger.days),
        )

        else -> UiMessage(
            R.string.automation_trigger_summary_days_listed,
            args = listOf(trigger.days),
        )
    }

    fun actionSummary(action: AutomationAction): UiMessage = when (action.type) {
        "set_promo_rate_pct" -> UiMessage(
            R.string.automation_action_summary_promo,
            args = listOf(formatPct(action.pct ?: 0.0)),
        )

        "end_listing" -> UiMessage(R.string.automation_action_summary_end)
        else -> UiMessage(
            R.string.automation_action_summary_drop,
            args = listOf(formatPct(action.pct ?: 0.0)),
        )
    }

    /** Short badge for the action kind. */
    @StringRes
    fun actionLabel(action: AutomationAction): Int = when (action.type) {
        "set_promo_rate_pct" -> R.string.automation_action_badge_promo
        "end_listing" -> R.string.automation_action_badge_end
        else -> R.string.automation_action_badge_drop
    }

    /**
     * "All active listings" or "Filtered (2)".
     *
     * The unscoped case is spelled out: a rule with no filter reaches every live
     * listing the seller has, and one that ENDS listings deserves to say so.
     */
    fun scopeSummary(scope: AutomationScope): UiMessage {
        val rules = scope.rules
        return if (scope.type == "filter" && !rules.isNullOrEmpty()) {
            UiMessage(R.string.automation_scope_filtered, args = listOf(rules.size))
        } else {
            UiMessage(R.string.automation_scope_all)
        }
    }

    /**
     * The three clauses of the one-sentence summary.
     *
     * US-2976: the screen joins them with R.string.automation_sentence, which
     * is where "When X, Y (z)." lives. English puts the trigger first; that is
     * not a fact about automations, it is a fact about English.
     */
    fun sentenceParts(rule: AutomationRule): Sentence = Sentence(
        trigger = triggerSummary(rule.trigger),
        action = actionSummary(rule.action),
        scope = scopeSummary(rule.scope),
    )

    data class Sentence(val trigger: UiMessage, val action: UiMessage, val scope: UiMessage)

    /**
     * The warning worth showing before a rule goes live.
     *
     * An unscoped end-listing rule can take down a seller's entire shop on a
     * timer. That is a legitimate thing to want and a catastrophic thing to do
     * by accident, so it is named rather than left to be discovered.
     */
    @StringRes
    fun scopeWarning(rule: AutomationRule): Int? = when {
        !rule.isActive -> null
        rule.action.type == "end_listing" && rule.scope.type != "filter" ->
            R.string.automation_scope_warning

        else -> null
    }

    // ── the draft ────────────────────────────────────────────────────────────

    private fun needsPct(draft: AutomationDraft) = draft.actionType != "end_listing"

    fun isValid(draft: AutomationDraft): Boolean = validationError(draft) == null

    /** Why the draft can't be saved, in the words the seller needs. */
    fun validationError(draft: AutomationDraft): UiMessage? {
        val name = draft.name.trim()
        return when {
            name.isEmpty() -> UiMessage(R.string.automation_error_name_required)
            name.length > NAME_MAX ->
                UiMessage(R.string.automation_error_name_too_long, args = listOf(NAME_MAX))

            !needsPct(draft) -> null
            draft.actionPct < 1 -> UiMessage(R.string.automation_error_pct_min)
            draft.actionType == "price_drop_pct" && draft.actionPct > MAX_PRICE_DROP_PCT ->
                UiMessage(
                    R.string.automation_error_price_drop_max,
                    args = listOf(formatPct(MAX_PRICE_DROP_PCT)),
                )

            draft.actionType == "set_promo_rate_pct" && draft.actionPct > MAX_PROMO_RATE_PCT ->
                UiMessage(
                    R.string.automation_error_promo_max,
                    args = listOf(formatPct(MAX_PROMO_RATE_PCT)),
                )

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

    fun dryRunSummary(result: AutomationDryRunResult): UiMessage = when {
        result.scanned == 0 -> UiMessage(R.string.automation_dryrun_none)
        result.matches.isEmpty() ->
            UiMessage(R.string.automation_dryrun_no_matches, args = listOf(result.scanned))

        else -> UiMessage(
            R.string.automation_dryrun_would_change,
            args = listOf(result.matches.size, result.scanned),
        )
    }

    /** "$48.00 -> $43.20" for a price row; the promo rows read as percentages. */
    fun matchSummary(match: AutomationDryRunMatch): UiMessage = when {
        match.newPriceCents != null -> UiMessage(
            if (match.floored) {
                R.string.automation_match_price_floored
            } else {
                R.string.automation_match_price
            },
            args = listOf(money(match.currentPriceCents), money(match.newPriceCents)),
        )

        match.newPromoRatePct != null -> UiMessage(
            R.string.automation_match_promo,
            args = listOf(match.currentPromoRatePct ?: 0, match.newPromoRatePct),
        )

        match.actionType == "end_listing" -> UiMessage(R.string.automation_match_ended)
        else -> UiMessage(R.string.automation_match_changed)
    }

    fun runSummary(result: AutomationRunResult): UiMessage = when {
        result.skipped == true ->
            result.reason?.takeIf { it.isNotBlank() }
                ?.let { UiMessage(R.string.automation_run_skipped_reason, args = listOf(it)) }
                ?: UiMessage(R.string.automation_run_skipped)

        result.appliedCount == 0 ->
            UiMessage(R.string.automation_run_nothing, args = listOf(result.scannedCount))

        else -> UiMessage(
            R.string.automation_run_changed,
            args = listOf(result.appliedCount, result.scannedCount),
        )
    }

    /**
     * How many changes the local rows took but eBay didn't - those listings
     * still show the old value. Null when everything synced.
     *
     * US-2976: the COUNT, because singular versus plural is a plurals resource
     * and Spanish cannot be picked by an `if (n == 1)` written in English.
     */
    fun unsyncedCount(rows: List<AutomationActionRow>): Int? = rows.count { !it.ebaySynced }.takeIf { it > 0 }

    // ── formatting (AC2: locale-aware) ───────────────────────────────────────

    /** Whole percents lose the ".0"; anything else keeps one decimal. */
    fun formatPct(pct: Double): String =
        if (pct == Math.floor(pct)) pct.toInt().toString() else String.format(Locale.US, "%.1f", pct)

    /**
     * Money through the shared formatter, which follows the DEVICE locale for
     * separators and symbol position — a hardcoded "$12.34" is wrong for most
     * of the world even when the amount is USD.
     */
    fun money(cents: Int, locale: Locale = Locale.getDefault()): String = Money.format(cents / 100.0, locale)
}
