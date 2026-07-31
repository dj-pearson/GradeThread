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
    onTemplates: () -> Unit = {},
    onScout: () -> Unit = {},
    onProspect: () -> Unit = {},
    onVerified: () -> Unit = {},
    onShipping: () -> Unit = {},
    onReferrals: () -> Unit = {},
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
        ToolRow(
            title = "Listing templates",
            subtitle = "Save the condition, specifics and boilerplate you reuse",
            onClick = onTemplates,
        )
        ToolRow(
            title = "Scout",
            subtitle = "Find underpriced listings on eBay, graded and ranked by profit",
            onClick = onScout,
        )
        ToolRow(
            title = "Prospect",
            subtitle = "In a shop? Photograph it and find out if it's worth buying",
            onClick = onProspect,
        )
        ToolRow(
            title = "Verified seller",
            subtitle = "Your badge status and what's left to set up",
            onClick = onVerified,
        )
        ToolRow(
            title = "Shipping",
            subtitle = "What's sold and still needs posting, with tracking",
            onClick = onShipping,
        )
        ToolRow(
            title = "Invite a friend",
            subtitle = "Share your code and earn grading credits",
            onClick = onReferrals,
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
