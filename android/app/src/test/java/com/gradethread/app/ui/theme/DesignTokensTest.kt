package com.gradethread.app.ui.theme

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * US-1302: token drift guard — the brand hex values and the 4pt spacing /
 * radius classes are contractual (CLAUDE.md Brand + the iOS DesignTokens).
 * A "quick tweak" to any of these must be a deliberate, reviewed change.
 */
class DesignTokensTest {

    @Test
    fun brandPalette_matchesTheCanonicalHexValues() {
        assertEquals(0xFF0F3460.toInt(), BrandPalette.Navy.value.shr(32).toInt())
        assertEquals(0xFFE94560.toInt(), BrandPalette.Red.value.shr(32).toInt())
        assertEquals(0xFF1A1A2E.toInt(), BrandPalette.Night.value.shr(32).toInt())
        assertEquals(0xFFF5F5F5.toInt(), BrandPalette.SoftGray.value.shr(32).toInt())
    }

    @Test
    fun spacing_isTheFourPointScale() {
        assertEquals(4.dp, Spacing.xxs)
        assertEquals(8.dp, Spacing.xs)
        assertEquals(12.dp, Spacing.sm)
        assertEquals(16.dp, Spacing.md)
        assertEquals(20.dp, Spacing.lg)
        assertEquals(24.dp, Spacing.xl)
        assertEquals(32.dp, Spacing.xxl)
    }

    @Test
    fun cornerRadii_matchTheUnifiedClasses() {
        assertEquals(16.dp, CornerRadius.card)
        assertEquals(12.dp, CornerRadius.control)
        assertEquals(9.dp, CornerRadius.chip)
        assertEquals(999.dp, CornerRadius.pill)
    }

    @Test
    fun touchTarget_meetsTheAndroidFloor() {
        assertEquals(48.dp, MinTouchTarget)
    }
}
