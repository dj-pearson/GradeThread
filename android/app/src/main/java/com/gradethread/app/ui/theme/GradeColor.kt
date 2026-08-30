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
 * ⚠ US-3010 CORRECTS THE PARAGRAPH THAT USED TO SIT HERE. It said green, amber
 * and red "stay literal, deliberately", because they are mid-tone hues that
 * carry on both surfaces. The first half is now wrong and the second half is
 * still right, and the two need separating.
 *
 * STILL RIGHT: on the DARK surface all three do carry - emerald 6.72:1, amber
 * 7.94:1, red 4.46:1 against BrandPalette.Night. Navy was 1.36:1, which is why
 * navy was the one US-3004 had to fix and these were not.
 *
 * NOW WRONG: being correct was no reason to stay LITERAL. Emerald and Amber were
 * already named in BrandPalette twenty lines away, so two of the three literals
 * were duplicates of tokens that existed. They are byte-identical swaps.
 *
 * AND THE RED WAS NOT MERELY DUPLICATED, IT WAS THE WRONG VALUE. #E94560 is the
 * SURFACE red. This function returns a TEXT colour in five of its six call sites,
 * and constants.ts:1045 states the rule for the web in as many words: "for red
 * TEXT use the theme-inverting text-brand-red-text utility - never this hex as a
 * text color on a light surface." #E94560 is 3.83:1 on white; colorScheme.error
 * is #CC1F3D light (5.48:1) and #FB5E78 dark (5.66:1), so it clears AA on both.
 *
 * ⚠ THAT ALIGNS ANDROID WITH THE WEB AND NOT WITH THE SPEC, on purpose.
 * brand-design-system.md §3B names Crimson Red #F03D5F for this band, which iOS
 * uses exactly - and which is 3.79:1, the value US-439 deepened to #cc1f3d
 * precisely because the vibrant red fails AA as text. Following the spec here
 * would re-introduce the defect the spec's own consumer already fixed.
 *
 * The SEMANTIC argument survives untouched: a 9.5 is green because green means
 * good, not because green is ours. That is why emerald and amber map to palette
 * tokens rather than to scheme roles, while the red maps to `error` - the red
 * IS the brand colour, and `error` is the role that already carries it.
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
    value >= GRADE_EXCELLENT -> BrandPalette.Emerald
    value >= GRADE_GOOD -> MaterialTheme.colorScheme.primary
    value >= GRADE_FAIR -> BrandPalette.Amber
    else -> MaterialTheme.colorScheme.error
}

private const val GRADE_EXCELLENT = 9.5
private const val GRADE_GOOD = 7.0
private const val GRADE_FAIR = 5.0
