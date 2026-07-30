package com.gradethread.app.ui.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1335: the Tools list, replacing the placeholder.
 *
 * It exists now because Snap-to-Value needed somewhere real to live — a
 * feature with no entry point is not shipped, whatever the code says. Later
 * tools append here.
 */
@Composable
fun ToolsScreen(
    onSnap: () -> Unit,
    onGrades: () -> Unit = {},
    onAnalytics: () -> Unit = {},
    onConsignors: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(vertical = Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        ToolRow(
            title = "What's it worth?",
            subtitle = "Snap one photo for an instant condition grade and resale range",
            onClick = onSnap,
        )
        ToolRow(
            title = "Certified grades",
            subtitle = "Every graded item, its report and its certificate",
            onClick = onGrades,
        )
        ToolRow(
            title = "Analytics",
            subtitle = "Grades, brands, sell-through, inventory value and listing performance",
            onClick = onAnalytics,
        )
        ToolRow(
            title = "Consignors",
            subtitle = "Who you sell for, their split, and what you owe them",
            onClick = onConsignors,
        )
    }
}

@Composable
private fun ToolRow(title: String, subtitle: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(Spacing.md)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    HorizontalDivider()
}
