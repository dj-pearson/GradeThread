package com.gradethread.app.support

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** US-1386: the support inbox and the "open a request" form. */
@HiltViewModel
class SupportViewModel @Inject constructor(private val service: SupportProviding) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val tickets: List<SupportTicket> = emptyList(),
        val loadError: String? = null,
        val composerOpen: Boolean = false,
        val subject: String = "",
        val body: String = "",
        val sending: Boolean = false,
        val sendError: String? = null,
        /** Set when a ticket is opened; the screen navigates and clears it. */
        val openedTicketId: String? = null,
    ) {
        val subjectError: UiMessage?
            get() = subject.takeIf { it.isNotEmpty() }?.let(Support::subjectError)
        val bodyError: UiMessage?
            get() = body.takeIf { it.isNotEmpty() }?.let(Support::bodyError)
        val canSend: Boolean get() = Support.canOpen(subject, body, sending)
        val isEmpty: Boolean get() = !loading && loadError == null && tickets.isEmpty()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var loading = false

    fun load() {
        if (loading) return
        loading = true
        _state.value = _state.value.copy(loading = true, loadError = null)
        viewModelScope.launch {
            runCatching { service.tickets() }.fold(
                onSuccess = { _state.value = _state.value.copy(loading = false, tickets = it) },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        loadError = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't load your requests.",
                    )
                },
            )
            loading = false
        }
    }

    fun openComposer() {
        _state.value = _state.value.copy(composerOpen = true, sendError = null)
    }

    /**
     * Close the composer WITHOUT clearing what was typed.
     *
     * AC-adjacent but the same principle as US-1387: someone who dismisses a
     * form to go and check an order number must find their words still there.
     */
    fun closeComposer() {
        _state.value = _state.value.copy(composerOpen = false)
    }

    fun setSubject(value: String) {
        _state.value = _state.value.copy(subject = value, sendError = null)
    }

    fun setBody(value: String) {
        _state.value = _state.value.copy(body = value, sendError = null)
    }

    fun send() {
        val current = _state.value
        if (!current.canSend) return
        _state.value = current.copy(sending = true, sendError = null)
        viewModelScope.launch {
            runCatching { service.open(current.subject, current.body) }.fold(
                onSuccess = { id ->
                    Telemetry.event("support_ticket_opened", emptyMap())
                    // Cleared only on SUCCESS. A failed send that wiped the
                    // form would lose the whole message.
                    _state.value = _state.value.copy(
                        sending = false,
                        composerOpen = false,
                        subject = "",
                        body = "",
                        openedTicketId = id,
                    )
                    loading = false
                    load()
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        sending = false,
                        sendError = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't send that. Try again in a moment.",
                    )
                },
            )
        }
    }

    fun onNavigated() {
        _state.value = _state.value.copy(openedTicketId = null)
    }
}

/** US-1386: one ticket's thread, and replying to it. */
@HiltViewModel
class SupportThreadViewModel @Inject constructor(private val service: SupportProviding) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val thread: SupportThread? = null,
        val loadError: String? = null,
        val reply: String = "",
        val sending: Boolean = false,
        val sendError: String? = null,
    ) {
        val canSend: Boolean get() = Support.canReply(reply, sending)

        @get:StringRes
        val reopenNotice: Int?
            get() = thread?.ticket?.let(Support::replyReopensNotice)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var loading = false

    fun load(ticketId: String) {
        if (loading) return
        loading = true
        _state.value = _state.value.copy(loading = true, loadError = null)
        viewModelScope.launch {
            runCatching { service.thread(ticketId) }.fold(
                onSuccess = { _state.value = _state.value.copy(loading = false, thread = it) },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        // A push can deep-link to a ticket this account no
                        // longer owns; the 404 has to read as that, not as a
                        // network blip they should retry forever.
                        loadError = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't load that request.",
                    )
                },
            )
            loading = false
        }
    }

    fun setReply(value: String) {
        _state.value = _state.value.copy(reply = value, sendError = null)
    }

    fun send(ticketId: String) {
        val current = _state.value
        if (!current.canSend) return
        _state.value = current.copy(sending = true, sendError = null)
        viewModelScope.launch {
            runCatching { service.reply(ticketId, current.reply) }.fold(
                onSuccess = {
                    _state.value = _state.value.copy(sending = false, reply = "")
                    // Reload rather than appending locally: the reply may have
                    // REOPENED the ticket, and the header has to say so.
                    loading = false
                    load(ticketId)
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        sending = false,
                        sendError = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't send your reply. Try again in a moment.",
                    )
                },
            )
        }
    }
}
