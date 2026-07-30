package com.gradethread.app.marketplaces.promotions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** US-1357: state for the per-listing promotion + sale sheet. */
@HiltViewModel
class PromotionViewModel @Inject constructor(
    private val service: PromotionService,
) : ViewModel() {

    data class State(
        val listingId: String = "",
        val loading: Boolean = true,
        val promotion: PromotionState? = null,
        val rateText: String = "",
        val saleText: String = "",
        val busy: Boolean = false,
        val banner: String? = null,
        val errorMessage: String? = null,
    ) {
        val rate: Double? get() = Promotions.parseAdRate(rateText)
        val salePercent: Double? get() = Promotions.parseMarkdown(saleText)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(listingId: String) {
        if (_state.value.listingId == listingId && !_state.value.loading) return
        _state.value = State(listingId = listingId)
        refresh()
    }

    private fun refresh() {
        val listingId = _state.value.listingId
        if (listingId.isBlank()) return
        viewModelScope.launch {
            runCatching { service.state(listingId) }
                .onSuccess { promo ->
                    _state.value = _state.value.copy(
                        promotion = promo,
                        loading = false,
                        // Seed from what's already set, else the suggestion.
                        // Prefilling the seller's own live rate matters: the box
                        // is also how they CHANGE it, and showing a suggestion
                        // over their real rate invites an accidental edit.
                        rateText = (promo.ratePct ?: promo.suggestedRatePct)
                            ?.let { Promotions.formatPct(it) }.orEmpty(),
                        saleText = promo.salePct?.let { Promotions.formatPct(it) }.orEmpty(),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun setRate(text: String) {
        _state.value = _state.value.copy(rateText = text)
    }

    fun setSale(text: String) {
        _state.value = _state.value.copy(saleText = text)
    }

    fun promote() {
        val rate = _state.value.rate ?: return
        run("Promoted at ${Promotions.formatPct(rate)}%.") {
            service.promote(_state.value.listingId, rate)
            Telemetry.event("ebay_promotion_set", mapOf("rate_pct" to rate))
        }
    }

    fun stopPromoting() = run("Promotion stopped. The listing stays live.") {
        service.stopPromoting(_state.value.listingId)
    }

    fun startSale() {
        val pct = _state.value.salePercent ?: return
        run("Sale started at ${Promotions.formatPct(pct)}% off.") {
            service.startSale(_state.value.listingId, pct)
            Telemetry.event("ebay_sale_started", mapOf("percent_off" to pct))
        }
    }

    fun endSale() = run("Sale ended. The original price is back.") {
        service.endSale(_state.value.listingId)
    }

    /**
     * Run one action, then re-read the state from the server.
     *
     * The re-read is not optional: eBay clamps rates and can decline a markdown,
     * so echoing what we asked for would show the seller a rate the listing
     * isn't actually running.
     */
    private fun run(successMessage: String, action: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    _state.value = _state.value.copy(busy = false, banner = successMessage)
                    refresh()
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
