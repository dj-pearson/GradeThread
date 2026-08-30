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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
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
import com.gradethread.app.ui.theme.gradeColor
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

    GradesListContent(
        state = GradesListUiState(
            items = items,
            sort = sort,
            refreshing = refreshing,
            refreshError = refreshError,
        ),
        actions = GradesListActions(
            setSort = viewModel::setSort,
            refresh = viewModel::refresh,
            dismissRefreshError = viewModel::dismissRefreshError,
            openReport = onOpenReport,
        ),
        modifier = modifier,
    )
}

/** Everything the list renders from (US-2902 AC3). */
@Immutable
data class GradesListUiState(
    val items: List<InventoryItemEntity> = emptyList(),
    val sort: GradesList.Sort = GradesList.Sort.RECENT,
    val refreshing: Boolean = false,
    val refreshError: String? = null,
)

/** Everything it can do. Defaults are no-ops so a golden passes none of them. */
@Immutable
data class GradesListActions(
    val setSort: (GradesList.Sort) -> Unit = {},
    val refresh: () -> Unit = {},
    val dismissRefreshError: () -> Unit = {},
    val openReport: (String) -> Unit = {},
)

/**
 * The grades list with no ViewModel attached (US-2902 AC3).
 *
 * Worth a golden beyond the extraction itself: every row draws its score through
 * `gradeColor`, and US-3010 moved the failing-grade band off a hardcoded
 * `Color(0xFFE94560)` onto `MaterialTheme.colorScheme.error`. That value differs
 * between light and dark, so capturing both is the only thing that would notice
 * it silently changing back.
 *
 * The layout body is unchanged from the version inside GradesListScreen - the
 * two `remember` derivations moved in with it and the callbacks are rebound - so
 * the extraction cannot have altered what a golden records.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GradesListContent(state: GradesListUiState, actions: GradesListActions, modifier: Modifier = Modifier) {
    val items = state.items
    val sort = state.sort
    val refreshing = state.refreshing
    val refreshError = state.refreshError
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
            TextButton(onClick = actions.refresh, enabled = !refreshing) {
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
                TextButton(onClick = actions.dismissRefreshError) {
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
                    onClick = { actions.setSort(option) },
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
            onRefresh = actions.refresh,
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
                        GradeRow(item) { actions.openReport(item.id) }
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
