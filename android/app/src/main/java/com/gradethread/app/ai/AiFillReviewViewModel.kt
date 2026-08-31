package com.gradethread.app.ai

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.R

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1334: ties the review sheet to the extraction, the write path and the
 * acceptance signal.
 *
 * The sheet stays a pure function of its inputs; this owns the IO so the
 * apply sequence has exactly one home. The RUN itself lives in
 * [AiExtractionManager] rather than here, so dismissing the screen doesn't
 * cancel it.
 */
@HiltViewModel
class AiFillReviewViewModel @Inject constructor(
    private val writer: AiFieldWriter,
    private val service: AiExtractService,
    private val manager: AiExtractionManager,
) : ViewModel() {

    data class State(
        val itemId: String? = null,
        val phase: AiExtractPhase? = null,
        val review: AiExtractReview.Review? = null,
        val saving: Boolean = false,
        val applied: Boolean = false,
        val errorMessage: UiMessage? = null,
        /** Suggestions the writer refused, surfaced rather than dropped. */
        val rejectedFields: Map<String, String> = emptyMap(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Follow one item's extraction.
     *
     * Idempotent, because a recomposition re-invokes it: re-collecting would
     * otherwise stack a new collector per frame.
     */
    fun bind(itemId: String) {
        if (_state.value.itemId == itemId) return
        _state.value = State(itemId = itemId, phase = manager.phase(itemId))
        viewModelScope.launch {
            manager.phases.collect { phases ->
                if (_state.value.itemId != itemId) return@collect
                _state.value = _state.value.copy(phase = phases[itemId])
            }
        }
        viewModelScope.launch {
            manager.reviews.collect { reviews ->
                if (_state.value.itemId != itemId) return@collect
                reviews[itemId]?.let { _state.value = _state.value.copy(review = it) }
            }
        }
    }

    fun present(review: AiExtractReview.Review) {
        _state.value = _state.value.copy(itemId = review.itemId, review = review)
    }

    /**
     * Cancel dismisses WITHOUT consuming the review (US-1182) — the seller
     * gets the same sheet back from the item, rather than losing the run.
     */
    fun dismissWithoutConsuming() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    /** Skip: the seller declined this review outright, so it IS consumed. */
    fun skip() {
        _state.value.itemId?.let(manager::consumeReview)
        _state.value = _state.value.copy(review = null, errorMessage = null)
    }

    fun apply(keptApplied: Set<String>, acceptedLowConfidence: Set<String>, keepMeasurements: Boolean) {
        val review = _state.value.review ?: return
        if (_state.value.saving) return
        _state.value = _state.value.copy(saving = true, errorMessage = null)

        viewModelScope.launch {
            val result = writer.apply(
                review = review,
                keptApplied = keptApplied,
                acceptedLowConfidence = acceptedLowConfidence,
                keepMeasurements = keepMeasurements,
            )
            result.onSuccess { rejected ->
                _state.value = _state.value.copy(
                    saving = false,
                    applied = true,
                    rejectedFields = rejected,
                )
                manager.consumeReview(review.itemId)
                val used = AiExtractFlow.usedEvent(
                    review,
                    keptApplied,
                    acceptedLowConfidence,
                    keepMeasurements,
                )
                Telemetry.event(used.name, used.props)

                // Feedback is fire-and-forget and runs only AFTER the write
                // succeeded: failing the seller's apply because a training
                // signal didn't post would be indefensible.
                review.logId?.let { logId ->
                    service.reportAcceptance(
                        logId,
                        AiExtractReview.feedback(review, keptApplied, acceptedLowConfidence),
                    )
                }
            }.onFailure { error ->
                // The review is NOT cleared — the seller's choices survive so
                // they can retry rather than redo the whole review.
                _state.value = _state.value.copy(
                    saving = false,
                    // US-2976: "Couldn't save: X" is OUR sentence wrapping the
                    // failure, so the wrapped message NESTS as an argument
                    // rather than being interpolated into a String.
                    errorMessage = UiMessage(
                        R.string.ai_fill_save_failed,
                        args = listOf(AiExtractMessages.forError(error)),
                    ),
                )
            }
        }
    }

    /** Undo everything the AI filled. */
    fun undoAll() = apply(
        keptApplied = emptySet(),
        acceptedLowConfidence = emptySet(),
        keepMeasurements = false,
    )
}
