package com.gradethread.app.analytics

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.inventory.InventoryFilterRequests
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1369: community benchmarks, and what to do about them.
 *
 * Everything on this screen is somebody else's data in aggregate, so the states
 * it can be in matter more than usual: "nothing to act on" and "not enough
 * sellers yet" look identical on screen and mean completely different things —
 * one is a judgement, the other is a wait.
 */
@HiltViewModel
class CommunityInsightsViewModel @Inject constructor(private val service: CommunityInsightsProviding) : ViewModel() {

    sealed class Phase {
        object Loading : Phase()
        data class Ready(val data: CommunityBenchmarks) : Phase()

        /**
         * The benchmarks aren't available to this account.
         *
         * Kept apart from [Failed] because retrying can't fix it — the RPC is
         * granted to authenticated callers only, so this is a signed-out or
         * unprovisioned state, not a bad network.
         */
        data class Locked(val message: String) : Phase()

        data class Failed(val message: String) : Phase()
    }

    data class State(
        val phase: Phase = Phase.Loading,
        val recommendations: List<CommunityRecommendation> = emptyList(),
    ) {
        val data: CommunityBenchmarks?
            get() = (phase as? Phase.Ready)?.data

        val hasBenchmarkData: Boolean get() = data?.hasBenchmarkData == true

        /**
         * Rows exist but none clear the action thresholds.
         *
         * The copy for this says "nothing worth acting on right now", which is
         * a very different message from "not enough community data" — and
         * showing the second when the first is true tells a seller to wait for
         * something that already arrived.
         */
        val hasDataButNothingActionable: Boolean
            get() = hasBenchmarkData && recommendations.isEmpty()

        val peerStanding: String?
            get() = data?.you?.let { CommunityRecommendations.peerStanding(it) }

        @get:StringRes
        val peerBlocker: Int?
            get() = data?.you?.let { CommunityRecommendations.peerStandingBlocker(it) }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** Re-entrancy guard: an overlapping load would flicker back to Loading. */
    private var loading = false

    fun refresh() {
        if (loading) return
        loading = true
        _state.value = State(phase = Phase.Loading)
        viewModelScope.launch {
            runCatching { service.benchmarks() }
                .onSuccess { data ->
                    _state.value = State(
                        phase = Phase.Ready(data),
                        recommendations = CommunityRecommendations.derive(data),
                    )
                    Telemetry.event(
                        "community.benchmarks_loaded",
                        mapOf("brands" to data.topBrands.size),
                    )
                }
                .onFailure { error ->
                    _state.value = State(phase = classify(error))
                }
            loading = false
        }
    }

    /**
     * The RPC is granted to authenticated callers only, so a missing grant or an
     * expired session comes back as a Postgres permission error rather than a
     * network one. Matched on PostgREST's own wording because that is all the
     * client gets — and retrying either of those forever is the failure this
     * branch exists to avoid.
     */
    private fun classify(error: Throwable): Phase {
        val text = error.message.orEmpty()
        val locked = text.contains("permission denied", ignoreCase = true) ||
            text.contains("JWT", ignoreCase = true) ||
            text.contains("42501") // insufficient_privilege
        return if (locked) {
            Phase.Locked(
                "Community insights need you to be signed in with an active account.",
            )
        } else {
            Phase.Failed("Couldn't load community insights. Pull to try again.")
        }
    }

    /** AC3: open inventory filtered to this brand. */
    fun openBrand(brand: String, navigate: () -> Unit) {
        Telemetry.event("community.brand_tapped", mapOf("brand" to brand))
        InventoryFilterRequests.requestBrand(brand)
        navigate()
    }
}
