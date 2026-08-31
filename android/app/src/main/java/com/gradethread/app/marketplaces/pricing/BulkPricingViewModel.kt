package com.gradethread.app.marketplaces.pricing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.marketplaces.MarketplaceConnectionRepository
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncService
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1355: adjust prices across many live listings at once.
 */
@HiltViewModel
class BulkPricingViewModel @Inject constructor(
    private val service: BulkPricingService,
    private val connections: MarketplaceConnectionRepository,
    private val sync: SyncService,
) : ViewModel() {

    data class State(
        val loading: Boolean = true,
        val listings: List<BulkListing> = emptyList(),
        val selected: Set<String> = emptySet(),
        val mode: BulkPricing.Mode = BulkPricing.Mode.NONE,
        val inputText: String = "",
        /** Per-listing failures from the last push. */
        val rowErrors: Map<String, UiMessage> = emptyMap(),
        val busy: Boolean = false,
        val banner: BulkPricing.Summary? = null,
        val errorMessage: String? = null,
        /**
         * US-1216: every bulk edit routes through the PRIMARY store, and
         * `listings` carries no per-store column. With more than one connected
         * account, the editor names the target rather than silently mixing them.
         */
        val primaryStoreName: String? = null,
        val multiStore: Boolean = false,
    ) {
        val value: Double? get() = BulkPricing.inputValue(inputText, mode)

        val updates: List<BulkPriceUpdate>
            get() = BulkPricing.updates(listings, selected, mode, value)

        /** The new price for a row, or the reason there isn't one. */
        fun target(listing: BulkListing): BulkPricing.Target = BulkPricing.target(listing.price, mode, value)

        val allSelected: Boolean
            get() = listings.isNotEmpty() && selected.size == listings.size

        val canApply: Boolean get() = !busy && updates.isNotEmpty()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.listings() }
                .onSuccess { rows ->
                    _state.value = _state.value.copy(
                        listings = rows,
                        loading = false,
                        // Drop selections for rows that no longer exist rather
                        // than carrying ids that would silently do nothing.
                        selected = _state.value.selected.intersect(rows.map { it.id }.toSet()),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = service.message(it),
                    )
                }
            loadStoreContext()
        }
    }

    private suspend fun loadStoreContext() {
        val accounts = connections.list()
        _state.value = _state.value.copy(
            primaryStoreName = accounts.firstOrNull()?.displayName,
            multiStore = accounts.size > 1,
        )
    }

    fun toggle(id: String) {
        val next = _state.value.selected.toMutableSet()
        if (!next.add(id)) next.remove(id)
        _state.value = _state.value.copy(selected = next)
    }

    fun toggleAll() {
        val state = _state.value
        _state.value = state.copy(
            selected = if (state.allSelected) emptySet() else state.listings.map { it.id }.toSet(),
        )
    }

    fun setMode(mode: BulkPricing.Mode) {
        // Switching modes drops stale per-row failures so the previous mode's
        // errors can't cling to rows the seller is now editing differently.
        _state.value = _state.value.copy(mode = mode, rowErrors = emptyMap())
    }

    fun setInput(text: String) {
        _state.value = _state.value.copy(inputText = text, rowErrors = emptyMap())
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, errorMessage = null)
    }

    /**
     * Push the prices.
     *
     * A partial batch is the normal case, not an exception: eBay can reject one
     * offer and accept the rest, so failures land on their rows and the batch
     * is never rolled back.
     */
    fun apply() {
        val state = _state.value
        val updates = state.updates
        if (updates.isEmpty() || state.busy) return
        _state.value = state.copy(busy = true, errorMessage = null, banner = null, rowErrors = emptyMap())

        viewModelScope.launch {
            runCatching { service.apply(updates) }
                .onSuccess { response ->
                    Telemetry.event(
                        "ebay_bulk_price",
                        mapOf("requested" to response.total, "succeeded" to response.succeeded),
                    )
                    _state.value = _state.value.copy(
                        busy = false,
                        rowErrors = BulkPricing.rowErrors(response.results),
                        banner = BulkPricing.summary(response),
                    )
                    // AC3: the edge already wrote the successes to `listings`;
                    // pulling now reconciles the local rows so the app doesn't
                    // keep showing the old price until the next scheduled sync.
                    sync.pull()
                    load()
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }
}
