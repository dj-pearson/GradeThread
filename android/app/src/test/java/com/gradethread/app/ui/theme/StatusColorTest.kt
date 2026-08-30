package com.gradethread.app.ui.theme

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-3010 AC10: the grade ladder resolves emerald and amber per theme and per
 * contrast setting.
 *
 * ⚠ WHAT WENT WRONG WITHOUT THIS. Android held ONE emerald and ONE amber, so a
 * 9.5 kept its light #10B981 on a Night surface and Increase Contrast changed
 * nothing at all. Navy had already been through this once - US-3004 found the
 * 7.0-9.4 band drawn in brand navy on a navy dark surface, which is the number
 * this product exists to produce rendered barely legible.
 *
 * ⚠ THE VALUES ARE ASSERTED AS HEX ON PURPOSE, the way DesignTokensTest does.
 * All six are ports from the iOS asset catalogue, and a port that drifts from
 * its source is worse than no port: the two clients would disagree while both
 * looked deliberate. If one of these has to change, iOS changes with it.
 *
 * ⚠ THE HIGH-CONTRAST FLAG IS PROVIDED DIRECTLY, not read from Settings. This
 * covers the LADDER, which is where the four-way choice lives. It does not
 * cover GradeThreadTheme's one-time read of `high_text_contrast_enabled` - that
 * needs a device with the setting on, and is named here so nobody reads a green
 * run as proof the sampling works.
 */
@RunWith(RobolectricTestRunner::class)
class StatusColorTest {

    @get:Rule
    val compose = createComposeRule()

    /**
     * ⚠ EVERY COMBINATION IS RESOLVED IN ONE COMPOSITION. ComposeContentTestRule
     * refuses a second setContent in the same test ("Cannot call setContent
     * twice per test!"), which the first draft of this file hit on all six
     * cases. Nesting the themes inside one call is not a workaround for the
     * rule - it is the honest shape, because it also proves the four variants
     * coexist rather than depending on which one composed first.
     */
    private data class Probe(val emerald: Color, val amber: Color, val gradeExcellent: Color, val gradeFair: Color)

    private fun probe(): Map<Pair<Boolean, Boolean>, Probe> {
        val out = mutableMapOf<Pair<Boolean, Boolean>, Probe>()
        compose.setContent {
            for (dark in listOf(false, true)) {
                for (highContrast in listOf(false, true)) {
                    GradeThreadTheme(darkTheme = dark) {
                        CompositionLocalProvider(LocalHighContrast provides highContrast) {
                            out[dark to highContrast] = Probe(
                                emerald = statusEmerald(),
                                amber = statusAmber(),
                                gradeExcellent = gradeColor(GRADE_EXCELLENT),
                                gradeFair = gradeColor(GRADE_FAIR),
                            )
                        }
                    }
                }
            }
        }
        return out
    }

    @Test
    fun `light theme keeps the iOS base values`() {
        val p = probe().getValue(false to false)
        assertEquals(Color(0xFF10B981), p.emerald)
        assertEquals(Color(0xFFF59E0B), p.amber)
    }

    @Test
    fun `dark theme brightens both, so neither stays a light colour on Night`() {
        val p = probe().getValue(true to false)
        assertEquals(Color(0xFF34D399), p.emerald)
        assertEquals(Color(0xFFFFB83C), p.amber)
    }

    @Test
    fun `increase contrast deepens both on a light surface`() {
        val p = probe().getValue(false to true)
        assertEquals(Color(0xFF047857), p.emerald)
        assertEquals(Color(0xFFD97706), p.amber)
    }

    @Test
    fun `increase contrast in dark brightens further, it does not deepen`() {
        val p = probe().getValue(true to true)
        assertEquals(Color(0xFF5AE3B0), p.emerald)
        assertEquals(Color(0xFFFFCA5A), p.amber)
    }

    /**
     * The four combinations are four DIFFERENT colours. A resolver that read
     * one flag and ignored the other would still pass every case above if the
     * fixture happened to agree, so the distinctness is asserted on its own.
     */
    @Test
    fun `all four variants differ`() {
        val all = probe()
        assertEquals("two emerald variants collapsed into one", 4, all.values.map { it.emerald }.toSet().size)
        assertEquals("two amber variants collapsed into one", 4, all.values.map { it.amber }.toSet().size)
    }

    /**
     * The grade ladder goes through the resolvers rather than the raw tokens,
     * which is the thing that actually changed. A 9.5 on a dark phone must not
     * come back as the light emerald.
     */
    @Test
    fun `gradeColor follows the theme for both status bands`() {
        val all = probe()
        assertEquals(Color(0xFF34D399), all.getValue(true to false).gradeExcellent)
        assertEquals(Color(0xFFFFB83C), all.getValue(true to false).gradeFair)
        assertEquals(Color(0xFF10B981), all.getValue(false to false).gradeExcellent)
        assertEquals(Color(0xFFF59E0B), all.getValue(false to false).gradeFair)
    }

    private companion object {
        /** Inside the top band, and inside the amber band. */
        const val GRADE_EXCELLENT = 9.6
        const val GRADE_FAIR = 5.5
    }
}
