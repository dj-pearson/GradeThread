package com.gradethread.app.inventory

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.R
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.TestTags
import com.gradethread.app.ui.state.Restorable
import com.gradethread.app.ui.theme.ContentMaxWidth
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.gradeColor

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

    InventoryListContent(
        ui = InventoryUiState(
            items = items,
            stage = stage,
            sort = sort,
            criteria = criteria,
            viewMode = viewMode,
            query = query,
            debouncedQuery = debouncedQuery,
            photoItemIds = photoItemIds,
            serverSearchIds = serverSearchIds,
            refreshing = refreshing,
            refreshError = refreshError,
            bulkBusy = bulkBusy,
            bulkResult = bulkResult,
            bulkUndo = bulkUndo,
        ),
        actions = InventoryActions(
            onSetCriteria = viewModel::setCriteria,
            onClearFilters = viewModel::clearFilters,
            onSetQuery = viewModel::setQuery,
            onToggleViewMode = viewModel::toggleViewMode,
            onSelectStage = viewModel::selectStage,
            onSetSort = viewModel::setSort,
            onDismissRefreshError = viewModel::dismissRefreshError,
            onRefresh = viewModel::refresh,
            onRunBulk = viewModel::runBulk,
            onUndoBulk = viewModel::undoBulk,
            onDismissBulkUndo = viewModel::dismissBulkUndo,
            onDismissBulkResult = viewModel::dismissBulkResult,
        ),
        onGrade = onGrade,
        onOpenReport = onOpenReport,
        onBulkGrade = onBulkGrade,
        onOpenItem = onOpenItem,
    )
}

/**
 * US-2902 AC3: the fourteen flows this screen collects, as one value.
 *
 * Same shape and same reason as MoneyUiState. InventoryListViewModel exposes
 * fourteen separate StateFlows, and fourteen plus twelve callbacks plus four
 * navigation lambdas is not a signature, it is a haystack. The aggregate is
 * built in the wrapper from the collected values, so the ViewModel's own API
 * is untouched.
 */
@Immutable
data class InventoryUiState(
    val items: List<InventoryItemEntity>,
    val stage: InventoryStage,
    val sort: SortOption,
    val criteria: InventoryFilterCriteria,
    val viewMode: InventoryViewMode,
    val query: String,
    val debouncedQuery: String,
    val photoItemIds: Set<String>,
    val serverSearchIds: Set<String>?,
    val refreshing: Boolean,
    val refreshError: String?,
    val bulkBusy: Boolean,
    val bulkResult: BulkActionResult?,
    val bulkUndo: BulkUndo?,
)

/** Everything this screen can do, with defaults so a golden needs none of it. */
@Immutable
data class InventoryActions(
    val onSetCriteria: (InventoryFilterCriteria) -> Unit = {},
    val onClearFilters: () -> Unit = {},
    val onSetQuery: (String) -> Unit = {},
    val onToggleViewMode: () -> Unit = {},
    val onSelectStage: (InventoryStage) -> Unit = {},
    val onSetSort: (SortOption) -> Unit = {},
    val onDismissRefreshError: () -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onRunBulk: (BulkAction, List<String>, () -> Unit) -> Unit = { _, _, _ -> },
    val onUndoBulk: () -> Unit = {},
    val onDismissBulkUndo: () -> Unit = {},
    val onDismissBulkResult: () -> Unit = {},
)

/**
 * The inventory list with no ViewModel in it.
 *
 * The fourteen values are unpacked to locals immediately below rather than
 * threaded through as ui.items, ui.stage and so on, which keeps four hundred
 * lines of layout byte-identical to what they were before the split. That is
 * deliberate: a refactor that also rewrites the layout is a refactor whose
 * diff nobody can check.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InventoryListContent(
    ui: InventoryUiState,
    actions: InventoryActions,
    onGrade: (String) -> Unit,
    onOpenReport: (String) -> Unit,
    onBulkGrade: (List<String>) -> Unit,
    onOpenItem: (String) -> Unit,
) {
    val items = ui.items
    val stage = ui.stage
    val sort = ui.sort
    val criteria = ui.criteria
    val viewMode = ui.viewMode
    val query = ui.query
    val debouncedQuery = ui.debouncedQuery
    val photoItemIds = ui.photoItemIds
    val serverSearchIds = ui.serverSearchIds
    val refreshing = ui.refreshing
    val refreshError = ui.refreshError
    val bulkBusy = ui.bulkBusy
    val bulkResult = ui.bulkResult
    val bulkUndo = ui.bulkUndo

    // One cache per screen, NOT per composition — a per-composition instance
    // would defeat the entire point.
    val derivation = remember { InventoryDerivation() }
    // US-1390: saveable. An open filter sheet that closes on rotation makes the
    // seller redo the choices they were halfway through.
    var showingFilters by rememberSaveable(
        key = Restorable.Keys.INVENTORY_FILTERS_OPEN,
    ) { mutableStateOf(false) }
    // US-1339: a minimal multi-select — long-press to enter, tap to toggle.
    // US-1348 extends this with the rest of the bulk actions and undo; grading
    // needs it now, and a feature with no way to reach it is not shipped.
    // US-1390: the selection survives rotation and process death, CAPPED and
    // PRUNED. Saved state crosses a Binder transaction with a shared ~1MB
    // budget, so an unbounded set is a crash on rotate rather than a lost
    // selection; and ids that no longer exist are dropped on restore, because a
    // sync between death and restore may have removed them.
    var savedSelection by rememberSaveable(
        key = Restorable.Keys.INVENTORY_SELECTION,
    ) { mutableStateOf("") }
    var selection by remember { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(items) {
        if (selection.isEmpty() && savedSelection.isNotBlank()) {
            selection = Restorable.restoreSelection(savedSelection, items.map { it.id }.toSet())
        }
    }
    LaunchedEffect(selection) {
        savedSelection = Restorable.saveableSelection(selection)
    }
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
                    actions.onSetCriteria(it)
                    showingFilters = false
                },
                onClear = {
                    actions.onClearFilters()
                    showingFilters = false
                },
            )
        }
    }

    // US-2905 AC4: one width bound for the WHOLE screen, not just the list.
    //
    // The Expanded-width capture showed the row coming APART - title and price
    // at the far left, the grade badge and the Grade action alone at the far
    // right, about 1900px away. On a phone they read as one row; at 1280dp the
    // eye cannot associate a grade with the item it belongs to.
    //
    // ⚠ IT HAS TO BE HERE AND NOT ON THE LIST. The first attempt bounded the
    // Column inside PullToRefreshBox, which is the list only - the search
    // field, the counts row, the stage tabs and the sort chips all sit ABOVE
    // that box. The golden showed the result at once: a centred list under
    // full-width chrome, which is worse than the stretched version because the
    // screen stops reading as one column at all.
    //
    // ⚠ AND ORDER IS THE WHOLE THING. `.fillMaxSize()` sets the MINIMUM width
    // as well as the maximum, so a `widthIn(max = ...)` after it cannot shrink
    // anything. Written that way first, the tablet golden came back
    // BYTE-IDENTICAL - which is how the no-op was caught at all.
    //
    // widthIn rather than a size-class branch: below the bound nothing changes,
    // so every phone golden stays byte-identical and verifyRoborazzi proves it.
    // 840dp is Material's large-pane width, past every phone, so this is a
    // tablet-only effect. It is NOT AC4's 65-75ch prose measure, which is
    // tighter and belongs on text-heavy screens rather than a scannable list.
    Column(
        Modifier
            .widthIn(max = ContentMaxWidth)
            .fillMaxSize(),
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = actions.onSetQuery,
            label = { Text(stringResource(R.string.inventorylist_search_inventory)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(Spacing.md),
        )

        Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = pluralStringResource(R.plurals.inventorylist_items, visible.size, visible.size),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { showingFilters = true }) {
                Text(
                    if (criteria.activeCount > 0) {
                        stringResource(R.string.inventorylist_filters_count, criteria.activeCount)
                    } else {
                        stringResource(R.string.inventorylist_filters)
                    },
                )
            }
            TextButton(onClick = actions.onToggleViewMode) {
                Text(
                    stringResource(
                        if (viewMode == InventoryViewMode.LIST) {
                            R.string.inventorylist_board
                        } else {
                            R.string.inventorylist_list
                        },
                    ),
                )
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
                        onClick = { actions.onSelectStage(candidate) },
                        text = {
                            Text(
                                stringResource(
                                    R.string.inventorylist_label_count,
                                    candidate.label,
                                    counts[candidate] ?: 0,
                                ),
                            )
                        },
                    )
                }
            }
        }

        SortRow(current = sort, onSelect = actions.onSetSort)

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
                TextButton(onClick = actions.onDismissRefreshError) {
                    Text(stringResource(R.string.inventorylist_dismiss))
                }
            }
        }

        // US-2151: the refresh now has real machinery behind it. A failure
        // shows the banner above and leaves the cached list untouched.
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = actions.onRefresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            // US-3001: a COLUMN, and the missing one was a real bug.
            //
            // PullToRefreshBox is a Box, so its children STACK. The action
            // bar, the undo bar, the result bar and the list all landed on
            // the same layer with the list - which is fillMaxSize and drawn
            // last - on top of the bars. They were visible through it and
            // could not be tapped, so an Undo inside its six-second window
            // was unreachable. A screen golden shows the undo bar rendering
            // through the first row.
            Column(Modifier.fillMaxSize()) {
                // US-1348: the real action bar replaces US-1339's minimal one.
                if (selecting) {
                    BulkActionBar(
                        modifier = Modifier.testTag(TestTags.Inventory.BULK_BAR),
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
                                actions.onRunBulk(action, selection.toList()) {
                                    selection = emptySet()
                                }
                            }
                        },
                    )
                }
                bulkUndo?.let { undo ->
                    BulkUndoBar(
                        undo = undo,
                        onUndo = actions.onUndoBulk,
                        onDismiss = actions.onDismissBulkUndo,
                    )
                }
                bulkResult?.let { result ->
                    BulkResultBar(result = result, onDismiss = actions.onDismissBulkResult)
                }
                when (viewMode) {
                    InventoryViewMode.LIST -> InventoryList(
                        visible,
                        photoItemIds,
                        onGrade,
                        onOpenReport,
                        onOpenItem,
                        selection,
                        selecting,
                        { id -> selection = toggle(selection, id) },
                    )
                    InventoryViewMode.BOARD -> InventoryBoard(
                        visible,
                        photoItemIds,
                        onGrade,
                        onOpenReport,
                        onOpenItem,
                        selection,
                        selecting,
                        { id -> selection = toggle(selection, id) },
                    )
                }
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
                    stringResource(
                        R.string.inventorylist_label_count,
                        column.label,
                        grouped[column.status]?.size ?: 0,
                    ),
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
            .testTag(TestTags.Inventory.row(item.id))
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
                    item.listingPrice != null -> stringResource(R.string.inventorylist_price_listed)
                    item.targetPrice != null -> stringResource(R.string.inventorylist_price_target)
                    else -> stringResource(R.string.inventorylist_price_cost)
                }
                Text(
                    stringResource(R.string.inventorylist_price_row, "%.2f".format(price), label),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        // Presence comes from photo ROWS, never primaryPhotoUrl — US-994,
        // the denormalized cover lags the real set, so a freshly-photographed
        // item would wrongly read as "no photos".
        if (!hasPhotos) {
            // Resolved out here: `semantics { }` is not a composable scope, so
            // a stringResource call inside it does not compile.
            val spoken = stringResource(R.string.inventorylist_no_photos_yet)
            Text(
                text = stringResource(R.string.inventorylist_no_photos),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .padding(end = Spacing.xs)
                    .semantics { contentDescription = spoken },
            )
        }
        // US-1336: the grade entry point. Offered only where it can succeed —
        // an already-graded item has nothing to request, and grading needs
        // photos, so an item without them would only reach a blocker list.
        if (item.gradeValue == null && hasPhotos) {
            TextButton(onClick = { onGrade(item.id) }) {
                Text(stringResource(R.string.inventorylist_grade), style = MaterialTheme.typography.labelMedium)
            }
        }
        // US-1337: a graded item's chip opens its report.
        item.gradeValue?.let { GradeChip(it, item.gradeLabel) { onOpenReport(item.id) } }
    }
}

/** Shown whenever a grade exists — the row does not gate on review state. */
@Composable
private fun GradeChip(score: Double, label: String?, onClick: () -> Unit = {}) {
    // Read here: the semantics block below is not a composable scope.
    val gradeSpoken = stringResource(R.string.inventorylist_grade_spoken)
    val labelSuffix = stringResource(R.string.inventorylist_grade_label_suffix)
    val color = gradeColor(score)
    Box(
        Modifier
            .clickable(onClick = onClick)
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = Spacing.xs, vertical = Spacing.xxs)
            .semantics {
                contentDescription = gradeSpoken.format(
                    "%.1f".format(score),
                    label?.let { labelSuffix.format(it) }.orEmpty(),
                )
            },
    ) {
        Text(
            // A number format, not copy: it never gets translated.
            text = "%.1f".format(score) + label?.let { " $it" }.orEmpty(),
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
}

@Composable
private fun EmptyState() {
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.inventorylist_nothing_here_yet), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.inventorylist_items_source_will_show_up),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** US-1339: add/remove one id from the current selection. */
private fun toggle(selection: Set<String>, id: String): Set<String> =
    if (id in selection) selection - id else selection + id
