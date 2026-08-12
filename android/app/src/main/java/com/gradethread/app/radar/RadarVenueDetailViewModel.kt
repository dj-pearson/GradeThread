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
 * US-2492: one venue, plus its per-brand breakdown.
 *
 * A venue below the k-anonymity floor and a venue that never existed return the
 * IDENTICAL 404 from the endpoint, so this cannot and must not tell them apart.
 * [Withheld.reason] carries only what the client is allowed to know: whether the
 * server said nothing (floor or absence, indistinguishable), whether the plan
 * gate fired, or whether the request failed and a retry could help.
 */
@HiltViewModel
class RadarVenueDetailViewModel @Inject constructor(
    private val radar: RadarService,
) : ViewModel() {

    /** Why there is nothing to draw. Never "this shop does not exist". */
    enum class WithheldReason { NOTHING_TO_SAY, PLAN_GATED, FAILED }

    sealed interface Phase {
        data object Loading : Phase
        data class Ready(val detail: RadarVenueDetail) : Phase

        /**
         * [message] is only set for [WithheldReason.FAILED], where the transport
         * layer wrote the sentence. The other two are copy the screen owns, so a
         * translation exists for them.
         */
        data class Withheld(val reason: WithheldReason, val message: String? = null) : Phase
    }

    private val _state = MutableStateFlow<Phase>(Phase.Loading)
    val state: StateFlow<Phase> = _state.asStateFlow()

    fun load(venueId: String, window: RadarWindow = RadarWindow.DEFAULT) {
        _state.value = Phase.Loading
        viewModelScope.launch {
            runCatching { radar.venueDetail(venueId, window) }
                .onSuccess { _state.value = Phase.Ready(it) }
                .onFailure { error ->
                    _state.value = when {
                        // Checked before the 404, because a Free seller never
                        // reaches the read and the upgrade dialog is already up.
                        RadarService.isPlanGated(error) ->
                            Phase.Withheld(WithheldReason.PLAN_GATED)
                        RadarService.isWithheld(error) ->
                            Phase.Withheld(WithheldReason.NOTHING_TO_SAY)
                        else -> Phase.Withheld(
                            WithheldReason.FAILED,
                            MyStoresService.message(error),
                        )
                    }
                }
        }
    }
}
