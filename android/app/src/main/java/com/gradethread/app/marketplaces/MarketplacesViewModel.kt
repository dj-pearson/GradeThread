package com.gradethread.app.marketplaces

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1350: eBay account connections.
 */
@HiltViewModel
class MarketplacesViewModel @Inject constructor(
    private val repository: MarketplaceConnectionRepository,
) : ViewModel() {

    companion object {
        /**
         * Confirmation polling after a successful bounce-back.
         *
         * The callback says the exchange succeeded, but the row is written by
         * the edge and the app is reading it through a different connection —
         * so the list can legitimately lag the redirect by a moment. Six
         * one-second checks, then stop: past that a refresh is more honest
         * than a spinner.
         */
        const val CONFIRM_POLLS = 6
        const val CONFIRM_INTERVAL_MS = 1_000L
    }

    data class State(
        val connections: List<MarketplaceConnection> = emptyList(),
        val loading: Boolean = true,
        val connecting: Boolean = false,
        /** Set while waiting for the new row to appear after a callback. */
        val confirming: Boolean = false,
        val message: String? = null,
        val errorMessage: String? = null,
        /** The consent URL to open in a Custom Tab; cleared once launched. */
        val pendingConsentUrl: String? = null,
    ) {
        val hasPrimary: Boolean get() = connections.any { it.isPrimary }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** The nonce for the in-flight attempt. Null when nothing is in progress. */
    private var pendingNonce: String? = null

    fun load() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true)
            _state.value = _state.value.copy(connections = repository.list(), loading = false)
        }
    }

    fun connect() {
        if (_state.value.connecting) return
        val nonce = EbayOAuth.newNonce()
        pendingNonce = nonce
        _state.value = _state.value.copy(connecting = true, errorMessage = null, message = null)

        viewModelScope.launch {
            repository.startConsent(EbayOAuth.redirectPath(nonce))
                .onSuccess { url ->
                    _state.value = _state.value.copy(pendingConsentUrl = url)
                    Telemetry.event("ebay_connect_started", emptyMap())
                }
                .onFailure { error ->
                    pendingNonce = null
                    _state.value = _state.value.copy(
                        connecting = false,
                        errorMessage = repository.message(error),
                    )
                }
        }
    }

    /** The Custom Tab is open; don't relaunch it on the next recomposition. */
    fun onConsentLaunched() {
        _state.value = _state.value.copy(pendingConsentUrl = null)
    }

    /**
     * Handle the App Link bounce-back.
     *
     * The nonce is consumed whatever the verdict, so a redelivered intent
     * can't run the flow twice.
     */
    fun onCallback(uri: Uri?) {
        val outcome = EbayOAuth.parseCallback(uri, pendingNonce)
        if (outcome == EbayOAuth.Outcome.NotOurs) return
        pendingNonce = null

        Telemetry.event(
            "ebay_connect_result",
            mapOf("outcome" to outcome::class.simpleName.orEmpty()),
        )

        _state.value = _state.value.copy(
            connecting = false,
            errorMessage = if (outcome.isSuccess) null else EbayOAuth.message(outcome),
        )

        if (outcome.isSuccess) confirmConnection()
    }

    /**
     * Poll until the new connection appears.
     *
     * The AC calls for confirming via `last_synced_at`, but the honest signal
     * right after consent is the ROW existing at all — `last_synced_at` stays
     * null until the first listing sync runs, so waiting for it would report a
     * failure for a connection that worked.
     */
    private fun confirmConnection() {
        val before = _state.value.connections.map { it.id }.toSet()
        _state.value = _state.value.copy(confirming = true)
        viewModelScope.launch {
            repeat(CONFIRM_POLLS) {
                val connections = repository.list()
                if (connections.any { it.id !in before }) {
                    _state.value = _state.value.copy(
                        connections = connections,
                        confirming = false,
                        message = "eBay account connected.",
                    )
                    return@launch
                }
                delay(CONFIRM_INTERVAL_MS)
            }
            // Not a failure — eBay said yes. Just slower than we waited.
            _state.value = _state.value.copy(
                connections = repository.list(),
                confirming = false,
                message = "Connected. If the account isn't listed yet, pull to refresh.",
            )
        }
    }

    fun rename(connectionId: String, label: String) {
        viewModelScope.launch {
            repository.rename(connectionId, label)
                .onSuccess { _state.value = _state.value.copy(connections = repository.list()) }
                .onFailure { error ->
                    _state.value = _state.value.copy(errorMessage = repository.message(error))
                }
        }
    }

    fun setPrimary(connectionId: String) {
        viewModelScope.launch {
            repository.setPrimary(connectionId)
                .onSuccess { _state.value = _state.value.copy(connections = repository.list()) }
                .onFailure { error ->
                    _state.value = _state.value.copy(errorMessage = repository.message(error))
                }
        }
    }

    fun disconnect(connectionId: String) {
        viewModelScope.launch {
            repository.disconnect(connectionId)
                .onSuccess {
                    _state.value = _state.value.copy(
                        connections = repository.list(),
                        message = "Disconnected.",
                    )
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(errorMessage = repository.message(error))
                }
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(message = null, errorMessage = null)
    }
}
