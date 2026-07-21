package com.gradethread.app.snap

import com.gradethread.app.capture.CurrencyAmount

/**
 * US-1335: how a snap result reads on the card.
 *
 * Pure, because "no value" has three distinct causes and telling them apart is
 * the difference between a useful nudge and a dead end: the seller gave no
 * hints (fixable — type a brand), the comps were too thin (not fixable by
 * them), or the grade came back without a value block at all.
 */
object SnapDisplay {

    /** Shown when there is no range to quote. */
    const val NO_VALUE = "—"

    fun dollars(cents: Int?): String =
        cents?.let { CurrencyAmount.SYMBOL + CurrencyAmount.formatRaw(it.toLong()) } ?: NO_VALUE

    /**
     * The headline range.
     *
     * Gated on `sufficient` AND a median: a comp set can report itself
     * sufficient while still missing the middle, and quoting a low–high with
     * no median is a wider claim than the data supports.
     */
    fun valueRange(value: SnapValue?): String {
        if (value == null || !value.sufficient || value.medianCents == null) return NO_VALUE
        return "${dollars(value.lowCents)}–${dollars(value.highCents)}"
    }

    /**
     * The line under the range — this is where the three no-value causes are
     * distinguished.
     *
     * @param hasHints whether the seller typed a brand or an item keyword. The
     *   edge only comps when it has one of those, so with neither, "not enough
     *   comps" would be a lie: we never looked.
     */
    fun valueSubtitle(value: SnapValue?, hasHints: Boolean): String = when {
        value != null && value.sufficient -> "est. resale value at this condition"
        !hasHints -> "add a brand or item to see value"
        else -> "not enough comps to value yet"
    }

    /** "Excellent · 87% confidence" — tier is lowercase on the wire. */
    fun gradeSubtitle(grade: SnapGrade): String {
        val tier = grade.gradeTier.replaceFirstChar { it.uppercase() }
        val percent = Math.round(grade.confidence.coerceIn(0.0, 1.0) * 100)
        return "$tier · $percent% confidence"
    }

    fun scoreText(grade: SnapGrade): String = String.format(java.util.Locale.US, "%.1f", grade.overallScore)
}
