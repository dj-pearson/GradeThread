package com.gradethread.app.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1349: global search.
 *
 * Debounced, and the match runs off the main thread — the whole point of the
 * story's second AC is that typing stays smooth on a large inventory.
 */
@HiltViewModel
class GlobalSearchViewModel @Inject constructor(
    private val db: GradeThreadDb,
    private val serverSearch: InventorySearchService,
) : ViewModel() {

    companion object {
        /** Long enough to skip a keystroke, short enough to feel live. */
        const val DEBOUNCE_MS = 250L
    }

    data class State(
        val query: String = "",
        val searching: Boolean = false,
        val results: GlobalSearch.Results = GlobalSearch.Results(),
        /** True once a query has actually been run — drives empty vs zero-result. */
        val hasSearched: Boolean = false,
    ) {
        val tooShort: Boolean
            get() = query.trim().length in 1 until GlobalSearch.MIN_QUERY_LENGTH
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var searchJob: Job? = null

    fun setQuery(query: String) {
        _state.value = _state.value.copy(query = query)
        searchJob?.cancel()

        if (query.trim().length < GlobalSearch.MIN_QUERY_LENGTH) {
            // Cleared back to nothing: drop the results rather than leaving a
            // stale set under an empty box.
            _state.value = _state.value.copy(
                results = GlobalSearch.Results(),
                searching = false,
                hasSearched = false,
            )
            return
        }

        searchJob = viewModelScope.launch {
            delay(DEBOUNCE_MS)
            _state.value = _state.value.copy(searching = true)
            val items = db.items().allWithPhotos().map { it.item }
            val listings = db.listings().all()
            val sales = db.sales().all()
            val sources = db.sources().all()
            // Additive only — a failed or skipped server search returns null,
            // which must not be read as "no matches".
            val serverIds = runCatching { serverSearch.search(query) }.getOrNull()

            val results = GlobalSearch.compute(
                query = query,
                items = items,
                listings = listings,
                sales = sales,
                sources = sources,
                serverItemIds = serverIds,
            )
            // Guard against a slow result for an abandoned query landing on
            // top of a newer one.
            if (_state.value.query == query) {
                _state.value = _state.value.copy(
                    results = results,
                    searching = false,
                    hasSearched = true,
                )
            }
        }
    }

    fun clear() {
        searchJob?.cancel()
        _state.value = State()
    }
}
