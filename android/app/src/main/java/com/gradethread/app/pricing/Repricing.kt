package com.gradethread.app.pricing

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.money.Money
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
    fun validationError(draft: RuleDraft): String? = when {
        draft.name.isBlank() -> "Give the rule a name."
        draft.name.trim().length > RULE_NAME_MAX ->
            "That name is too long — keep it under $RULE_NAME_MAX characters."

        clampDrop(draft.dropPct) <= 0.0 && !draft.autoAcceptEnabled ->
            "Set a drop percentage or turn on auto-accept, so the rule does something."

        else -> null
    }

    fun clampDrop(pct: Double): Double =
        if (!pct.isFinite()) 0.0 else pct.coerceIn(0.0, MAX_DROP_PCT)

    fun clampConfidence(value: Double): Double =
        if (!value.isFinite()) 0.0 else value.coerceIn(0.0, 1.0)

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

    /** "Drop 10% every 7d · auto-accept ≥ 80% · floor $9.99". */
    fun actionSummary(rule: RepricingRule): String {
        val parts = buildList {
            if (rule.dropPct > 0) add("Drop ${formatPct(rule.dropPct)}% every ${rule.intervalDays}d")
            rule.autoAcceptConfidence?.let {
                add("auto-accept ≥ ${(it * 100).roundToInt()}%")
            }
            rule.floorPriceCents?.let { add("floor ${Money.format(it / 100.0)}") }
        }
        return if (parts.isEmpty()) "No effect" else parts.joinToString(" · ")
    }

    /**
     * "Nike · 30d+ old", or "All listings".
     *
     * The unscoped case is spelled out rather than left blank: a rule with no
     * filters touches everything the seller has live, and that deserves saying.
     */
    fun scopeSummary(rule: RepricingRule): String {
        val parts = buildList {
            if (rule.inventoryItemId != null) add("One item")
            rule.filterBrand?.takeIf { it.isNotBlank() }?.let { add(it) }
            rule.filterCategoryId?.takeIf { it.isNotBlank() }?.let { add("category $it") }
            if (rule.minAgeDays > 0) add("${rule.minAgeDays}d+ old")
        }
        return if (parts.isEmpty()) "All listings" else parts.joinToString(" · ")
    }

    /** A rule with no floor can run a price all the way down. Say so. */
    fun floorWarning(rule: RepricingRule): String? =
        if (rule.enabled && rule.dropPct > 0 && rule.floorPriceCents == null) {
            "No floor set — this rule keeps cutting with nothing to stop it."
        } else {
            null
        }

    // ── how a suggestion reads ───────────────────────────────────────────────

    /** Plain-language reason. Unknown codes pass through rather than vanish. */
    fun reasonLabel(code: String): String = when (code.uppercase()) {
        "UNDERPRICED" -> "Priced under comparable listings"
        "OVERPRICED" -> "Priced over comparable listings"
        "STALE" -> "Sitting unsold"
        else -> code.replace('_', ' ').lowercase().replaceFirstChar { it.uppercaseChar() }
    }

    /** "$48.00 → $42.00 (−12%)". The direction is the point. */
    fun changeSummary(suggestion: RepricingSuggestion): String {
        val from = Money.format(suggestion.currentPriceCents / 100.0)
        val to = Money.format(suggestion.suggestedPriceCents / 100.0)
        val pct = suggestion.deltaFraction
            ?.let { " (${if (it >= 0) "+" else "−"}${(kotlin.math.abs(it) * 100).roundToInt()}%)" }
            .orEmpty()
        return "$from → $to$pct"
    }

    /**
     * What the comps behind a suggestion actually support.
     *
     * A suggestion from two comps is a guess; from thirty it's a signal. The
     * count is shown rather than hidden behind a confidence score, because a
     * seller can judge "based on 2 listings" for themselves.
     */
    fun evidenceSummary(suggestion: RepricingSuggestion): String? {
        val count = suggestion.compCount ?: return null
        if (count <= 0) return null
        val median = suggestion.compMedianCents
            ?.let { " · median ${Money.format(it / 100.0)}" }
            .orEmpty()
        return "Based on $count comparable ${if (count == 1) "listing" else "listings"}$median"
    }

    /** What a scan pass found, in one line. */
    fun scanSummary(result: ScanResult): String = when {
        result.scanned == 0 -> "No active listings to scan."
        result.actionable == 0 -> "Scanned ${result.scanned}. Nothing worth changing."
        else -> "Scanned ${result.scanned}, ${result.actionable} worth a look."
    }

    /**
     * The part of a scan that quietly did nothing.
     *
     * Listings with no eBay category can't be compared to anything, and lumping
     * them into "nothing worth changing" would hide a fixable gap.
     */
    fun scanCaveat(result: ScanResult): String? = buildList {
        if (result.skippedNoCategory > 0) {
            add("${result.skippedNoCategory} skipped with no eBay category")
        }
        if (result.errors > 0) add("${result.errors} couldn't be checked")
    }.takeIf { it.isNotEmpty() }?.joinToString(", ")

    fun formatPct(pct: Double): String =
        if (pct == Math.floor(pct)) pct.toInt().toString() else String.format(Locale.US, "%.1f", pct)
}
