package com.gradethread.app.grading

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.Backoff
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncTrigger
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext
import javax.inject.Inject

/**
 * US-1336: validate → pick a tier → confirm the spend → submit → poll.
 *
 * Every decision lives in [GradeRequestMachine]; this owns the IO and, more
 * importantly, the LIFETIME of the poll loop.
 */
@HiltViewModel
class GradeRequestViewModel @Inject constructor(
    private val service: GradingService,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    data class State(
        val itemId: String? = null,
        val phase: GradeRequestMachine.Phase = GradeRequestMachine.Phase.Loading,
        val tier: GradeTier = GradeTier.default,
        val validation: GradingValidateResponse? = null,
        /** The tier picked but not yet confirmed — paid tiers confirm the spend. */
        val pendingConfirmTier: GradeTier? = null,
    ) {
        val canSubmit: Boolean get() = GradeRequestMachine.canSubmit(validation)
        val isBlockedOnCredits: Boolean get() = GradeRequestMachine.isBlockedOnCredits(validation)
        val creditBalance: Int get() = validation?.user?.creditBalance ?: 0
        val blockers: List<String> get() = validation?.item?.blockers.orEmpty()

        /**
         * Whether picking this tier spends credits. The first Standard grade of
         * the month may be included, in which case there is nothing to confirm —
         * a confirmation dialog for a free action is noise that trains people to
         * dismiss the ones that matter.
         */
        fun spendsCredits(candidate: GradeTier): Boolean {
            val included = validation?.user?.includedRemaining ?: 0
            return !(candidate == GradeTier.STANDARD && included > 0)
        }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * The in-flight submit→poll job (iOS US-1229).
     *
     * Tracked so dismissal can cancel it. On iOS this was a fire-and-forget
     * task whose own `isCancelled` guard never tripped, because nothing ever
     * cancelled it — so leaving the sheet left the poll loop hitting the
     * network for the full two-minute window.
     */
    private var pollJob: Job? = null

    fun bind(itemId: String) {
        if (_state.value.itemId == itemId) return
        _state.value = State(itemId = itemId)
        load()
    }

    fun load() {
        val itemId = _state.value.itemId ?: return
        _state.value = _state.value.copy(phase = GradeRequestMachine.Phase.Loading)
        viewModelScope.launch { runValidation(itemId, _state.value.tier) }
    }

    /**
     * Choose a tier.
     *
     * Re-validates rather than recomputing locally: cost and affordability are
     * tier-specific and the server owns both. A client that did its own sums
     * would disagree with the charge the moment pricing is edited from admin.
     */
    fun selectTier(tier: GradeTier) {
        val current = _state.value
        if (tier == current.tier && current.pendingConfirmTier == null) return
        if (current.spendsCredits(tier)) {
            _state.value = current.copy(pendingConfirmTier = tier)
            return
        }
        applyTier(tier)
    }

    /** The seller confirmed the spend for [State.pendingConfirmTier]. */
    fun confirmTier() {
        val tier = _state.value.pendingConfirmTier ?: return
        applyTier(tier)
    }

    fun cancelTierConfirm() {
        _state.value = _state.value.copy(pendingConfirmTier = null)
    }

    private fun applyTier(tier: GradeTier) {
        val itemId = _state.value.itemId ?: return
        _state.value = _state.value.copy(tier = tier, pendingConfirmTier = null)
        viewModelScope.launch { runValidation(itemId, tier) }
    }

    private suspend fun runValidation(itemId: String, tier: GradeTier) {
        val wasBlocked = _state.value.validation?.limitExceeded == true
        runCatching { service.validate(itemId, tier) }
            .onSuccess { result ->
                _state.value = _state.value.copy(
                    validation = result,
                    phase = GradeRequestMachine.Phase.Ready,
                )
                // Emitted on the TRANSITION into blocked only, so re-validating
                // after each tier tap doesn't inflate the funnel step.
                if (result.limitExceeded && !wasBlocked) {
                    Telemetry.event(
                        "grade.credits_blocked",
                        mapOf("surface" to "single", "credits_required" to result.creditsRequired),
                    )
                }
            }
            .onFailure { error ->
                _state.value = _state.value.copy(
                    phase = GradeRequestMachine.Phase.Failed(message(error)),
                )
            }
    }

    fun submit() {
        val current = _state.value
        val itemId = current.itemId ?: return
        if (!current.canSubmit) return
        pollJob?.cancel()
        pollJob = viewModelScope.launch { runSubmit(itemId, current.tier) }
    }

    /**
     * Cancel the in-flight submit/poll. Called when the sheet is dismissed.
     *
     * The grade is unaffected — it finishes server-side and arrives with the
     * next sync. All this stops is us asking about it.
     */
    fun stop() {
        pollJob?.cancel()
        pollJob = null
    }

    override fun onCleared() {
        super.onCleared()
        stop()
    }

    private suspend fun runSubmit(itemId: String, tier: GradeTier) {
        _state.value = _state.value.copy(phase = GradeRequestMachine.Phase.Submitting)
        Telemetry.event("grade.requested", mapOf("tier" to tier.wire))

        val response = runCatching { service.submit(itemId, tier) }
            .getOrElse { error ->
                _state.value = _state.value.copy(
                    phase = GradeRequestMachine.Phase.Failed(message(error)),
                )
                return
            }

        when (val outcome = GradeRequestMachine.outcomeFor(response)) {
            is GradeRequestMachine.SubmitOutcome.Failed ->
                _state.value = _state.value.copy(
                    phase = GradeRequestMachine.Phase.Failed(outcome.message),
                )

            GradeRequestMachine.SubmitOutcome.NoPollRef ->
                finish(GradeRequestMachine.Phase.StillProcessing)

            is GradeRequestMachine.SubmitOutcome.Poll -> {
                _state.value = _state.value.copy(phase = GradeRequestMachine.Phase.Processing)
                poll(outcome.submissionRef)
            }
        }
    }

    private suspend fun poll(ref: String) {
        var consecutiveFailures = 0
        for (attempt in 0 until GradeRequestMachine.MAX_POLLS) {
            // Cooperative cancellation: `stop()` cancels the job, and this is
            // where the loop notices.
            coroutineContext.ensureActive()

            val result = runCatching { service.status(ref) }
            result.onSuccess { status ->
                consecutiveFailures = 0 // a reachable server clears the streak
                GradeRequestMachine.classify(status)?.let { phase ->
                    finish(phase)
                    return
                }
            }.onFailure { error ->
                if (!GradeRequestMachine.countsAsConnectionFailure(error)) {
                    Telemetry.breadcrumb(
                        "grade poll decode blip (server reachable, payload incomplete): " +
                            message(error),
                        "grading",
                    )
                } else {
                    consecutiveFailures++
                    Telemetry.breadcrumb(
                        "grade poll failed ($consecutiveFailures/" +
                            "${GradeRequestMachine.MAX_CONSECUTIVE_FAILURES}): ${message(error)}",
                        "grading",
                    )
                    if (consecutiveFailures >= GradeRequestMachine.MAX_CONSECUTIVE_FAILURES) {
                        _state.value = _state.value.copy(
                            phase = GradeRequestMachine.Phase.Failed(
                                GradeRequestMachine.LOST_CONNECTION,
                            ),
                        )
                        return
                    }
                }
            }
            delay(Backoff.delayMillis(attempt, baseMillis = 1_000, capMillis = 8_000))
        }
        // The window elapsed without a verdict — recoverable, not an error.
        finish(GradeRequestMachine.Phase.StillProcessing)
    }

    /**
     * Land on a terminal phase and pull, so the inventory row stops showing the
     * pre-grade state. The write happened server-side; nothing else re-syncs it.
     */
    private suspend fun finish(phase: GradeRequestMachine.Phase) {
        _state.value = _state.value.copy(phase = phase)
        when (phase) {
            is GradeRequestMachine.Phase.Completed -> Telemetry.event(
                "grade.completed",
                mapOf("tier" to _state.value.tier.wire, "score" to phase.report.overallScore),
            )
            is GradeRequestMachine.Phase.PendingReview ->
                Telemetry.event("grade.pending_review", mapOf("tier" to _state.value.tier.wire))
            is GradeRequestMachine.Phase.NeedsPhotos ->
                Telemetry.event("grade.needs_photos", mapOf("tier" to _state.value.tier.wire))
            else -> Unit
        }
        runCatching { syncTrigger.refresh() }
    }

    private fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Something went wrong. Please try again."
}
