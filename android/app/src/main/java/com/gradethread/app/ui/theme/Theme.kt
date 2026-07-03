package com.gradethread.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

// US-1300: minimal brand seed — Navy primary / Red accent, matching the web
// tokens (CLAUDE.md Brand). The full Material 3 token pass (typography scale,
// tonal palettes, dark variants, Inter) is US-1302; this exists so the shell
// isn't default-purple in the meantime.
private val BrandNavy = Color(0xFF0F3460)
private val BrandRed = Color(0xFFE94560)
private val BrandNight = Color(0xFF1A1A2E)

private val LightColors = lightColorScheme(
    primary = BrandNavy,
    secondary = BrandRed,
    tertiary = BrandNight,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF9DB8E0),
    secondary = BrandRed,
    background = BrandNight,
    surface = BrandNight,
)

@Composable
fun GradeThreadTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    // Brand colors beat wallpaper-derived dynamic color by default; US-1302
    // revisits whether to offer dynamic as a setting.
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
