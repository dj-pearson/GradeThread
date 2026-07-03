package com.gradethread.app.ui.a11y

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * US-1304: font-scale-aware icon sizing (iOS ScaledIconFont). A fixed
 * `Modifier.size(20.dp)` glyph ignores the user's font-size setting — at the
 * largest accessibility scale an icon button stays tiny while all text grows.
 * [scaledIconSize] tracks `fontScale`; pass [max] for glyphs inside
 * fixed-size frames (e.g. a 64dp capture slot) so growth can't overflow the
 * frame and break layout.
 *
 *   Icon(…, modifier = Modifier.size(scaledIconSize(20.dp)))            // grows freely
 *   Icon(…, modifier = Modifier.size(scaledIconSize(20.dp, max = 40.dp))) // clamped
 */
@Composable
fun scaledIconSize(base: Dp, max: Dp? = null): Dp {
    val fontScale = LocalDensity.current.fontScale
    return resolveScaledSize(base.value, fontScale, max?.value).dp
}

/** Pure clamp math (unit-tested): base × fontScale, capped at [max]. */
fun resolveScaledSize(base: Float, fontScale: Float, max: Float?): Float {
    val scaled = base * fontScale
    return if (max != null) minOf(scaled, max) else scaled
}
