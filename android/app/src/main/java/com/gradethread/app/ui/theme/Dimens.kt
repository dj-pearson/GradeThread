package com.gradethread.app.ui.theme

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * US-1302: spacing + radius tokens mirroring the iOS `Spacing`/`CornerRadius`
 * enums (Theme/DesignTokens.swift). Use the named steps — never raw dp — so
 * padding/stacks/radii stay consistent across screens.
 */
object Spacing {
    val xxs: Dp = 4.dp
    val xs: Dp = 8.dp
    val sm: Dp = 12.dp

    /** 16 — the default card / screen inset. */
    val md: Dp = 16.dp
    val lg: Dp = 20.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 32.dp
}

/**
 * Unified corner radii: cards 16, inline controls/thumbnails 12, chips/badges
 * 9, pills fully rounded — the same classes the iOS pass unified.
 */
object CornerRadius {
    val card: Dp = 16.dp
    val control: Dp = 12.dp
    val chip: Dp = 9.dp
    val pill: Dp = 999.dp
}

/**
 * Android's touch-target floor is 48dp (Material a11y guidance; the iOS
 * counterpart is 44pt). Every tappable brand control enforces this.
 */
val MinTouchTarget: Dp = 48.dp

/**
 * US-2905 AC4: how wide a single-column screen is allowed to get.
 *
 * Past every phone, so below this NOTHING changes and every phone golden stays
 * byte-identical — which is what makes it safe to apply without a size-class
 * branch. On an Expanded-width tablet it stops a row coming apart: the
 * inventory row had its title at the far left and its grade badge alone at the
 * far right, about 1900px away, and no eye associates those.
 *
 * 840dp is Material's large-pane width. It is NOT a prose measure — 65-75ch is
 * tighter and belongs on text-heavy screens rather than on a scannable list.
 *
 * ⚠ APPLY IT BEFORE `fillMaxSize()`, never after. fillMaxSize sets the MINIMUM
 * width as well as the maximum, so a later `widthIn(max = ...)` cannot shrink
 * anything and the whole thing is a silent no-op.
 */
val ContentMaxWidth: Dp = 840.dp
