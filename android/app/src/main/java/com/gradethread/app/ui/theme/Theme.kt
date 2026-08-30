package com.gradethread.app.ui.theme

import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

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

/**
 * Whether the app is drawing its DARK palette (US-3010 AC10).
 *
 * ⚠ THIS IS NOT `isSystemInDarkTheme()`, and the difference is load-bearing.
 * GradeThreadTheme takes `darkTheme` as a parameter, and every screenshot test
 * in the sweep passes it explicitly while Robolectric's system setting stays
 * light. A colour that asked the system would come out light inside a golden
 * captured as dark, so anything picking a per-theme value reads THIS instead.
 */
val LocalIsDarkTheme = staticCompositionLocalOf { false }

/**
 * Whether the reader has Increase Contrast on (US-3010 AC10).
 *
 * ⚠ READ ONCE, NOT OBSERVED. `high_text_contrast_enabled` is not a public
 * constant and has no broadcast worth listening to, so this is sampled when the
 * theme first composes. Toggling the setting takes effect on the next
 * configuration change, which is what Android does anyway for a process that is
 * already running. It fails closed to `false` on any read error - a device that
 * refuses the query gets the ordinary palette, never a crash.
 */
val LocalHighContrast = staticCompositionLocalOf { false }

@Composable
fun GradeThreadTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val context = LocalContext.current
    val highContrast = remember(context) {
        runCatching {
            Settings.Secure.getInt(context.contentResolver, HIGH_TEXT_CONTRAST, 0) == 1
        }.getOrDefault(false)
    }

    CompositionLocalProvider(
        LocalIsDarkTheme provides darkTheme,
        LocalHighContrast provides highContrast,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = GradeThreadTypography,
            content = content,
        )
    }
}

/** `Settings.Secure.HIGH_TEXT_CONTRAST_ENABLED` is @hide; the key string is not. */
private const val HIGH_TEXT_CONTRAST = "high_text_contrast_enabled"
