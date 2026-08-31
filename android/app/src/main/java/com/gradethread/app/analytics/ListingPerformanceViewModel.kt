package com.gradethread.app.analytics

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.platform.net.EdgeApiError
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1368 AC2: the listing-performance drill-down.
 *
 * Unlike the rest of analytics this one IS a network read — the engagement
 * numbers live only on the server, written by the eBay traffic-report sync, and
 * are not part of the Room mirror. So the screen states its own freshness rather
 * than pretending to be offline-capable like the charts are.
 */
@HiltViewModel
class ListingPerformanceViewModel @Inject constructor(private val service: ListingPerformanceProviding) : ViewModel() {

    data class State(
        val rows: List<ListingPerformanceRow> = emptyList(),
        val sort: ListingPerformanceSort = ListingPerformanceSort.VIEWS,
        val ascending: Boolean = false,
        /** Null = the no-views filter is off. */
        val noViewDays: Int? = null,
        val loading: Boolean = false,
        val loaded: Boolean = false,
        /** True when eBay refused analytics scope; null when nothing is connected. */
        val analyticsDenied: Boolean? = null,
        val errorMessage: String? = null,
        val nowMs: Long = 0L,
    ) {
        val visible: List<ListingPerformanceRow>
            get() = ListingPerformance.resolve(rows, sort, ascending, noViewDays, nowMs)

        val summary: UiMessage get() = ListingPerformance.summary(rows, nowMs)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            val fetched = runCatching { service.rows() }
            val denied = runCatching { service.analyticsDenied() }.getOrNull()
            _state.value = fetched.fold(
                onSuccess = { rows ->
                    _state.value.copy(
                        rows = rows,
                        loading = false,
                        loaded = true,
                        analyticsDenied = denied,
                        // Stamped once per load, so every row's "days listed"
                        // and staleness are measured against the same instant.
                        nowMs = System.currentTimeMillis(),
                        errorMessage = null,
                    )
                },
                onFailure = { error ->
                    _state.value.copy(
                        loading = false,
                        // The previously loaded rows stay on screen. Numbers from
                        // six hours ago beat an empty list.
                        errorMessage = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't load your listing metrics.",
                    )
                },
            )
        }
    }

    /** Tapping the active column flips direction; a new column takes its default. */
    fun setSort(sort: ListingPerformanceSort) {
        val current = _state.value
        _state.value = if (current.sort == sort) {
            current.copy(ascending = !current.ascending)
        } else {
            current.copy(sort = sort, ascending = sort.defaultAscending)
        }
    }

    /** Tapping the active window turns the filter off. */
    fun toggleNoViewFilter(days: Int) {
        val current = _state.value
        _state.value = current.copy(
            noViewDays = if (current.noViewDays == days) null else days,
        )
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}
