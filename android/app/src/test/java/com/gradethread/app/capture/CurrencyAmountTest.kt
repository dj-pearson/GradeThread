package com.gradethread.app.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * US-1330 / US-1184: money never goes through Double, a blank field is UNSET
 * rather than zero, and a pasted negative is clamped before it can invert
 * every downstream margin.
 */
class CurrencyAmountTest {

    @Test
    fun blankIsUnset_notZero() {
        // acquired_price is nullable; 0.00 would read as "acquired for free".
        assertNull(CurrencyAmount.parseCents(null))
        assertNull(CurrencyAmount.parseCents(""))
        assertNull(CurrencyAmount.parseCents("   "))
        assertNull(CurrencyAmount.parseCents("abc"))
        assertNull(CurrencyAmount.parseCents("."))
        assertNull(CurrencyAmount.toWire(""))
    }

    @Test
    fun parsesPlainAndDecoratedInput() {
        assertEquals(1200L, CurrencyAmount.parseCents("12"))
        assertEquals(1200L, CurrencyAmount.parseCents("12.00"))
        assertEquals(1250L, CurrencyAmount.parseCents("12.50"))
        assertEquals(1250L, CurrencyAmount.parseCents("$12.50"))
        assertEquals(1250L, CurrencyAmount.parseCents(" 12.50 "))
        assertEquals(5L, CurrencyAmount.parseCents("0.05"))
    }

    @Test
    fun roundsHalfUpToCents() {
        assertEquals(1235L, CurrencyAmount.parseCents("12.345"))
        assertEquals(1L, CurrencyAmount.parseCents("0.005"))
    }

    @Test
    fun negativesAreClampedToZero() {
        // US-1184: a pasted negative must never reach acquired_price.
        assertEquals(0L, CurrencyAmount.parseCents("-5"))
        assertEquals(0L, CurrencyAmount.parseCents("-12.50"))
        assertEquals("0.00", CurrencyAmount.toWire("-12.50"))
    }

    @Test
    fun formatsBackToEditableAndDisplayText() {
        assertEquals("12.00", CurrencyAmount.formatRaw(1200L))
        assertEquals("12.50", CurrencyAmount.formatRaw(1250L))
        assertEquals("0.05", CurrencyAmount.formatRaw(5L))
        assertEquals("", CurrencyAmount.formatRaw(null))
        assertEquals("$12.50", CurrencyAmount.formatDisplay(1250L))
        assertEquals("", CurrencyAmount.formatDisplay(null))
    }

    @Test
    fun wireValueIsAPlainDecimal_neverEmptyString() {
        assertEquals("12.00", CurrencyAmount.toWire("12"))
        assertEquals("12.00", CurrencyAmount.toWire("$12.00"))
        // Postgres numeric rejects ""; unset must be a real null.
        assertNull(CurrencyAmount.toWire("   "))
    }

    @Test
    fun equivalentSpellingsNormalizeIdentically() {
        // The merge sheet must not report "12" vs "12.00" as a conflict.
        assertEquals(CurrencyAmount.parseCents("12"), CurrencyAmount.parseCents("12.00"))
        assertEquals(CurrencyAmount.parseCents("$12"), CurrencyAmount.parseCents("12.000"))
    }
}
