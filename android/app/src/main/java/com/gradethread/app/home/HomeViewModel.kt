package com.gradethread.app.home

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.grading.GradesList
import com.gradethread.app.marketplaces.MarketplaceConnectionRepository
import com.gradethread.app.money.DashboardMetrics
import com.gradethread.app.money.DashboardRollup
import com.gradethread.app.money.DashboardTrend
import com.gradethread.app.money.TrendPoint
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.ZoneId
import javax.inject.Inject

/**
 * US-1370: the home dashboard.
 *
 * All figures are local rollups (AC1) — no fetch of its own, so the first screen
 * after launch renders instantly from Room instead of waiting on six requests.
 *
 * The rollups are memoized by being computed in [combine]: they rebuild only when
 * the underlying Room data changes, not on every recomposition (AC1's
 * "memoized, rebuilt only on data change"). Doing the aging + trend passes during
 * layout is what made this screen feel slow on iOS before the same split.
 */
@HiltViewModel
class HomeViewModel @Inject constructor(
    @ApplicationContext context: Context,
    db: GradeThreadDb,
    private val syncTrigger: SyncTrigger,
    private val connections: MarketplaceConnectionRepository,
) : ViewModel() {

    data class State(
        val metrics: DashboardMetrics = DashboardMetrics.EMPTY,
        val trend: List<TrendPoint> = emptyList(),
        val agingItems: List<InventoryItemEntity> = emptyList(),
        val grades: GradesList.Summary = GradesList.Summary(0, 0, null),
        val hasAnyItems: Boolean = false,
    ) {
        val hasTrendActivity: Boolean get() = DashboardTrend.hasActivity(trend)
    }

    private val checklistStore = ActivationChecklistStore(context)

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _refreshError = MutableStateFlow<String?>(null)
    val refreshError: StateFlow<String?> = _refreshError.asStateFlow()

    /** eBay + notification state, refreshed on demand rather than observed. */
    private val _ebayConnected = MutableStateFlow(false)
    private val _notificationsEnabled = MutableStateFlow(false)

    private val zone: ZoneId = ZoneId.systemDefault()

    val state: StateFlow<State> = combine(
        db.items().observeAll(),
        db.sales().observeAll(),
    ) { items, sales ->
        // One clock read per recompute, so the trend's "today" and the metrics'
        // week window can't straddle midnight and disagree.
        val now = System.currentTimeMillis()
        State(
            metrics = DashboardRollup.compute(items, sales, now),
            trend = DashboardTrend.dailySeries(sales, items, nowMs = now, zone = zone),
            agingItems = DashboardRollup.agingItems(items, now),
            // US-1341 AC2's outstanding half: the certified-grades card.
            grades = GradesList.summarize(items),
            hasAnyItems = items.isNotEmpty(),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    val activation: StateFlow<ActivationState> = combine(
        checklistStore.dismissed,
        db.items().observeAll(),
        _ebayConnected,
        _notificationsEnabled,
    ) { dismissed, items, ebay, notifications ->
        ActivationState(
            hasItem = items.isNotEmpty(),
            ebayConnected = ebay,
            notificationsEnabled = notifications,
            dismissed = dismissed,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ActivationState())

    /**
     * Refresh the two step states the cache can't answer.
     *
     * eBay connectivity is a server fact and notification permission is an OS
     * fact, so neither can be derived from Room. Failures are SWALLOWED: an
     * unreachable connections endpoint must not turn the home screen into an
     * error state — the worst outcome is a step that still reads as incomplete.
     */
    fun refreshActivation(notificationsGranted: Boolean) {
        _notificationsEnabled.value = notificationsGranted
        viewModelScope.launch {
            runCatching { connections.list() }
                .onSuccess { list -> _ebayConnected.value = list.any { it.isActive } }
        }
    }

    fun dismissChecklist() {
        viewModelScope.launch { checklistStore.dismiss() }
    }

    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }.onFailure { error ->
                _refreshError.value = error.message ?: "Couldn't refresh."
            }
            _refreshing.value = false
        }
    }

    fun dismissRefreshError() {
        _refreshError.value = null
    }
}
