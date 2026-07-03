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
