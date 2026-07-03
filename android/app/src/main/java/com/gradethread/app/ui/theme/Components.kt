package com.gradethread.app.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip

/**
 * US-1302: the reusable chrome layer mirroring iOS DesignTokens (US-652) —
 * declared once so cards/buttons don't get hand-rolled with drifting radii.
 *
 *   Column(Modifier.cardStyle()) { … }          // standard card
 *   Column(Modifier.cardStyle(flush = true)) { … } // edge-to-edge content
 *   BrandPrimaryButton(text = "Save") { … }
 *   BrandSecondaryButton(text = "Cancel") { … }
 *   BrandDestructiveButton(text = "Delete") { … }
 */

/**
 * The canonical card chrome: surface-variant fill clipped to the card radius,
 * with the standard 16dp inset unless [flush] (rows/lists hosting their own
 * padding).
 */
@Composable
fun Modifier.cardStyle(flush: Boolean = false): Modifier {
    val base = this
        .clip(RoundedCornerShape(CornerRadius.card))
        .background(MaterialTheme.colorScheme.surfaceVariant)
    return if (flush) base else base.padding(Spacing.md)
}

private val ButtonPadding = PaddingValues(
    horizontal = Spacing.md,
    vertical = Spacing.sm,
)

/** Filled brand-primary CTA (navy in light, bright blue in dark). 48dp floor. */
@Composable
fun BrandPrimaryButton(
    text: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.defaultMinSize(minHeight = MinTouchTarget),
        shape = RoundedCornerShape(CornerRadius.control),
        contentPadding = ButtonPadding,
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
        Text(text, style = MaterialTheme.typography.headlineSmall)
    }
}

/** Outlined neutral secondary action. 48dp floor. */
@Composable
fun BrandSecondaryButton(
    text: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.defaultMinSize(minHeight = MinTouchTarget),
        shape = RoundedCornerShape(CornerRadius.control),
        contentPadding = ButtonPadding,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

/** Filled destructive action (brand red). 48dp floor. */
@Composable
fun BrandDestructiveButton(
    text: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.defaultMinSize(minHeight = MinTouchTarget),
        shape = RoundedCornerShape(CornerRadius.control),
        contentPadding = ButtonPadding,
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.error,
            contentColor = MaterialTheme.colorScheme.onError,
        ),
    ) {
        Text(text, style = MaterialTheme.typography.headlineSmall)
    }
}
