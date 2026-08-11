package com.gradethread.app.radar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-2495: the store history.
 *
 * Server-computed on purpose. The money on these rows is the same money every
 * other FlipDesk surface shows, because it comes from the canonical item +
 * listing + sale join — deriving ROI on the phone would be a second definition
 * of profit, and two numbers for the same shop is worse than none.
 */
@HiltViewModel
class MyStoresViewModel @Inject constructor(
    private val service: MyStoresService,
) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val stores: MyStores? = null,
        val sort: StoreSort = StoreSort.PROFIT,
        val errorMessage: String? = null,
    ) {
        val rows: List<MyStore> get() = MyStoresRules.top(stores?.stores.orEmpty())

        /** Loaded and genuinely empty, as opposed to not asked for yet. */
        val isEmpty: Boolean get() = stores != null && stores.stores.isEmpty()

        val isComplete: Boolean get() = stores?.let(MyStoresRules::isComplete) ?: true
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load(sort: StoreSort = _state.value.sort) {
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true, sort = sort, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.stores(sort) }
                .onSuccess { _state.value = _state.value.copy(stores = it) }
                .onFailure {
                    _state.value = _state.value.copy(errorMessage = MyStoresService.message(it))
                }
            _state.value = _state.value.copy(loading = false)
        }
    }

    /**
     * Re-sort by asking the server again.
     *
     * Not sorted locally: the list is capped server-side, so sorting the page
     * we happen to hold would put the best of THIS page on top and call it the
     * best shop.
     */
    fun sortBy(sort: StoreSort) {
        if (sort == _state.value.sort && _state.value.stores != null) return
        load(sort)
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}
