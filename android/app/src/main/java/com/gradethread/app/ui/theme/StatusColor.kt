package com.gradethread.app.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/**
 * US-3010 AC10: emerald and amber now resolve per theme and per contrast
 * setting, the way navy and red already did through `primary` and `error`.
 *
 * ⚠ THE VALUES ARE PORTS, NOT CHOICES. All six come byte-for-byte from the iOS
 * asset catalogue, which has carried four variants each since it shipped.
 * Picking Android's own numbers would be the brand decision US-3010 AC6 is
 * still waiting on, and this deliberately does not make it - the LIGHT values
 * are unchanged, so nothing anyone is looking at today moves.
 *
 * ⚠ AND THAT MEANS THE CONTRAST PROBLEM IS STILL THERE in the default light
 * theme: emerald is 2.54:1 on white and amber 2.15:1, both worse than the red
 * US-3009 fixed. The high-contrast variants (#047857 at 4.83:1, #D97706 at
 * 3.16:1) only appear when the reader has Increase Contrast on. AC9 is the
 * story that decides whether the ordinary light values should move too; this
 * closes the gap where Android had no variants AT ALL, not that one.
 *
 * ⚠ ONLY THE GRADE LADDER CALLS THESE TODAY, and the rest is real work rather
 * than an oversight. Seventeen other sites paint a status emerald or amber -
 * InfoCard, StatusBadge, SyncStatusBar, the radar heat levels, the certificate
 * integrity tone - and eight of them use the RAW hex rather than the token, a
 * duplicate-of-a-token shape identical to the one US-3009 fixed for navy and
 * red. Every one of them keeps its light colour on a Night surface. They are
 * public for that reason: the next pass swaps a call site at a time, and a
 * private helper would have left nowhere to swap to.
 */
@Composable
@ReadOnlyComposable
fun statusEmerald(): Color = when {
    LocalIsDarkTheme.current && LocalHighContrast.current -> BrandPalette.EmeraldDarkHighContrast
    LocalIsDarkTheme.current -> BrandPalette.EmeraldDark
    LocalHighContrast.current -> BrandPalette.EmeraldHighContrast
    else -> BrandPalette.Emerald
}

@Composable
@ReadOnlyComposable
fun statusAmber(): Color = when {
    LocalIsDarkTheme.current && LocalHighContrast.current -> BrandPalette.AmberDarkHighContrast
    LocalIsDarkTheme.current -> BrandPalette.AmberDark
    LocalHighContrast.current -> BrandPalette.AmberHighContrast
    else -> BrandPalette.Amber
}
