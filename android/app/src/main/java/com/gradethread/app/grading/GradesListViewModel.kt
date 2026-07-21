package com.gradethread.app.grading

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1341: the certified-grades list.
 *
 * Backed by Room, so it renders instantly and works offline — the grades a
 * seller wants to show a buyer are exactly the ones they may be looking at
 * with no signal.
 */
@HiltViewModel
class GradesListViewModel @Inject constructor(
    db: GradeThreadDb,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    private val EMPTY: List<InventoryItemEntity> = emptyList()

    val items: StateFlow<List<InventoryItemEntity>> = db.items().observeAll()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), EMPTY)

    private val _sort = MutableStateFlow(GradesList.Sort.RECENT)
    val sort: StateFlow<GradesList.Sort> = _sort.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _refreshError = MutableStateFlow<String?>(null)
    val refreshError: StateFlow<String?> = _refreshError.asStateFlow()

    fun setSort(sort: GradesList.Sort) {
        _sort.value = sort
    }

    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }
                .onFailure { error ->
                    // Surfaced as a banner, never by emptying the list: the
                    // cached grades are still the truth we last knew.
                    _refreshError.value = error.message ?: "Couldn't refresh grades."
                }
            _refreshing.value = false
        }
    }

    fun dismissRefreshError() {
        _refreshError.value = null
    }
}
