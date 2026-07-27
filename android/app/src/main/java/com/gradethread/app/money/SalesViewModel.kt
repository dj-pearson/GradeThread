package com.gradethread.app.money

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1371: the sales list.
 *
 * Room-backed and reactive (AC2), so a pull lands on the screen without polling.
 * All row math is [SalesRollup] — pure and unit-tested against the Money rollup —
 * so nothing here re-derives a figure the Money tab also shows.
 */
@HiltViewModel
class SalesViewModel @Inject constructor(
    db: GradeThreadDb,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _refreshError = MutableStateFlow<String?>(null)
    val refreshError: StateFlow<String?> = _refreshError.asStateFlow()

    val state: StateFlow<SalesSummary> = combine(
        db.sales().observeAll(),
        db.items().observeAll(),
    ) { sales, items -> SalesRollup.compute(sales, items) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SalesSummary())

    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }.onFailure { error ->
                // A banner, never an emptied list: the cached sales are still
                // the truth we last knew.
                _refreshError.value = error.message ?: "Couldn't refresh your sales."
            }
            _refreshing.value = false
        }
    }

    fun dismissRefreshError() {
        _refreshError.value = null
    }
}
