package com.gradethread.app.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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

/**
 * US-1342: the inventory list / board.
 *
 * All derivation goes through a single [InventoryDerivation] held in
 * `remember`, so the filter+sort pass survives recomposition rather than
 * re-running on every unrelated state change.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InventoryListScreen(
    /** US-1336: open the certified-grade request for one item. */
    onGrade: (String) -> Unit = {},
    /** US-1337: open the stored grade report for an already-graded item. */
    onOpenReport: (String) -> Unit = {},
    /** US-1339: grade the current multi-selection. */
    onBulkGrade: (List<String>) -> Unit = {},
    /** US-1343: open one item's canvas. */
    onOpenItem: (String) -> Unit = {},
    viewModel: InventoryListViewModel = hiltViewModel(),
) {
    val items by viewModel.items.collectAsStateWithLifecycle()
    val stage by viewModel.stage.collectAsStateWithLifecycle()
    val sort by viewModel.sort.collectAsStateWithLifecycle()
    val criteria by viewModel.criteria.collectAsStateWithLifecycle()
    val viewMode by viewModel.viewMode.collectAsStateWithLifecycle()
    val query by viewModel.query.collectAsStateWithLifecycle()
    val debouncedQuery by viewModel.debouncedQuery.collectAsStateWithLifecycle()
    val photoItemIds by viewModel.photoItemIds.collectAsStateWithLifecycle()
    val serverSearchIds by viewModel.serverSearchIds.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val refreshError by viewModel.refreshError.collectAsStateWithLifecycle()
    val bulkBusy by viewModel.bulkBusy.collectAsStateWithLifecycle()
    val bulkResult by viewModel.bulkResult.collectAsStateWithLifecycle()
    val bulkUndo by viewModel.bulkUndo.collectAsStateWithLifecycle()

    // US-1369 AC3: arriving from a community brand benchmark. Keyed on the
    // pending request rather than Unit, so a second deep link during the same
    // composition still lands.
    val pendingBrand by com.gradethread.app.inventory.InventoryFilterRequests.brand
        .collectAsStateWithLifecycle()
    androidx.compose.runtime.LaunchedEffect(pendingBrand) {
        if (pendingBrand != null) viewModel.applyPendingBrandFilter()
    }

    // One cache per screen, NOT per composition — a per-composition instance
    // would defeat the entire point.
    val derivation = remember { InventoryDerivation() }
    var showingFilters by remember { mutableStateOf(false) }
    // US-1339: a minimal multi-select — long-press to enter, tap to toggle.
    // US-1348 extends this with the rest of the bulk actions and undo; grading
    // needs it now, and a feature with no way to reach it is not shipped.
    var selection by remember { mutableStateOf(emptySet<String>()) }
    val selecting = selection.isNotEmpty()

    val counts = derivation.stageCounts(items)
    val facets = derivation.facets(items)
    val visible = derivation.filtered(
        items = items,
        // The board ignores stages but still honours search and facets.
        stage = if (viewMode == InventoryViewMode.BOARD) InventoryStage.ALL else stage,
        query = debouncedQuery,
        sort = sort,
        criteria = criteria,
        photoItemIds = photoItemIds,
        serverSearchIds = serverSearchIds,
    )

    if (showingFilters) {
        ModalBottomSheet(onDismissRequest = { showingFilters = false }) {
            InventoryFilterSheet(
                facets = facets,
                committed = criteria,
                allItems = items,
                stage = stage,
                photoItemIds = photoItemIds,
                onApply = {
                    viewModel.setCriteria(it)
                    showingFilters = false
                },
                onClear = {
                    viewModel.clearFilters()
                    showingFilters = false
                },
            )
        }
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = viewModel::setQuery,
            label = { Text("Search inventory") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(Spacing.md),
        )

        Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "${visible.size} items",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { showingFilters = true }) {
                Text(
                    if (criteria.activeCount > 0) "Filters (${criteria.activeCount})"
                    else "Filters",
                )
            }
            TextButton(onClick = viewModel::toggleViewMode) {
                Text(if (viewMode == InventoryViewMode.LIST) "Board" else "List")
            }
        }

        // Stage tabs are hidden on the board — the board IS the stage view.
        if (viewMode == InventoryViewMode.LIST) {
            ScrollableTabRow(
                selectedTabIndex = InventoryStage.userFacing.indexOf(stage).coerceAtLeast(0),
                edgePadding = Spacing.md,
            ) {
                InventoryStage.userFacing.forEach { candidate ->
                    Tab(
                        selected = candidate == stage,
                        onClick = { viewModel.selectStage(candidate) },
                        text = { Text("${candidate.label} (${counts[candidate] ?: 0})") },
                    )
                }
            }
        }

        SortRow(current = sort, onSelect = viewModel::setSort)

        refreshError?.let { message ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::dismissRefreshError) { Text("Dismiss") }
            }
        }

        // US-2151: the refresh now has real machinery behind it. A failure
        // shows the banner above and leaves the cached list untouched.
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            // US-1348: the real action bar replaces US-1339's minimal one.
            if (selecting) {
                BulkActionBar(
                    selectedCount = selection.size,
                    stage = stage,
                    busy = bulkBusy,
                    onClear = { selection = emptySet() },
                    onAction = { action ->
                        if (action == BulkAction.Grade) {
                            // Grading needs a tier, readiness and credits —
                            // that is the US-1339 sheet's whole job, so it is
                            // intercepted rather than run by the executor.
                            onBulkGrade(selection.toList())
                        } else {
                            viewModel.runBulk(action, selection.toList()) {
                                selection = emptySet()
                            }
                        }
                    },
                )
            }
            bulkUndo?.let { undo ->
                BulkUndoBar(
                    undo = undo,
                    onUndo = viewModel::undoBulk,
                    onDismiss = viewModel::dismissBulkUndo,
                )
            }
            bulkResult?.let { result ->
                BulkResultBar(result = result, onDismiss = viewModel::dismissBulkResult)
            }
            when (viewMode) {
                InventoryViewMode.LIST -> InventoryList(
                    visible, photoItemIds, onGrade, onOpenReport, onOpenItem,
                    selection, selecting, { id -> selection = toggle(selection, id) },
                )
                InventoryViewMode.BOARD -> InventoryBoard(
                    visible, photoItemIds, onGrade, onOpenReport, onOpenItem,
                    selection, selecting, { id -> selection = toggle(selection, id) },
                )
            }
        }
    }
}

@Composable
private fun SortRow(current: SortOption, onSelect: (SortOption) -> Unit) {
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(Spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        items(SortOption.entries) { option ->
            FilterChip(
                selected = option == current,
                onClick = { onSelect(option) },
                label = { Text(option.label) },
            )
        }
    }
}

@Composable
private fun InventoryList(
    items: List<InventoryItemEntity>,
    photoItemIds: Set<String>,
    onGrade: (String) -> Unit,
    onOpenReport: (String) -> Unit,
    onOpenItem: (String) -> Unit,
    selection: Set<String>,
    selecting: Boolean,
    onToggleSelect: (String) -> Unit,
) {
    if (items.isEmpty()) {
        EmptyState()
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(items, key = { it.id }) { item ->
            InventoryRow(
                item,
                hasPhotos = item.id in photoItemIds,
                onGrade = onGrade,
                onOpenReport = onOpenReport,
                onOpenItem = onOpenItem,
                selected = item.id in selection,
                selecting = selecting,
                onToggleSelect = onToggleSelect,
            )
        }
    }
}

@Composable
private fun InventoryBoard(
    items: List<InventoryItemEntity>,
    photoItemIds: Set<String>,
    onGrade: (String) -> Unit,
    onOpenReport: (String) -> Unit,
    onOpenItem: (String) -> Unit,
    selection: Set<String>,
    selecting: Boolean,
    onToggleSelect: (String) -> Unit,
) {
    val grouped = remember(items) { PipelineBoard.group(items) { it.status } }
    LazyRow(
        modifier = Modifier.fillMaxSize(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(Spacing.xs),
    ) {
        items(PipelineBoard.columns, key = { it.status }) { column ->
            Column(Modifier.width(264.dp)) {
                Text(
                    "${column.label} (${grouped[column.status]?.size ?: 0})",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    column.nextAction,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                LazyColumn {
                    items(grouped[column.status].orEmpty(), key = { it.id }) { item ->
                        InventoryRow(
                item,
                hasPhotos = item.id in photoItemIds,
                onGrade = onGrade,
                onOpenReport = onOpenReport,
                onOpenItem = onOpenItem,
                selected = item.id in selection,
                selecting = selecting,
                onToggleSelect = onToggleSelect,
            )
                    }
                }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun InventoryRow(
    item: InventoryItemEntity,
    hasPhotos: Boolean = false,
    onGrade: (String) -> Unit = {},
    onOpenReport: (String) -> Unit = {},
    onOpenItem: (String) -> Unit = {},
    selected: Boolean = false,
    selecting: Boolean = false,
    onToggleSelect: (String) -> Unit = {},
) {
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(
                // Long-press starts a selection; once one is running a plain
                // tap toggles, so the second pick doesn't need a long press.
                onClick = {
                    if (selecting) onToggleSelect(item.id) else onOpenItem(item.id)
                },
                onLongClick = { onToggleSelect(item.id) },
            )
            .background(
                if (selected) {
                    MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f)
                } else {
                    androidx.compose.ui.graphics.Color.Transparent
                },
            )
            .padding(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(item.title, style = MaterialTheme.typography.bodyMedium)
            Text(
                // "—" rather than an empty line, so the row keeps its height.
                text = listOfNotNull(item.brand, item.size)
                    .filter { it.isNotBlank() }
                    .joinToString(" · ")
                    .ifEmpty { "—" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            InventoryFilter.effectivePrice(item)?.let { price ->
                val label = when {
                    item.listingPrice != null -> "listed"
                    item.targetPrice != null -> "target"
                    else -> "cost"
                }
                Text(
                    "$${"%.2f".format(price)} $label",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        // Presence comes from photo ROWS, never primaryPhotoUrl — US-994,
        // the denormalized cover lags the real set, so a freshly-photographed
        // item would wrongly read as "no photos".
        if (!hasPhotos) {
            Text(
                text = "No photos",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .padding(end = Spacing.xs)
                    .semantics { contentDescription = "No photos yet" },
            )
        }
        // US-1336: the grade entry point. Offered only where it can succeed —
        // an already-graded item has nothing to request, and grading needs
        // photos, so an item without them would only reach a blocker list.
        if (item.gradeValue == null && hasPhotos) {
            TextButton(onClick = { onGrade(item.id) }) {
                Text("Grade", style = MaterialTheme.typography.labelMedium)
            }
        }
        // US-1337: a graded item's chip opens its report.
        item.gradeValue?.let { GradeChip(it, item.gradeLabel) { onOpenReport(item.id) } }
    }
}

/** Shown whenever a grade exists — the row does not gate on review state. */
@Composable
private fun GradeChip(score: Double, label: String?, onClick: () -> Unit = {}) {
    val color = gradeColor(score)
    Box(
        Modifier
            .clickable(onClick = onClick)
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = Spacing.xs, vertical = Spacing.xxs)
            .semantics {
                contentDescription = "Certified grade ${"%.1f".format(score)}" +
                    (label?.let { ", $it" } ?: "")
            },
    ) {
        Text(
            text = "%.1f".format(score) + (label?.let { " $it" } ?: ""),
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
}

/** The four GradeScale tiers. */
private fun gradeColor(score: Double): Color = when {
    score >= 9.5 -> Color(0xFF10B981)
    score >= 7.0 -> Color(0xFF0F3460)
    score >= 5.0 -> Color(0xFFF59E0B)
    else -> Color(0xFFE94560)
}

@Composable
private fun EmptyState() {
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Nothing here yet", style = MaterialTheme.typography.titleMedium)
        Text(
            "Items you source will show up here. Try clearing filters if you expected some.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** US-1339: add/remove one id from the current selection. */
private fun toggle(selection: Set<String>, id: String): Set<String> =
    if (id in selection) selection - id else selection + id
