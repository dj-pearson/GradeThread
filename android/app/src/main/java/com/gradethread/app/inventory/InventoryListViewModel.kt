package com.gradethread.app.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.stateIn
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
    private val db: GradeThreadDb,
) : ViewModel() {

    companion object {
        /** iOS `.task(id:)` sleep — each keystroke cancels the prior wait. */
        const val SEARCH_DEBOUNCE_MILLIS = 250L

        /** Below this the server FTS isn't worth a round trip. */
        const val MIN_SERVER_QUERY_LENGTH = 2
    }

    private val _stage = MutableStateFlow(InventoryStage.ALL)
    val stage: StateFlow<InventoryStage> = _stage.asStateFlow()

    private val _sort = MutableStateFlow(SortOption.NEWEST)
    val sort: StateFlow<SortOption> = _sort.asStateFlow()

    private val _criteria = MutableStateFlow(InventoryFilterCriteria())
    val criteria: StateFlow<InventoryFilterCriteria> = _criteria.asStateFlow()

    private val _viewMode = MutableStateFlow(InventoryViewMode.LIST)
    val viewMode: StateFlow<InventoryViewMode> = _viewMode.asStateFlow()

    /** The live text field value — re-rendered per keystroke. */
    private val _query = MutableStateFlow("")
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
     * Photo ids are only collected when the photo facet is active — the query
     * is cheap but pointless otherwise (US-1520).
     */
    val photoItemIds: StateFlow<Set<String>?> =
        combine(db.photos().observeItemIdsWithPhotos(), _criteria) { ids, criteria ->
            if (criteria.photoState == PhotoState.ANY) null else ids.toSet()
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    fun selectStage(stage: InventoryStage) {
        _stage.value = stage
    }

    fun setQuery(value: String) {
        _query.value = value
    }

    fun setSort(option: SortOption) {
        _sort.value = option
    }

    fun setCriteria(value: InventoryFilterCriteria) {
        _criteria.value = value
    }

    fun clearFilters() {
        _criteria.value = InventoryFilterCriteria()
    }

    fun toggleViewMode() {
        _viewMode.value =
            if (_viewMode.value == InventoryViewMode.LIST) InventoryViewMode.BOARD
            else InventoryViewMode.LIST
    }
}
