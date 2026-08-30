package com.gradethread.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * US-1302: the full Material 3 brand theme. Light mode = web-canonical brand
 * (Navy primary on Soft Gray); dark mode = the iOS strategy (Night surfaces
 * with the brighter blue/red brand variants for contrast). Dynamic
 * (wallpaper-derived) color is deliberately OFF — the grade certificate and
 * marketing surfaces depend on brand recognition.
 */
private val LightColors = lightColorScheme(
    primary = BrandPalette.Navy,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD5E3F8),
    onPrimaryContainer = BrandPalette.Navy,
    secondary = BrandPalette.Red,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFD9DF),
    onSecondaryContainer = Color(0xFF8E1F35),
    tertiary = BrandPalette.Night,
    onTertiary = Color.White,
    // US-3009: the TEXT-safe red, not the surface red. Material 3 uses `error`
    // as a foreground role - 89 of this app's 107 uses pass it as `color =` -
    // and #E94560 is 3.83:1, below AA. Surfaces take `errorContainer`, which is
    // unchanged. Dark mode already used the correct value.
    error = BrandPalette.RedText,
    onError = Color.White,
    background = BrandPalette.SoftGray,
    onBackground = BrandPalette.Night,
    surface = Color.White,
    onSurface = BrandPalette.Night,
    surfaceVariant = Color(0xFFEDEFF4),
    onSurfaceVariant = Color(0xFF44475A),
    outline = BrandPalette.OutlineLight,
)

private val DarkColors = darkColorScheme(
    primary = BrandPalette.NavyDark,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF1E3A5F),
    onPrimaryContainer = Color(0xFFD5E3F8),
    secondary = BrandPalette.RedDark,
    onSecondary = Color(0xFF40000E),
    secondaryContainer = Color(0xFF7A2038),
    onSecondaryContainer = Color(0xFFFFD9DF),
    tertiary = BrandPalette.SoftGray,
    onTertiary = BrandPalette.Night,
    error = BrandPalette.RedDark,
    onError = Color(0xFF40000E),
    background = BrandPalette.Night,
    onBackground = BrandPalette.SoftGray,
    surface = BrandPalette.Night,
    onSurface = BrandPalette.SoftGray,
    surfaceVariant = BrandPalette.NightSurface,
    onSurfaceVariant = Color(0xFFB9BCD0),
    outline = BrandPalette.OutlineDark,
)

@Composable
fun GradeThreadTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = GradeThreadTypography,
        content = content,
    )
}
