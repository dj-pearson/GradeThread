package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.BrandPalette
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import com.gradethread.app.ui.theme.statusAmber
import com.gradethread.app.ui.theme.statusEmerald

/**
 * US-1303: informational callout card (iOS InfoCard) — icon + title + body
 * with a tone. Use for inline guidance, warnings, and success confirmations
 * inside screens (not toasts).
 */
enum class InfoTone { Info, Success, Warning, Error }

@Composable
@ReadOnlyComposable
private fun InfoTone.color(): Color = when (this) {
    InfoTone.Info -> BrandPalette.Navy
    InfoTone.Success -> statusEmerald()
    InfoTone.Warning -> statusAmber()
    InfoTone.Error -> BrandPalette.Red
}

private fun InfoTone.icon(): ImageVector = when (this) {
    InfoTone.Info -> Icons.Outlined.Info
    InfoTone.Success -> Icons.Outlined.CheckCircle
    InfoTone.Warning, InfoTone.Error -> Icons.Outlined.Warning
}

@Composable
fun InfoCard(title: String, body: String, modifier: Modifier = Modifier, tone: InfoTone = InfoTone.Info) {
    val color = tone.color()
    Row(
        modifier = modifier
            .fillMaxWidth()
            .cardStyle()
            .semantics(mergeDescendants = true) {},
    ) {
        Icon(
            imageVector = tone.icon(),
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(22.dp),
        )
        Column(Modifier.padding(start = Spacing.sm)) {
            Text(title, style = MaterialTheme.typography.headlineSmall, color = color)
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xxs),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun InfoCardPreview() {
    GradeThreadTheme {
        Column(Modifier.padding(Spacing.md)) {
            InfoCard("Heads up", "Listing photos sync when you're back online.")
            InfoCard(
                "Offer sent",
                "Interested buyers were notified.",
                tone = InfoTone.Success,
                modifier = Modifier.padding(top = Spacing.sm),
            )
        }
    }
}
