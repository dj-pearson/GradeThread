package com.gradethread.app.grading

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.Spacing
import java.util.Locale

/**
 * US-1341: every certified grade in one place (iOS `GradesListView`).
 */
@Composable
fun GradesListScreen(
    onOpenReport: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: GradesListViewModel = hiltViewModel(),
) {
    val items by viewModel.items.collectAsStateWithLifecycle()
    val sort by viewModel.sort.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val refreshError by viewModel.refreshError.collectAsStateWithLifecycle()

    val summary = remember(items) { GradesList.summarize(items) }
    val sorted = remember(items, sort) { GradesList.sorted(items, sort) }

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Certified grades",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = viewModel::refresh, enabled = !refreshing) {
                Text(if (refreshing) "Refreshing…" else "Refresh")
            }
        }

        Text(
            summary.label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Spacing.md),
        )

        refreshError?.let { message ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::dismissRefreshError) { Text("Dismiss") }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xxs),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            GradesList.Sort.entries.forEach { option ->
                FilterChip(
                    selected = option == sort,
                    onClick = { viewModel.setSort(option) },
                    label = { Text(option.label) },
                )
            }
        }

        HorizontalDivider()

        if (sorted.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(Spacing.xl),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("No grades yet", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Grade an item from your inventory and it'll appear here with its " +
                        "certificate.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(sorted, key = { it.id }) { item ->
                    GradeRow(item) { onOpenReport(item.id) }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun GradeRow(item: InventoryItemEntity, onClick: () -> Unit) {
    val score = item.gradeValue ?: return
    val pending = GradesList.isPendingReview(item)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            String.format(Locale.US, "%.1f", score),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = gradeColor(score),
            modifier = Modifier
                .padding(end = Spacing.sm)
                .semantics {
                    contentDescription = "Grade ${String.format(Locale.US, "%.1f", score)}" +
                        (item.gradeLabel?.let { ", $it" } ?: "") +
                        if (pending) ", pending review" else ""
                },
        )
        Column(Modifier.weight(1f)) {
            Text(item.title, style = MaterialTheme.typography.bodyMedium)
            Text(
                listOfNotNull(item.brand, item.gradeLabel)
                    .filter { it.isNotBlank() }
                    .joinToString(" · ")
                    .ifEmpty { "—" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (pending) {
            Badge("Pending review", Color(0xFFF59E0B))
        }
        // US-819: dispute state rides the row, so the seller sees it without
        // opening each report.
        DisputeStatusDisplay.label(item.disputeStatus)?.let { label ->
            Badge(label, disputeTone(item.disputeStatus))
        }
    }
}

@Composable
private fun Badge(text: String, tone: Color) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = tone,
        modifier = Modifier
            .padding(start = Spacing.xxs)
            .background(tone.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = Spacing.xs, vertical = 2.dp),
    )
}

private fun disputeTone(status: String?): Color = when (status) {
    "open", "under_review" -> Color(0xFFF59E0B)
    "resolved" -> Color(0xFF10B981)
    else -> Color(0xFF6B7280)
}

/** The four GradeScale tiers (same mapping as the inventory row's chip). */
private fun gradeColor(value: Double): Color = when {
    value >= 9.5 -> Color(0xFF10B981)
    value >= 7.0 -> Color(0xFF0F3460)
    value >= 5.0 -> Color(0xFFF59E0B)
    else -> Color(0xFFE94560)
}
