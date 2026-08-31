package com.gradethread.app.marketplaces.promotions

import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import java.util.Locale

/**
 * US-1357: the promotion + markdown rules.
 *
 * Both bounds mirror the edge's own (`ebay-marketing.ts`), so the number the
 * seller sees is the number the server will apply — a client that let 25%
 * through only to have it silently clamped to 20 would misreport what the
 * listing is actually paying.
 */
object Promotions {

    /** Ad rate, in percent of the sale price. */
    const val MIN_AD_RATE_PCT = 2.0
    const val MAX_AD_RATE_PCT = 20.0

    /** Markdown sale, in percent off. */
    const val MIN_MARKDOWN_PCT = 5.0
    const val MAX_MARKDOWN_PCT = 70.0

    fun clampAdRate(pct: Double): Double =
        if (!pct.isFinite()) MIN_AD_RATE_PCT else pct.coerceIn(MIN_AD_RATE_PCT, MAX_AD_RATE_PCT)

    fun clampMarkdown(pct: Double): Double = if (!pct.isFinite()) {
        MIN_MARKDOWN_PCT
    } else {
        pct.coerceIn(MIN_MARKDOWN_PCT, MAX_MARKDOWN_PCT)
    }

    /**
     * Parse a typed rate: "8", "8.5", "8,5", "8%".
     *
     * Null for blank or unparseable — the caller then falls back to the
     * suggestion rather than sending a number nobody chose. A value in range is
     * clamped rather than rejected, since the control is a slider.
     */
    fun parseAdRate(text: String): Double? = parsePercent(text)?.let { clampAdRate(it) }

    fun parseMarkdown(text: String): Double? = parsePercent(text)?.let { clampMarkdown(it) }

    private fun parsePercent(text: String): Double? = text
        .trim()
        .removeSuffix("%")
        .trim()
        .replace(',', '.')
        .toDoubleOrNull()
        ?.takeIf { it > 0.0 }

    /** "8" / "8.5" — eBay bids carry one decimal, and a whole number shouldn't show ".0". */
    fun formatPct(pct: Double): String {
        val value = if (pct.isFinite()) pct else 0.0
        return if (value == Math.floor(value)) {
            value.toInt().toString()
        } else {
            String.format(Locale.US, "%.1f", value)
        }
    }

    /**
     * What the panel says about the promotion.
     *
     * The tri-state override matters here: a listing that inherits an off-by-
     * default setting is NOT "promoted", and saying so would have the seller
     * believe they were paying for placement they never bought.
     */
    fun promotionSummary(state: PromotionState): UiMessage = when {
        state.optOut -> UiMessage(R.string.promotion_summary_opted_out)
        state.effectivePromote && state.ratePct != null -> UiMessage(
            R.string.promotion_summary_at_rate,
            // US-2976: the rate goes in as the FORMATTED string, not as a
            // Double. formatPct already decided that 8.0 prints as "8" and 7.5
            // as "7.5"; handing the raw number to the resource would let the
            // locale's own number format re-decide that, and eBay bids carry
            // one decimal in every language.
            args = listOf(formatPct(state.ratePct)),
        )

        state.effectivePromote -> UiMessage(R.string.promotion_summary_default_rate)
        state.promoteOverride == false -> UiMessage(R.string.promotion_summary_off_for_listing)
        state.promoteByDefault -> UiMessage(R.string.promotion_summary_not_yet)
        else -> UiMessage(R.string.promotion_summary_never)
    }

    /** What the panel says about a markdown sale. */
    fun saleSummary(state: PromotionState): UiMessage = when {
        state.saleActive && state.salePct != null -> UiMessage(
            R.string.promotion_sale_at_pct,
            args = listOf(formatPct(state.salePct)),
        )

        state.saleActive -> UiMessage(R.string.promotion_sale_on)
        else -> UiMessage(R.string.promotion_sale_none)
    }
}
