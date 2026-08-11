package com.gradethread.app.marketplaces

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1350: eBay account connections.
 * US-1351: the listing pull and the listings it merges into the local cache.
 */
@HiltViewModel
class MarketplacesViewModel @Inject constructor(
    private val repository: MarketplaceConnectionRepository,
    private val ebaySync: EbaySyncService,
    // US-2481: extension work this phone queued for the seller's desktop.
    private val extensionQueue: ExtensionQueueRepository,
    /** US-2490: reprice, revise and end a listing that is already live. */
    private val publish: com.gradethread.app.marketplaces.publish.EbayPublishService,
    db: GradeThreadDb,
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

        /**
         * US-1351: plain-language sync summary. Deltas are named only when
         * they're non-zero — "+0 since last sync" is noise, and a seller
         * reading "0 listings" wants the total, not arithmetic.
         */
        fun syncedMessage(summary: EbaySyncSummary): String {
            val parts = mutableListOf("${summary.listingsCount} listings")
            if (summary.listingsDelta != 0) {
                parts += "${signed(summary.listingsDelta)} since last sync"
            }
            if (summary.salesDelta != 0) parts += "${signed(summary.salesDelta)} sales"
            return parts.joinToString(", ") + "."
        }

        private fun signed(delta: Int): String = if (delta > 0) "+$delta" else "$delta"
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
        /** US-1351: a listing pull is in flight. */
        val syncing: Boolean = false,
        /**
         * US-2490: the listing whose post-publish edit is in flight, by id.
         *
         * Per listing rather than one global flag: these push a price to a live
         * marketplace, and a second tap while the first is travelling is how a
         * listing gets two different prices in two minutes.
         */
        val editingListingId: String? = null,
        /**
         * US-2481: extension work queued from this phone, still waiting for a
         * desktop browser to open.
         */
        val queuePending: List<ExtensionQueueItem> = emptyList(),
        /**
         * Queued work that expired undrained or failed when it ran. Held apart
         * from [queuePending] on purpose: showing it as "still coming" is the
         * silence this queue would otherwise reintroduce, and for a delist that
         * silence becomes a double sale.
         */
        val queueNeedsAttention: List<ExtensionQueueItem> = emptyList(),
    ) {
        val hasPrimary: Boolean get() = connections.any { it.isPrimary }

        /** Nothing to sync from — don't offer the button as if there were. */
        val canSync: Boolean get() = connections.isNotEmpty()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * US-1351: the cached listings, straight off Room.
     *
     * Reactive rather than fetched: the sync merges rows on a background
     * coroutine, and Room re-emits, so the list updates as the pull lands
     * instead of only when the screen is re-entered.
     */
    val listings: Flow<List<ListingCardModel>> =
        db.listings().observeAll().map { rows -> rows.map { ListingCardModel.from(it) } }

    /** The nonce for the in-flight attempt. Null when nothing is in progress. */
    private var pendingNonce: String? = null

    fun load() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true)
            _state.value = _state.value.copy(connections = repository.list(), loading = false)
        }
        refreshQueue()
    }

    /**
     * US-2481: read the queue on every load rather than caching it.
     *
     * This is the screen a seller opens to ask "did the thing I queued at the
     * thrift store run yet". A stale answer to that question is the wrong
     * answer, and a failed read is not worth an error banner — the queue is
     * server-side state and the next load picks it up.
     */
    fun refreshQueue() {
        viewModelScope.launch {
            val snapshot = runCatching { extensionQueue.snapshot() }.getOrNull() ?: return@launch
            _state.value = _state.value.copy(
                queuePending = snapshot.pending,
                queueNeedsAttention = snapshot.needsAttention,
            )
        }
    }

    /** Remove a queued job the seller no longer wants run on their desktop. */
    fun cancelQueued(id: String) {
        viewModelScope.launch {
            runCatching { extensionQueue.cancel(id) }
            refreshQueue()
        }
    }

    /** How one queued job reads in the list. */
    fun describeQueued(item: ExtensionQueueItem): String = describeQueuedWork(item)

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

    /**
     * US-1351: pull listings from eBay.
     *
     * The completion copy names what happened for each outcome. A timeout in
     * particular is NOT reported as a failure — the sync keeps running on the
     * server, and telling the seller it broke would send them to re-run a job
     * that is already working.
     */
    // ── US-2490: post-publish edits ──────────────────────────────────────

    /** Change one live listing's price. */
    fun repriceListing(listingId: String, price: Double) =
        editListing(listingId) { publish.setPrice(listingId, price) }

    /**
     * Push the saved edits to a live listing.
     *
     * Sends `resyncEbayFields` so the eBay-owned structured fields — category,
     * condition and item specifics — go too. Without it a specifics correction
     * made on the phone (US-2413) reaches the item and stops there, and the
     * live listing keeps the values the seller already fixed.
     */
    fun reviseListing(listingId: String) =
        editListing(listingId) { publish.revise(listingId, photos = true, resyncEbayFields = true) }

    fun endListing(listingId: String) =
        editListing(listingId) { publish.endListing(listingId) }

    /**
     * Run one post-publish edit, then re-pull.
     *
     * The pull is not optional. These change state on eBay AND in the listings
     * table, so the card the seller is looking at is stale the moment the call
     * lands — and a card still showing the old price after a reprice reads as
     * the reprice having failed.
     */
    private fun editListing(
        listingId: String,
        action: suspend () -> com.gradethread.app.marketplaces.publish.PublishOutcome,
    ) {
        if (_state.value.editingListingId != null) return
        _state.value = _state.value.copy(
            editingListingId = listingId, errorMessage = null, message = null,
        )
        viewModelScope.launch {
            when (val outcome = action()) {
                is com.gradethread.app.marketplaces.publish.PublishOutcome.Done ->
                    _state.value = _state.value.copy(message = null)

                // Every other case carries the server's own sentence. A 409 on
                // an eBay-authored listing says eBay owns its lifecycle and to
                // end it there, which nothing here could work out.
                is com.gradethread.app.marketplaces.publish.PublishOutcome.PlanLimit ->
                    _state.value = _state.value.copy(errorMessage = outcome.message)

                is com.gradethread.app.marketplaces.publish.PublishOutcome.Failed ->
                    _state.value = _state.value.copy(errorMessage = outcome.message)

                is com.gradethread.app.marketplaces.publish.PublishOutcome.Blockers ->
                    _state.value = _state.value.copy(
                        errorMessage = outcome.blockers.joinToString(" "),
                    )

                else -> _state.value = _state.value.copy(
                    errorMessage = com.gradethread.app.marketplaces.publish.PublishFlow.NO_OFFER_MESSAGE,
                )
            }
            _state.value = _state.value.copy(editingListingId = null)
            syncListings()
        }
    }

    fun syncListings() {
        if (_state.value.syncing) return
        _state.value = _state.value.copy(syncing = true, errorMessage = null, message = null)
        viewModelScope.launch {
            val baseline = ebaySync.snapshot()
            val message: String
            var isError = false
            when (val outcome = ebaySync.sync(baseline)) {
                is EbaySyncCompletion.Completed -> message = syncedMessage(outcome.summary)
                is EbaySyncCompletion.TimedOut ->
                    message = "Still syncing on eBay's side. Refresh in a minute to see the rest."

                is EbaySyncCompletion.ConnectionFlagged -> {
                    isError = true
                    message = "eBay stopped accepting this connection: ${outcome.message}"
                }

                is EbaySyncCompletion.Failed -> {
                    isError = true
                    message = outcome.message
                }
            }
            _state.value = _state.value.copy(
                syncing = false,
                connections = repository.list(),
                message = message.takeIf { !isError },
                errorMessage = message.takeIf { isError },
            )
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(message = null, errorMessage = null)
    }
}
