package com.gradethread.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * US-1302: the GradeThread brand palette (CLAUDE.md Brand + the iOS
 * Assets.xcassets variants). Light mode uses the web-canonical values; dark
 * mode follows the iOS strategy — a lighter, higher-contrast blue/red so
 * brand elements stay legible on Night surfaces.
 */
object BrandPalette {
    // Web-canonical seeds (light).
    val Navy = Color(0xFF0F3460)
    val Red = Color(0xFFE94560)

    /**
     * US-3009: brand red that is legible AS TEXT.
     *
     * `Red` (#E94560) is the SURFACE red and measures 3.83:1 against white -
     * below WCAG AA for text. The web established this under US-2334 and ships
     * `--brand-red-text: #cc1f3d` (5.56:1) for red copy, keeping #E94560 for
     * fills. This is the same value, so a status chip reads the same on both
     * clients and passes the same audit.
     *
     * Dark mode already had it right: `RedDark` (#FB5E78) is byte-identical to
     * the web's dark `--brand-red-text`. Only the light side was wrong.
     */
    val RedText = Color(0xFFCC1F3D)
    val Night = Color(0xFF1A1A2E)
    val SoftGray = Color(0xFFF5F5F5)

    // Dark-mode brand variants (from the iOS BrandNavy/BrandRed dark assets).
    val NavyDark = Color(0xFF3B82F6)
    val RedDark = Color(0xFFFB5E78)

    // Status tones (from the iOS asset catalog; mirror the web status system).
    //
    // US-3010 AC10: four variants each, ported byte-for-byte from
    // ios/GradeThread/Assets.xcassets/Brand{Emerald,Amber}.colorset. iOS has
    // carried light / light-high-contrast / dark / dark-high-contrast since it
    // shipped; Android had ONE fixed value, so a grade badge kept its light
    // colour on a Night surface and ignored Increase Contrast entirely. These
    // are ports, not new choices - picking Android's own values would be the
    // brand decision AC6 is still waiting on.
    val Emerald = Color(0xFF10B981)
    val EmeraldDark = Color(0xFF34D399)
    val EmeraldHighContrast = Color(0xFF047857)
    val EmeraldDarkHighContrast = Color(0xFF5AE3B0)

    val Amber = Color(0xFFF59E0B)
    val AmberDark = Color(0xFFFFB83C)
    val AmberHighContrast = Color(0xFFD97706)
    val AmberDarkHighContrast = Color(0xFFFFCA5A)

    // Supporting neutrals.
    val NightSurface = Color(0xFF23233B) // one step above Night for cards
    val OutlineLight = Color(0xFFD6D9E0)
    val OutlineDark = Color(0xFF3A3A55)
}
