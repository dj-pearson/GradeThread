package com.gradethread.app.marketplaces.postsale

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncService
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.SaleEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1357: the post-sale surface — what to post, and who to thank.
 *
 * The lists come off Room, so they are whatever the last sync knew. That is the
 * point: this screen works on a train with no signal, and only the two ACTIONS
 * need the network.
 */
@HiltViewModel
class PostSaleViewModel @Inject constructor(
    private val service: PostSaleService,
    private val sync: SyncService,
    db: GradeThreadDb,
) : ViewModel() {

    data class State(
        val busy: Boolean = false,
        val banner: String? = null,
        val errorMessage: String? = null,
    )

    /** Everything synced, split into the two questions worth answering. */
    val toShip = db.sales().observeAll().map { PostSale.awaitingShipment(it) }
    val toThank = db.sales().observeAll().map { PostSale.readyForFeedback(it) }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun refresh() {
        viewModelScope.launch { sync.pull() }
    }

    fun markShipped(sale: SaleEntity, trackingText: String, carrierText: String) {
        val tracking = PostSale.trackingNumber(trackingText)
        if (tracking == null) {
            _state.value = _state.value.copy(errorMessage = "Enter the tracking number.")
            return
        }
        act("Marked shipped. eBay has the tracking number.") {
            service.markShipped(sale.id, tracking, PostSale.carrier(carrierText))
            Telemetry.event("ebay_order_shipped", emptyMap())
        }
    }

    fun leaveFeedback(sale: SaleEntity, comment: String?) {
        val buyer = sale.buyerUsername?.takeIf { it.isNotBlank() }
        if (buyer == null) {
            // Without a buyer name there is nobody to leave it for; saying so
            // beats a 400 the seller can't interpret.
            _state.value = _state.value.copy(
                errorMessage = "This sale has no buyer name synced yet.",
            )
            return
        }
        act(null) {
            val response = service.leaveFeedback(buyer, sale.platformOrderId, comment)
            _state.value = _state.value.copy(
                banner = PostSale.feedbackMessage(response, buyer),
            )
        }
    }

    /**
     * Run an action, then pull.
     *
     * The pull is what keeps the list honest: shipping writes `shipped_at`
     * server-side, and without the pull the sale would sit in "to post" until
     * the next scheduled sync, inviting a second label.
     */
    private fun act(successMessage: String?, action: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    successMessage?.let { _state.value = _state.value.copy(banner = it) }
                    sync.pull()
                    _state.value = _state.value.copy(busy = false)
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, errorMessage = null)
    }
}
