package com.gradethread.app.feedback

import androidx.annotation.StringRes

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1387: the feedback sheet's state.
 *
 * A ViewModel rather than `remember` inside the sheet, which is the whole of
 * AC3: closing the sheet to go and check a version number, an order id or the
 * exact wording of an error must not throw away what was typed. Compose state
 * inside a `ModalBottomSheet` dies with the sheet; this outlives it.
 */
@HiltViewModel
class FeedbackViewModel @Inject constructor(private val service: FeedbackSending) : ViewModel() {

    data class State(
        val open: Boolean = false,
        val category: Feedback.Category = Feedback.Category.BUG,
        val message: String = "",
        val sending: Boolean = false,
        val error: String? = null,
        val sent: Boolean = false,
    ) {
        /** Only once they've typed something — an error on an empty field nags. */
        @get:StringRes
        val messageError: Int?
            get() = message.takeIf { it.isNotEmpty() }?.let(Feedback::error)

        val canSend: Boolean get() = Feedback.canSend(message, sending)

        /** Mid-send, the sheet must not be swiped away under the request. */
        val dismissible: Boolean get() = !sending
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun open() {
        _state.value = _state.value.copy(open = true, error = null, sent = false)
    }

    /**
     * Close WITHOUT clearing the draft (AC3).
     *
     * The text is cleared on a successful send and never otherwise.
     */
    fun dismiss() {
        if (_state.value.sending) return
        _state.value = _state.value.copy(open = false)
    }

    fun setCategory(category: Feedback.Category) {
        _state.value = _state.value.copy(category = category, error = null)
    }

    fun setMessage(value: String) {
        _state.value = _state.value.copy(message = value, error = null, sent = false)
    }

    fun send() {
        val current = _state.value
        if (!current.canSend) return
        _state.value = current.copy(sending = true, error = null)
        viewModelScope.launch {
            runCatching { service.send(current.category, current.message) }.fold(
                onSuccess = {
                    Telemetry.event("feedback_sent", mapOf("category" to current.category.name))
                    _state.value = _state.value.copy(sending = false, sent = true, message = "")
                    // Confirm, THEN close. Closing instantly reads as nothing
                    // having happened, which is how people send the same
                    // feedback three times.
                    delay(Feedback.CONFIRM_MS)
                    _state.value = _state.value.copy(open = false, sent = false)
                },
                onFailure = { error ->
                    // The draft survives: a failed send that wiped the field
                    // would lose the whole report.
                    _state.value = _state.value.copy(
                        sending = false,
                        error = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't send that. Try again in a moment.",
                    )
                },
            )
        }
    }
}
