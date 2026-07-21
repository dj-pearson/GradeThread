package com.gradethread.app.grading

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncTrigger
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1339: bulk certified grading from an inventory multi-selection.
 *
 * Unlike the single-item flow there is NO polling. A batch of twenty grades
 * would mean twenty concurrent poll loops for no benefit, so the grades land
 * via sync — which is why the submit kicks one immediately (US-1176) rather
 * than leaving the seller staring at ungraded rows until the next cycle.
 */
@HiltViewModel
class BulkGradeViewModel @Inject constructor(
    private val service: GradingService,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    data class State(
        val itemIds: List<String> = emptyList(),
        val phase: BulkGradeMachine.Phase = BulkGradeMachine.Phase.Loading,
        val tier: GradeTier = GradeTier.default,
        val validation: GradingValidateResponse? = null,
        val pendingConfirmTier: GradeTier? = null,
    ) {
        val ready: List<GradingValidatedItem> get() = BulkGradeMachine.readyItems(validation)
        val blocked: List<GradingValidatedItem> get() = BulkGradeMachine.blockedItems(validation)
        val canSubmit: Boolean
            get() = BulkGradeMachine.canSubmit(
                validation,
                submitting = phase is BulkGradeMachine.Phase.Submitting,
            )
        val isBlockedOnCredits: Boolean
            get() = ready.isNotEmpty() && validation?.limitExceeded == true
        val creditBalance: Int get() = validation?.user?.creditBalance ?: 0

        /** Credits are spent unless the included allowance covers every ready item. */
        fun spendsCredits(candidate: GradeTier): Boolean {
            val included = validation?.user?.includedRemaining ?: 0
            return !(candidate == GradeTier.STANDARD && included >= ready.size)
        }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(itemIds: List<String>) {
        if (_state.value.itemIds == itemIds) return
        _state.value = State(itemIds = itemIds)
        load()
    }

    fun load() {
        val ids = _state.value.itemIds
        if (ids.isEmpty()) {
            _state.value = _state.value.copy(
                phase = BulkGradeMachine.Phase.Empty(BulkGradeMachine.NOTHING_SELECTED),
            )
            return
        }
        _state.value = _state.value.copy(phase = BulkGradeMachine.Phase.Loading)
        viewModelScope.launch { runValidation(ids, _state.value.tier) }
    }

    fun selectTier(tier: GradeTier) {
        val current = _state.value
        if (tier == current.tier && current.pendingConfirmTier == null) return
        if (current.spendsCredits(tier)) {
            _state.value = current.copy(pendingConfirmTier = tier)
            return
        }
        applyTier(tier)
    }

    fun confirmTier() {
        _state.value.pendingConfirmTier?.let(::applyTier)
    }

    fun cancelTierConfirm() {
        _state.value = _state.value.copy(pendingConfirmTier = null)
    }

    private fun applyTier(tier: GradeTier) {
        _state.value = _state.value.copy(tier = tier, pendingConfirmTier = null)
        viewModelScope.launch { runValidation(_state.value.itemIds, tier) }
    }

    /** Re-validate after a credit grant, without blanking the sheet. */
    suspend fun revalidate() {
        runValidation(_state.value.itemIds, _state.value.tier)
    }

    private suspend fun runValidation(ids: List<String>, tier: GradeTier) {
        val wasBlocked = _state.value.validation?.limitExceeded == true
        runCatching { service.validateBatch(ids, tier) }
            .onSuccess { result ->
                _state.value = _state.value.copy(
                    validation = result,
                    phase = BulkGradeMachine.Phase.Ready,
                )
                if (result.limitExceeded && !wasBlocked) {
                    Telemetry.event(
                        "grade.credits_blocked",
                        mapOf("surface" to "bulk", "credits_required" to result.creditsRequired),
                    )
                }
            }
            .onFailure { error ->
                _state.value = _state.value.copy(
                    phase = BulkGradeMachine.Phase.Failed(message(error)),
                )
            }
    }

    fun submit() {
        val current = _state.value
        if (!current.canSubmit) return
        // Only the ready ones are sent. The blocked count is captured HERE,
        // before the response lands, because the summary has to distinguish
        // "we didn't send it" from "the server refused it".
        val ready = current.ready.map { it.inventoryItemId }
        val blockedCount = current.blocked.size

        _state.value = current.copy(phase = BulkGradeMachine.Phase.Submitting)
        Telemetry.event(
            "grade.bulk_requested",
            mapOf("count" to ready.size, "tier" to current.tier.wire),
        )

        viewModelScope.launch {
            runCatching { service.submitBatch(ready, current.tier) }
                .onSuccess { response ->
                    val summary = BulkGradeMachine.summarize(response, blockedCount)
                    _state.value = _state.value.copy(
                        phase = BulkGradeMachine.Phase.Done(summary),
                    )
                    Telemetry.event(
                        "grade.bulk_submitted",
                        mapOf(
                            "submitted" to response.submitted,
                            "failed" to response.failed,
                            "blocked" to blockedCount,
                            "tier" to current.tier.wire,
                        ),
                    )
                    // US-1176: no polling here, so pull now — otherwise the
                    // rows sit ungraded until the next sync cycle and the batch
                    // looks like it did nothing.
                    runCatching { syncTrigger.refresh() }
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(
                        phase = BulkGradeMachine.Phase.Failed(message(error)),
                    )
                }
        }
    }

    private fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Something went wrong. Please try again."
}
