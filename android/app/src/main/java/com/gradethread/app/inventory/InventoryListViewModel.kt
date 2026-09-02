package com.gradethread.app.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.ui.state.Restorable
import com.gradethread.app.sync.db.InventoryItemEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** List or kanban. */
enum class InventoryViewMode { LIST, BOARD }

/**
 * US-1342: inventory list state.
 *
 * The derivation itself lives in [InventoryDerivation] and is memoized, so
 * the ~20 unrelated UI-state flags a real screen carries can't trigger a
 * re-filter.
 */
@OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
@HiltViewModel
class InventoryListViewModel @Inject constructor(
    /**
     * US-1390: process death. A ViewModel survives rotation on its own but NOT
     * a kill, and the stage, sort, view mode and query are exactly what a
     * seller has to redo when the app is restored onto an empty list.
     */
    private val saved: androidx.lifecycle.SavedStateHandle,
    private val db: GradeThreadDb,
    private val searchService: InventorySearchService,
    private val syncTrigger: com.gradethread.app.sync.SyncTrigger,
    private val bulkExecutor: BulkActionExecutor,
) : ViewModel() {

    companion object {
        /** iOS `.task(id:)` sleep — each keystroke cancels the prior wait. */
        const val SEARCH_DEBOUNCE_MILLIS = 250L

        /** Below this the server FTS isn't worth a round trip. */
        const val MIN_SERVER_QUERY_LENGTH = 2
    }

    private val _stage = MutableStateFlow(
        Restorable.restoreEnum(saved.get<String>(Restorable.Keys.INVENTORY_STAGE), InventoryStage.ALL),
    )
    val stage: StateFlow<InventoryStage> = _stage.asStateFlow()

    private val _unlistedFilter = MutableStateFlow(
        Restorable.restoreEnum(
            saved.get<String>(Restorable.Keys.INVENTORY_UNLISTED_FILTER),
            UnlistedFilter.ALL,
        ),
    )

    /** The UNLISTED tab's chip. Survives a tab switch, so coming back finds it as left. */
    val unlistedFilter: StateFlow<UnlistedFilter> = _unlistedFilter.asStateFlow()

    private val _sort = MutableStateFlow(
        Restorable.restoreEnum(saved.get<String>(Restorable.Keys.INVENTORY_SORT), SortOption.NEWEST),
    )
    val sort: StateFlow<SortOption> = _sort.asStateFlow()

    private val _criteria = MutableStateFlow(InventoryFilterCriteria())
    val criteria: StateFlow<InventoryFilterCriteria> = _criteria.asStateFlow()

    private val _viewMode = MutableStateFlow(
        Restorable.restoreEnum(
            saved.get<String>(Restorable.Keys.INVENTORY_VIEW_MODE),
            InventoryViewMode.LIST,
        ),
    )
    val viewMode: StateFlow<InventoryViewMode> = _viewMode.asStateFlow()

    /** The live text field value — re-rendered per keystroke. */
    private val _query = MutableStateFlow(saved.get<String>(Restorable.Keys.INVENTORY_QUERY) ?: "")
    val query: StateFlow<String> = _query.asStateFlow()

    /**
     * The DEBOUNCED query — this, not [query], is what the derivation keys
     * on, so keystrokes inside the window don't churn the memo.
     */
    val debouncedQuery: StateFlow<String> = _query
        .debounce(SEARCH_DEBOUNCE_MILLIS)
        .stateIn(viewModelScope, SharingStarted.Eagerly, "")

    val items: StateFlow<List<InventoryItemEntity>> = db.items().observeAll()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /**
     * Ids that have photo ROWS (US-994 — never `primaryPhotoUrl`, which lags).
     *
     * Deliberate divergence from iOS, which fetches this lazily only when the
     * photo facet is active: AC #3 wants a photo indicator on EVERY row, so
     * the data is needed unconditionally. US-1520's actual concern was
     * faulting each item's photo relation per row; this is one id-level query
     * either way, which is the fix rather than the problem.
     */
    val photoItemIds: StateFlow<Set<String>> = db.photos().observeItemIdsWithPhotos()
        .map { it.toSet() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptySet())

    /**
     * Server FTS ids, recomputed off the DEBOUNCED query so the RPC fires at
     * most once per pause, not per keystroke.
     */
    val serverSearchIds: StateFlow<Set<String>?> = debouncedQuery
        .mapLatest { query -> searchService.search(query) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _refreshError = MutableStateFlow<String?>(null)
    val refreshError: StateFlow<String?> = _refreshError.asStateFlow()

    /**
     * US-2151: pull-to-refresh, now that sync has a caller.
     *
     * A failure surfaces as a dismissible banner and NEVER clears the list —
     * the cached rows are still perfectly usable, and emptying them because a
     * refresh failed would turn a minor network blip into apparent data loss.
     */
    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        _refreshError.value = null
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }
                .onSuccess { outcome ->
                    // A partial pull is still a real failure worth naming: the
                    // seller asked for fresh data and some of it didn't arrive.
                    if (outcome != null && !outcome.succeeded) {
                        _refreshError.value = "Some items couldn't be refreshed."
                    }
                }
                .onFailure { _refreshError.value = it.message ?: "Couldn't refresh." }
            _refreshing.value = false
        }
    }

    fun dismissRefreshError() {
        _refreshError.value = null
    }

    fun selectStage(stage: InventoryStage) {
        _stage.value = stage
        // Saved by NAME, not ordinal: an ordinal shifts the moment anyone
        // inserts a case, so a saved "Listed" filter would come back as "Sold".
        saved[Restorable.Keys.INVENTORY_STAGE] = stage.name
    }

    fun setUnlistedFilter(filter: UnlistedFilter) {
        _unlistedFilter.value = filter
        saved[Restorable.Keys.INVENTORY_UNLISTED_FILTER] = filter.name
    }

    fun setQuery(value: String) {
        _query.value = value
        saved[Restorable.Keys.INVENTORY_QUERY] = value
    }

    fun setSort(option: SortOption) {
        _sort.value = option
        saved[Restorable.Keys.INVENTORY_SORT] = option.name
    }

    fun setCriteria(value: InventoryFilterCriteria) {
        _criteria.value = value
    }

    fun clearFilters() {
        _criteria.value = InventoryFilterCriteria()
    }

    /**
     * US-1369 AC3: apply a pending "show me this brand" request, once.
     *
     * REPLACES the brand facet rather than adding to it — arriving from a
     * community benchmark for Patagonia and landing on a list still filtered to
     * three brands from an hour ago would look like the deep link did nothing.
     * Every other facet is left alone; the seller set those on purpose.
     */
    fun applyPendingBrandFilter() {
        val brand = InventoryFilterRequests.consumeBrand() ?: return
        _stage.value = InventoryStage.ALL
        _criteria.value = _criteria.value.copy(brands = setOf(brand))
    }

    fun toggleViewMode() {
        val next = if (_viewMode.value == InventoryViewMode.LIST) {
            InventoryViewMode.BOARD
        } else {
            InventoryViewMode.LIST
        }
        _viewMode.value = next
        saved[Restorable.Keys.INVENTORY_VIEW_MODE] = next.name
    }

    // ── US-1348: bulk actions ────────────────────────────────────────────

    private val _bulkBusy = MutableStateFlow(false)
    val bulkBusy: StateFlow<Boolean> = _bulkBusy.asStateFlow()

    private val _bulkResult = MutableStateFlow<BulkActionResult?>(null)
    val bulkResult: StateFlow<BulkActionResult?> = _bulkResult.asStateFlow()

    private val _bulkUndo = MutableStateFlow<BulkUndo?>(null)
    val bulkUndo: StateFlow<BulkUndo?> = _bulkUndo.asStateFlow()

    fun runBulk(action: BulkAction, itemIds: List<String>, onDone: () -> Unit) {
        if (_bulkBusy.value || itemIds.isEmpty()) return
        _bulkBusy.value = true
        _bulkResult.value = null
        viewModelScope.launch {
            val outcome = bulkExecutor.run(action, itemIds)
            _bulkResult.value = outcome.result
            // Offered only when something actually changed — an undo bar for a
            // batch that failed outright would promise to reverse nothing.
            _bulkUndo.value = outcome.undo?.takeIf { !it.isEmpty }
            _bulkBusy.value = false
            onDone()
        }
    }

    fun undoBulk() {
        val undo = _bulkUndo.value ?: return
        _bulkUndo.value = null
        viewModelScope.launch {
            _bulkBusy.value = true
            bulkExecutor.revert(undo)
            _bulkBusy.value = false
        }
    }

    fun dismissBulkUndo() {
        _bulkUndo.value = null
    }

    fun dismissBulkResult() {
        _bulkResult.value = null
    }
}
