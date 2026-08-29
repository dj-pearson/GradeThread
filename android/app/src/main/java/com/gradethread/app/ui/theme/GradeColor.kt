package com.gradethread.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/**
 * US-3004: the colour a grade is drawn in, in ONE place and theme-aware.
 *
 * ⚠ THE BUG THIS FIXES. The 7.0-9.4 band was the literal `Color(0xFF0F3460)` -
 * brand navy, the LIGHT-mode primary - and the dark surface is
 * `BrandPalette.Night`, which is also navy. So on a dark-mode phone the grade
 * was navy on navy: the 8.5 at the top of a grade report, the number this whole
 * product exists to produce, rendered barely legible. The dark golden had been
 * showing it since it was recorded.
 *
 * 7.0-9.4 is not an edge case either. It is the ordinary band - most resale
 * garments land there - so this was the common rendering, not the rare one.
 *
 * `MaterialTheme.colorScheme.primary` resolves to the same navy in light and to
 * `BrandPalette.NavyDark` in dark, which is the blue the primary buttons already
 * use, so the grade now matches the rest of the theme rather than fighting it.
 *
 * ⚠ THE OTHER THREE STAY LITERAL, deliberately. Green, amber and red are
 * mid-tone hues that carry on both surfaces - checked on the dark golden, where
 * "Certificate verified" green and the amber band both read clearly - and they
 * are SEMANTIC rather than brand: a 9.5 is green because green means good, not
 * because green is ours. Mapping them onto scheme roles would tie a grade's
 * meaning to a palette decision. Navy was the odd one out precisely because it
 * IS the brand colour, and so collides with the brand surface.
 *
 * ⚠ AND IT WAS COPIED FIVE TIMES: GradeReportScreen, GradeRequestScreen,
 * GradesListScreen, InventoryListScreen and SnapScreen each had their own
 * private copy of this ladder, each with the same navy. Five copies of a
 * threshold table is five chances for a grade to be one colour on one screen
 * and another elsewhere. This is the only copy now.
 */
@Composable
@ReadOnlyComposable
fun gradeColor(value: Double): Color = when {
    value >= GRADE_EXCELLENT -> Color(0xFF10B981)
    value >= GRADE_GOOD -> MaterialTheme.colorScheme.primary
    value >= GRADE_FAIR -> Color(0xFFF59E0B)
    else -> Color(0xFFE94560)
}

private const val GRADE_EXCELLENT = 9.5
private const val GRADE_GOOD = 7.0
private const val GRADE_FAIR = 5.0
