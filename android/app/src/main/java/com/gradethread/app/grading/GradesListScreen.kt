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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.R
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.Spacing
import java.util.Locale

/**
 * US-1341: every certified grade in one place (iOS `GradesListView`).
 */
// US-2910 AC3. PullToRefreshBox is still ExperimentalMaterial3Api on Compose
// BOM 2025.04.00 - the same opt-in InventoryListScreen carries.
@OptIn(ExperimentalMaterial3Api::class)
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
                stringResource(R.string.grades_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = viewModel::refresh, enabled = !refreshing) {
                Text(
                    if (refreshing) {
                        stringResource(R.string.common_refreshing)
                    } else {
                        stringResource(R.string.common_refresh)
                    },
                )
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
                TextButton(onClick = viewModel::dismissRefreshError) {
                    Text(stringResource(R.string.common_dismiss))
                }
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

        // US-2910 AC3: wraps the WHOLE conditional so the empty state is
        // pullable too - that is the state a seller pulls from, because they
        // are looking at nothing and want to know whether it is the truth or
        // the network.
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier.weight(1f),
        ) {
            if (sorted.isEmpty()) {
                Column(
                    Modifier.fillMaxSize().padding(Spacing.xl),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        stringResource(R.string.grades_empty_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        stringResource(R.string.grades_empty_body),
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
}

@Composable
private fun GradeRow(item: InventoryItemEntity, onClick: () -> Unit) {
    val score = item.gradeValue ?: return
    val pending = GradesList.isPendingReview(item)
    val scoreText = String.format(Locale.US, "%.1f", score)
    // Hoisted out of semantics { }, which is not a composable scope. Three
    // separate resources rather than one glued together: a translator has to be
    // able to move the grade, its tier and the review note relative to each other.
    val gradeLabel = item.gradeLabel
    val spokenBase = if (gradeLabel != null) {
        stringResource(R.string.a11y_grade_labeled, scoreText, gradeLabel)
    } else {
        stringResource(R.string.a11y_grade, scoreText)
    }
    val spoken = if (pending) {
        stringResource(R.string.a11y_grade_pending, spokenBase)
    } else {
        spokenBase
    }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            scoreText,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = gradeColor(score),
            modifier = Modifier
                .padding(end = Spacing.sm)
                .semantics { contentDescription = spoken },
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
            Badge(stringResource(R.string.grades_pending_review), Color(0xFFF59E0B))
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
