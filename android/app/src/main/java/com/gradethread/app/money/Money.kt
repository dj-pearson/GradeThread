package com.gradethread.app.money

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/**
 * US-790 (iOS `Money`, GradeThreadCore/MoneyMath.swift): drift-free money
 * aggregation.
 *
 * Currency amounts are stored and sent over the wire as `Double` (the Room
 * column and JSON shape). A `Double` like `24.99` is really `24.9899999…`, so
 * summing many of them lets the binary-float error compound past a cent on large
 * sets — the reseller reports, financial exports, dashboard totals. Single
 * values and one-off subtractions are fine; the problem is ACCUMULATION.
 *
 * [sum] converts each amount to an exact 2-decimal `BigDecimal` (every currency
 * value is ≤2 dp, so rounding to cents recovers the intended value exactly),
 * sums in `BigDecimal`, and hands back a cents-rounded `Double`. Callers keep
 * their `Double` types — they just swap `sumOf { … }` for `Money.sum(…)`.
 *
 * HALF_UP matches iOS's `NSDecimalRound(.plain)`, so the two platforms round the
 * same borderline half-cent the same way. Getting this wrong would show a
 * seller a total that differs by a cent between their phone and their iPad.
 *
 * [CurrencyAmount] is the sibling for PARSING user input; this is for summing
 * and formatting stored amounts.
 */
object Money {

    /**
     * Exact 2-dp `BigDecimal` for a `Double` dollar amount.
     *
     * `BigDecimal.valueOf` goes through `Double.toString`, so it starts from the
     * shortest decimal that round-trips (`24.99`, not the full binary
     * expansion) — the same value iOS recovers by rounding `Decimal(double)` to
     * two places.
     */
    fun decimal(dollars: Double): BigDecimal {
        // A non-finite amount would poison every sum and export it flows into.
        // All callers sum finite stored prices, so this is a latent guard — but
        // a cheap one (iOS US-1412 carries the same).
        if (dollars.isNaN() || dollars.isInfinite()) return BigDecimal.ZERO
        return BigDecimal.valueOf(dollars).setScale(2, RoundingMode.HALF_UP)
    }

    /**
     * Cents-normalized `Double`: the exact 2-dp value re-entered as a `Double`,
     * rounded the SAME way the drift-free sums round each amount. Use at
     * boundaries that must agree with those sums to the cent — a single profit
     * figure shown next to a rolled-up total. Single values don't need [sum],
     * but they DO need to round identically to it.
     */
    fun cents(dollars: Double): Double = decimal(dollars).toDouble()

    /** Drift-free sum, returned cents-rounded so callers stay `Double`-typed. */
    fun sum(amounts: Iterable<Double>): Double =
        amounts.fold(BigDecimal.ZERO) { acc, amount -> acc.add(decimal(amount)) }
            .setScale(2, RoundingMode.HALF_UP)
            .toDouble()

    /** Drift-free sum of a money field projected from each element. */
    fun <T> sum(items: Iterable<T>, amount: (T) -> Double): Double =
        sum(items.map(amount))

    /**
     * Locale-aware currency display (US-1363 AC2).
     *
     * The AMOUNT is USD — every price in the product is — but the FORMAT follows
     * the device locale, so a seller in Berlin sees `1.234,56 $` and one in
     * Chicago sees `$1,234.56`. Hardcoding `"$%.2f"` would be wrong for both the
     * separator and the symbol position in most of the world.
     */
    fun format(dollars: Double, locale: Locale = Locale.getDefault()): String =
        runCatching {
            NumberFormat.getCurrencyInstance(locale).apply {
                currency = Currency.getInstance("USD")
            }.format(decimal(dollars))
        }.getOrElse { "$" + decimal(dollars).toPlainString() }

    /**
     * Compact display for chart axes and dense KPI tiles: `$1.2k`, `$45`.
     * Always US-shaped — it is a chart label, not an amount to reconcile
     * against, and a localized compact form would need CLDR data we don't ship.
     */
    fun formatCompact(dollars: Double): String {
        val abs = kotlin.math.abs(dollars)
        val sign = if (dollars < 0) "-" else ""
        return when {
            abs >= 1_000_000 -> String.format(Locale.US, "%s$%.1fM", sign, abs / 1_000_000)
            abs >= 1_000 -> String.format(Locale.US, "%s$%.1fk", sign, abs / 1_000)
            else -> String.format(Locale.US, "%s$%.0f", sign, abs)
        }
    }

    /**
     * A ratio as a percentage string, or `"—"` when it is absent.
     *
     * ROI is deliberately nullable throughout the rollups: a zero cost basis
     * can't be divided by, and showing `0%` there would read as "this made no
     * money" when the truth is "we don't know what it cost".
     */
    fun formatPercent(ratio: Double?): String =
        ratio?.let { String.format(Locale.US, "%.0f%%", it * 100) } ?: "—"
}
