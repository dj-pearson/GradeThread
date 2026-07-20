package com.gradethread.app.capture

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * US-1330: currency parsing for the purchase-price field (iOS
 * `CurrencyFormatter`), carrying the US-1184 clamp — a pasted negative must
 * never reach `acquired_price`, which would invert every downstream margin
 * and ROI calculation.
 *
 * All comparison math is in INTEGER CENTS: `"12"`, `"12.00"` and `"$12.00"`
 * are the same amount, and a merge must not report them as a conflict.
 * BigDecimal (never Double) so 0.1 + 0.2 problems can't reach money.
 */
object CurrencyAmount {

    /**
     * Parse loose user input to cents. Returns null when there is no number
     * at all (a blank field means "unset", NOT zero — the column is nullable
     * and 0.00 would read as "acquired for free").
     */
    fun parseCents(raw: String?): Long? {
        if (raw.isNullOrBlank()) return null
        // Strip currency symbols, thousands separators and whitespace, but
        // KEEP a leading '-' so an explicit negative is clamped below rather
        // than silently reinterpreted as a positive.
        val negative = raw.trim().startsWith("-")
        val digits = raw.filter { it.isDigit() || it == '.' }
        if (digits.isBlank() || digits == ".") return null
        val decimal = digits.toBigDecimalOrNull() ?: return null
        val cents = decimal
            .setScale(2, RoundingMode.HALF_UP)
            .multiply(BigDecimal(100))
            .toLong()
        // US-1184: clamp at zero rather than rejecting — the user sees the
        // field settle to 0.00 instead of losing what they typed.
        return if (negative) 0L else cents
    }

    /** Cents → `"12.00"`, the form's canonical editable text. */
    fun formatRaw(cents: Long?): String =
        cents?.let {
            BigDecimal(it).divide(BigDecimal(100)).setScale(2, RoundingMode.HALF_UP).toPlainString()
        }.orEmpty()

    /** Cents → `"$12.00"` for display. */
    fun formatDisplay(cents: Long?): String =
        cents?.let { "$SYMBOL${formatRaw(it)}" }.orEmpty()

    /**
     * The value sent to Postgres `acquired_price` (numeric): a plain decimal
     * string, or null for an unset field. Never `""` — that is not a number.
     */
    fun toWire(raw: String?): String? = parseCents(raw)?.let { formatRaw(it) }

    const val SYMBOL = "$"
}
