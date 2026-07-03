package com.gradethread.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.gradethread.app.R

/**
 * US-1302: brand typography mirroring the iOS `Font.brand*` scale
 * (Theme/Typography.swift): **Outfit** for display/headline surfaces, **Inter**
 * for body/UI/data. Sizes are sp so they scale with the system font size
 * (the Dynamic Type analog); the same OFL font files are bundled on both
 * platforms.
 */
val OutfitFamily = FontFamily(
    Font(R.font.outfit_regular, FontWeight.Normal),
    Font(R.font.outfit_semibold, FontWeight.SemiBold),
    Font(R.font.outfit_bold, FontWeight.Bold),
)

val InterFamily = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_bold, FontWeight.Bold),
)

/**
 * Material 3 type scale mapped onto the iOS brand tokens:
 *  displayLarge/titleLarge/titleMedium/headlineSmall ← Outfit
 *  (brandLargeTitle 34 / brandTitle 28 / brandTitle2 22 / brandHeadline 17)
 *  body/label ← Inter (brandBody 17 / brandCallout 16 / brandSubhead 15 /
 *  brandCaption 12).
 */
val GradeThreadTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = OutfitFamily, fontWeight = FontWeight.Bold, fontSize = 34.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = OutfitFamily, fontWeight = FontWeight.Bold, fontSize = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = OutfitFamily, fontWeight = FontWeight.SemiBold, fontSize = 22.sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = OutfitFamily, fontWeight = FontWeight.SemiBold, fontSize = 17.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 17.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 16.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 15.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 12.sp,
    ),
)

/** The grade-score number at an arbitrary size — iOS `Font.brandScore`. */
fun brandScore(sizeSp: Int): TextStyle = TextStyle(
    fontFamily = OutfitFamily,
    fontWeight = FontWeight.Bold,
    fontSize = sizeSp.sp,
)

/**
 * Tabular data rows where figures must align (prices, counts, measurement
 * grids) — iOS `Font.brandData`: Inter + tabular (monospaced) digits via the
 * `tnum` OpenType feature.
 */
fun brandData(sizeSp: Int = 15, weight: FontWeight = FontWeight.Normal): TextStyle = TextStyle(
    fontFamily = InterFamily,
    fontWeight = weight,
    fontSize = sizeSp.sp,
    fontFeatureSettings = "tnum",
)
