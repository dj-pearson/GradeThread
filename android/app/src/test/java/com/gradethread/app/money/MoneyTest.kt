package com.gradethread.app.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * US-790 (iOS `Money`): the drift-free primitives every rollup sums through.
 */
class MoneyTest {

    @Test
    fun accumulationDoesNotDrift() {
        // The whole reason this class exists. `0.1 + 0.2 != 0.3` in binary
        // float, and the error compounds across a large set — the sets here are
        // financial exports a seller reconciles against a payout statement.
        val amounts = List(1000) { 0.01 }
        assertEquals(10.00, Money.sum(amounts), 0.0)

        assertEquals(0.30, Money.sum(listOf(0.1, 0.2)), 0.0)
        assertEquals(2499.00, Money.sum(List(100) { 24.99 }), 0.0)
    }

    @Test
    fun aSingleValueRoundsTheSameWayASumDoes() {
        // Otherwise a lone profit figure disagrees by a cent with the total
        // printed beside it.
        assertEquals(Money.sum(listOf(24.995)), Money.cents(24.995), 0.0)
    }

    @Test
    fun halfCentsRoundUp() {
        // HALF_UP, matching iOS's NSDecimalRound(.plain): a different tie rule
        // would show the same order as a cent apart on phone and tablet.
        //
        // 0.125 is exactly representable in binary, so both platforms see a true
        // tie and both round up. Values with MORE than two decimals that are not
        // exactly representable (1.005 is really 1.00499999…) can differ,
        // because `BigDecimal.valueOf` starts from the shortest round-tripping
        // decimal while iOS's `Decimal(Double)` keeps the full expansion. That
        // gap is unreachable in practice — every stored money column is ≤2 dp —
        // so it is documented rather than asserted either way.
        assertEquals(0.13, Money.cents(0.125), 0.0)
        // Stored, ≤2 dp amounts round identically on both platforms.
        assertEquals(24.99, Money.cents(24.99), 0.0)
    }

    @Test
    fun nonFiniteAmountsCannotPoisonASum() {
        assertEquals(5.00, Money.sum(listOf(5.0, Double.NaN, Double.POSITIVE_INFINITY)), 0.0)
    }

    @Test
    fun negativeAmountsSumAsLosses() {
        // A loss-making month must read negative, not clamp to zero.
        assertEquals(-15.50, Money.sum(listOf(10.0, -25.5)), 0.0)
    }

    @Test
    fun projectedSumsReadAFieldPerElement() {
        val amounts = listOf(1.11 to "a", 2.22 to "b")
        assertEquals(3.33, Money.sum(amounts) { it.first }, 0.0)
    }

    @Test
    fun currencyFormattingFollowsTheLocaleButKeepsUsdAmounts() {
        // Every price in the product is USD; only the FORMAT is localized.
        // Hardcoding "$%.2f" gets the separator and symbol position wrong in
        // most of the world.
        assertTrue(Money.format(1234.5, Locale.US).contains("1,234.50"))
        val german = Money.format(1234.5, Locale.GERMANY)
        assertTrue(german, german.contains("1.234,50"))
    }

    @Test
    fun compactFormattingIsForAxesNotReconciliation() {
        assertEquals("$0", Money.formatCompact(0.0))
        assertEquals("$450", Money.formatCompact(450.0))
        assertEquals("$1.2k", Money.formatCompact(1234.0))
        assertEquals("$1.5M", Money.formatCompact(1_500_000.0))
        assertEquals("-$2.0k", Money.formatCompact(-2000.0))
    }

    @Test
    fun anAbsentRatioRendersAsADashNotZeroPercent() {
        // "0%" reads as "made nothing"; the truth is "cost unknown".
        assertEquals("—", Money.formatPercent(null))
        assertEquals("35%", Money.formatPercent(0.35))
        assertEquals("-100%", Money.formatPercent(-1.0))
    }
}
