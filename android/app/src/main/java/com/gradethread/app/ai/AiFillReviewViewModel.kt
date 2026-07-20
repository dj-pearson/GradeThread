package com.gradethread.app.ai

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
 * US-1334: ties the review sheet to the write path and the acceptance signal.
 *
 * The sheet stays a pure function of its inputs; this owns the IO so the
 * apply sequence has exactly one home.
 */
@HiltViewModel
class AiFillReviewViewModel @Inject constructor(
    private val writer: AiFieldWriter,
    private val service: AiExtractService,
) : ViewModel() {

    data class State(
        val review: AiExtractReview.Review? = null,
        val saving: Boolean = false,
        val applied: Boolean = false,
        val errorMessage: String? = null,
        /** Suggestions the writer refused, surfaced rather than dropped. */
        val rejectedFields: Map<String, String> = emptyMap(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun present(review: AiExtractReview.Review) {
        _state.value = State(review = review)
    }

    /** Cancel dismisses WITHOUT consuming the review (US-1182). */
    fun dismissWithoutConsuming() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    fun apply(
        keptApplied: Set<String>,
        acceptedLowConfidence: Set<String>,
        keepMeasurements: Boolean,
    ) {
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
                val used = AiExtractFlow.usedEvent(
                    review, keptApplied, acceptedLowConfidence, keepMeasurements,
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
                    errorMessage = "Couldn't save: ${AiExtractMessages.forError(error)}",
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
