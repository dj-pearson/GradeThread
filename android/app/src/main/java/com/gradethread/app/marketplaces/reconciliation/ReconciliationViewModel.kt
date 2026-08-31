package com.gradethread.app.marketplaces.reconciliation

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.R

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncService
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1356: the orphan queue — create, link or ignore each unmatched listing.
 */
@HiltViewModel
class ReconciliationViewModel @Inject constructor(
    private val service: ReconciliationService,
    private val sync: SyncService,
    private val db: GradeThreadDb,
) : ViewModel() {

    data class State(
        val loading: Boolean = true,
        val orphans: List<OrphanEbayListing> = emptyList(),
        val busy: Boolean = false,
        /** Create-all progress, as (done, total). Null when not running. */
        val bulkProgress: Pair<Int, Int>? = null,
        /** Per-orphan failures from the last action, so the row can explain itself. */
        val rowErrors: Map<String, UiMessage> = emptyMap(),
        val banner: String? = null,
        val errorMessage: UiMessage? = null,
        /** Candidates for the link sheet, newest first. */
        val linkCandidates: List<InventoryItemEntity> = emptyList(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.fetchOrphans() }
                .onSuccess { _state.value = _state.value.copy(orphans = it, loading = false) }
                .onFailure {
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = UiMessage(
                            R.string.reconcile_error_load,
                            detail = it.message,
                        ),
                    )
                }
        }
    }

    /** Items to offer in the link sheet, straight from the local cache. */
    fun loadLinkCandidates() {
        viewModelScope.launch {
            val items = runCatching { db.items().allWithPhotos().map { it.item } }
                .getOrDefault(emptyList())
            _state.value = _state.value.copy(linkCandidates = items)
        }
    }

    fun createItem(orphan: OrphanEbayListing, title: String?, sku: String?, price: Double?) =
        act { service.createItem(orphan, title, sku, price) }

    fun link(orphan: OrphanEbayListing, itemId: String) = act { service.link(orphan, itemId) }

    fun ignore(orphan: OrphanEbayListing) = act { service.ignore(orphan) }

    /**
     * Run one decision and settle the queue.
     *
     * A success drops the row locally rather than refetching: the orphan is out
     * of the queue either way, and leaving it on screen invites a second tap
     * that would create a duplicate item.
     */
    private fun act(action: suspend () -> ReconcileOutcome) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            when (val outcome = action()) {
                is ReconcileOutcome.Failed -> _state.value = _state.value.copy(
                    busy = false,
                    rowErrors = _state.value.rowErrors + (outcome.orphanId to outcome.message),
                )

                else -> {
                    Telemetry.event(
                        "ebay_orphan_reconciled",
                        mapOf("kind" to outcome::class.simpleName.orEmpty()),
                    )
                    _state.value = _state.value.copy(
                        busy = false,
                        orphans = _state.value.orphans.filterNot { it.id == outcome.orphanId },
                        rowErrors = _state.value.rowErrors - outcome.orphanId,
                        banner = when (outcome) {
                            is ReconcileOutcome.Created -> "Item created from that listing."
                            is ReconcileOutcome.Linked -> "Listing linked to your item."
                            else -> "Listing ignored."
                        },
                    )
                    // A created or linked listing wrote rows the local cache
                    // doesn't have yet; pull so the item shows up where the
                    // seller will look for it next.
                    if (outcome !is ReconcileOutcome.Ignored) sync.pull()
                }
            }
        }
    }

    /** Create an item for every orphan, reporting progress as it goes. */
    fun createAll() {
        val orphans = _state.value.orphans
        if (orphans.isEmpty() || _state.value.busy) return
        _state.value = _state.value.copy(
            busy = true,
            bulkProgress = 0 to orphans.size,
            errorMessage = null,
            banner = null,
        )
        viewModelScope.launch {
            val result = service.createAll(orphans) { done, total ->
                _state.value = _state.value.copy(bulkProgress = done to total)
            }
            sync.pull()
            _state.value = _state.value.copy(
                busy = false,
                bulkProgress = null,
                // Only the failures stay in the queue — they still need a
                // decision, and each keeps the reason it didn't work.
                rowErrors = result.failures.toMap(),
                banner = result.summary,
            )
            load()
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, errorMessage = null)
    }
}
