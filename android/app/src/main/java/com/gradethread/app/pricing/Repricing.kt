package com.gradethread.app.pricing

import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.money.Money
import com.gradethread.app.ui.UiMessage
import java.util.Locale
import kotlin.math.roundToInt

/**
 * US-1358: the repricing rules, as pure functions.
 *
 * These decide what a standing rule will do to live prices while nobody is
 * watching, so the bounds mirror the server's own normaliser
 * (`lib/repricing-rules.ts`) exactly — a client that let a 95% drop through
 * would show the seller a rule the server silently rewrote to 90.
 */
object Repricing {

    /** Server bounds (`repricing-rules.ts`). */
    const val RULE_NAME_MAX = 80
    const val MAX_DROP_PCT = 90.0
    const val MIN_INTERVAL_DAYS = 1
    const val DEFAULT_SCAN_LIMIT = 25
    const val MAX_SCAN_LIMIT = 50

    /**
     * Whether the draft can be saved.
     *
     * A rule needs a name AND an effect. One with neither a drop nor an
     * auto-accept is a rule that runs forever and changes nothing, which reads
     * as broken automation rather than as the no-op it is — the server refuses
     * it for the same reason.
     */
    fun isValid(draft: RuleDraft): Boolean {
        val name = draft.name.trim()
        return name.isNotEmpty() &&
            name.length <= RULE_NAME_MAX &&
            (clampDrop(draft.dropPct) > 0.0 || draft.autoAcceptEnabled)
    }

    /** Why a draft can't be saved, or null when it can. */
    fun validationError(draft: RuleDraft): UiMessage? = when {
        draft.name.isBlank() -> UiMessage(R.string.repricing_error_name_required)
        draft.name.trim().length > RULE_NAME_MAX ->
            UiMessage(R.string.repricing_error_name_too_long, args = listOf(RULE_NAME_MAX))

        clampDrop(draft.dropPct) <= 0.0 && !draft.autoAcceptEnabled ->
            UiMessage(R.string.repricing_error_no_effect)

        else -> null
    }

    fun clampDrop(pct: Double): Double = if (!pct.isFinite()) 0.0 else pct.coerceIn(0.0, MAX_DROP_PCT)

    fun clampConfidence(value: Double): Double = if (!value.isFinite()) 0.0 else value.coerceIn(0.0, 1.0)

    fun clampScanLimit(limit: Int): Int = limit.coerceIn(1, MAX_SCAN_LIMIT)

    /** Floor price text → cents, or null when blank/unparseable. */
    fun floorPriceCents(text: String): Int? = CurrencyAmount.parseCents(text)?.toInt()

    /** The request body, normalised the way the server would normalise it. */
    internal fun request(draft: RuleDraft) = RuleRequest(
        name = draft.name.trim(),
        enabled = draft.enabled,
        filterBrand = draft.filterBrand.trim().takeIf { it.isNotEmpty() },
        filterCategoryId = draft.filterCategoryId.trim().takeIf { it.isNotEmpty() },
        minAgeDays = draft.minAgeDays.coerceAtLeast(0),
        dropPct = clampDrop(draft.dropPct),
        intervalDays = draft.intervalDays.coerceAtLeast(MIN_INTERVAL_DAYS),
        floorPriceCents = floorPriceCents(draft.floorPriceText),
        // Off means the column goes null, not zero: a 0.0 confidence would
        // auto-accept everything, the exact opposite of "don't auto-accept".
        autoAcceptConfidence = draft.autoAcceptConfidence
            .takeIf { draft.autoAcceptEnabled }
            ?.let { clampConfidence(it) },
    )

    // ── how a rule reads ─────────────────────────────────────────────────────

    /**
     * The clauses of "Drop 10% every 7d - auto-accept >= 80% - floor $9.99".
     *
     * US-2976: a LIST, joined on screen with R.string.repricing_separator. Each
     * clause is independent, so joining here would be the one step that cannot
     * be translated - and an empty list is the "No effect" case rather than a
     * blank line.
     */
    fun actionSummary(rule: RepricingRule): List<UiMessage> = buildList {
        if (rule.dropPct > 0) {
            add(
                UiMessage(
                    R.string.repricing_action_drop,
                    args = listOf(formatPct(rule.dropPct), rule.intervalDays),
                ),
            )
        }
        rule.autoAcceptConfidence?.let {
            add(
                UiMessage(
                    R.string.repricing_action_auto_accept,
                    args = listOf((it * 100).roundToInt()),
                ),
            )
        }
        rule.floorPriceCents?.let {
            add(UiMessage(R.string.repricing_action_floor, args = listOf(Money.format(it / 100.0))))
        }
        if (isEmpty()) add(UiMessage(R.string.repricing_action_none))
    }

    /**
     * "Nike · 30d+ old", or "All listings".
     *
     * The unscoped case is spelled out rather than left blank: a rule with no
     * filters touches everything the seller has live, and that deserves saying.
     */
    fun scopeSummary(rule: RepricingRule): List<UiMessage> = buildList {
        if (rule.inventoryItemId != null) add(UiMessage(R.string.repricing_scope_one_item))
        // The brand is the seller's own word for it and goes through
        // unchanged; the resource is a bare "%1$s" so the clause still has a
        // name and can be moved like any other.
        rule.filterBrand?.takeIf { it.isNotBlank() }
            ?.let { add(UiMessage(R.string.repricing_scope_brand, args = listOf(it))) }
        rule.filterCategoryId?.takeIf { it.isNotBlank() }
            ?.let { add(UiMessage(R.string.repricing_scope_category, args = listOf(it))) }
        if (rule.minAgeDays > 0) {
            add(UiMessage(R.string.repricing_scope_min_age, args = listOf(rule.minAgeDays)))
        }
        if (isEmpty()) add(UiMessage(R.string.repricing_scope_all))
    }

    /** A rule with no floor can run a price all the way down. Say so. */
    @StringRes
    fun floorWarning(rule: RepricingRule): Int? =
        if (rule.enabled && rule.dropPct > 0 && rule.floorPriceCents == null) {
            R.string.repricing_no_floor
        } else {
            null
        }

    // ── how a suggestion reads ───────────────────────────────────────────────

    /**
     * Plain-language reason. Unknown codes pass through rather than vanish.
     *
     * US-2976: a code this build has not been taught arrives as `detail`,
     * which is exactly what that field is for - the server's own word, shown
     * untranslated because we have nothing better. Tidied up, not hidden: a
     * reason nobody can read still beats a suggestion with no reason at all.
     */
    fun reasonLabel(code: String): UiMessage = when (code.uppercase()) {
        "UNDERPRICED" -> UiMessage(R.string.repricing_reason_underpriced)
        "OVERPRICED" -> UiMessage(R.string.repricing_reason_overpriced)
        "STALE" -> UiMessage(R.string.repricing_reason_stale)
        else -> UiMessage(
            // If the detail were ever missing, "Repricing suggested" is still
            // true - which is the test for a fallback resource.
            R.string.repricing_reason_unknown,
            detail = code.replace('_', ' ').lowercase().replaceFirstChar { it.uppercaseChar() },
        )
    }

    /**
     * "$48.00 -> $42.00 (-12%)". The direction is the point.
     *
     * US-2976: up and down are separate resources rather than a sign glued on,
     * because the sign is the one part a reader must not misread and a
     * translator must be able to see which case they are wording.
     */
    fun changeSummary(suggestion: RepricingSuggestion): UiMessage {
        val from = Money.format(suggestion.currentPriceCents / 100.0)
        val to = Money.format(suggestion.suggestedPriceCents / 100.0)
        val delta = suggestion.deltaFraction
            ?: return UiMessage(R.string.repricing_change, args = listOf(from, to))
        return UiMessage(
            if (delta >= 0) R.string.repricing_change_up else R.string.repricing_change_down,
            args = listOf(from, to, (kotlin.math.abs(delta) * 100).roundToInt()),
        )
    }

    /**
     * What the comps behind a suggestion actually support.
     *
     * A suggestion from two comps is a guess; from thirty it's a signal. The
     * count is shown rather than hidden behind a confidence score, because a
     * seller can judge "based on 2 listings" for themselves.
     */
    fun evidenceSummary(suggestion: RepricingSuggestion): UiMessage? {
        val count = suggestion.compCount ?: return null
        if (count <= 0) return null
        val median = suggestion.compMedianCents?.let { Money.format(it / 100.0) }
            ?: return UiMessage.plural(
                R.plurals.repricing_evidence,
                args = listOf(count),
                quantity = count,
            )
        return UiMessage.plural(
            R.plurals.repricing_evidence_median,
            args = listOf(count, median),
            quantity = count,
        )
    }

    /** What a scan pass found, in one line. */
    fun scanSummary(result: ScanResult): UiMessage = when {
        result.scanned == 0 -> UiMessage(R.string.repricing_scan_none)
        result.actionable == 0 ->
            UiMessage(R.string.repricing_scan_nothing, args = listOf(result.scanned))

        else -> UiMessage(
            R.string.repricing_scan_actionable,
            args = listOf(result.scanned, result.actionable),
        )
    }

    /**
     * The part of a scan that quietly did nothing.
     *
     * Listings with no eBay category can't be compared to anything, and lumping
     * them into "nothing worth changing" would hide a fixable gap.
     */
    fun scanCaveat(result: ScanResult): List<UiMessage> = buildList {
        if (result.skippedNoCategory > 0) {
            add(plural(R.plurals.repricing_skipped_no_category, result.skippedNoCategory))
        }
        if (result.errors > 0) add(plural(R.plurals.repricing_scan_errors, result.errors))
    }

    /** A plurals resource whose count is also the number in the sentence. */
    private fun plural(@PluralsRes res: Int, count: Int) = UiMessage.plural(res, args = listOf(count), quantity = count)

    fun formatPct(pct: Double): String =
        if (pct == Math.floor(pct)) pct.toInt().toString() else String.format(Locale.US, "%.1f", pct)
}
