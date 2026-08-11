package com.gradethread.app.marketplaces.postsale

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.SyncService
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-2409: returns, cancellations and payment disputes on the phone.
 *
 * These carry eBay's own clocks, and a clock that runs out decides the case
 * against the seller. Nothing here is applied optimistically: every action
 * reloads its list from eBay afterwards, because a local row claiming a state
 * the server never accepted is exactly how a seller stops looking at a case
 * that is still open.
 */
@HiltViewModel
class EbayCasesViewModel @Inject constructor(
    private val service: PostSaleService,
    private val sync: SyncService,
) : ViewModel() {

    enum class Tab { DISPUTES, RETURNS, CANCELLATIONS }

    data class State(
        val loading: Boolean = false,
        val tab: Tab = Tab.DISPUTES,
        val returns: List<EbayReturn> = emptyList(),
        val cancellations: List<EbayCancellation> = emptyList(),
        val disputes: List<EbayPaymentDispute> = emptyList(),
        /**
         * Ids with an action in flight, keyed per case.
         *
         * Per-case rather than one global flag: these move money, and a second
         * tap on a row whose refund is still travelling would issue it twice.
         * A global flag would also freeze every other case while one waited.
         */
        val busyIds: Set<String> = emptySet(),
        val showClosed: Boolean = false,
        /**
         * The last evidence upload landed. A flag, not a message: user-facing
         * copy belongs in strings.xml where it can be translated.
         */
        val evidenceSent: Boolean = false,
        val errorMessage: String? = null,
        /** A failed evidence upload, kept so the seller can retry it. */
        val pendingEvidence: PendingEvidence? = null,
    ) {
        val openReturns: List<EbayReturn> get() = returns.filterNot(EbayCases::isClosed)
        val closedReturns: List<EbayReturn> get() = returns.filter(EbayCases::isClosed)
        val openCancellations: List<EbayCancellation>
            get() = cancellations.filterNot(EbayCases::isClosed)
        val closedCancellations: List<EbayCancellation>
            get() = cancellations.filter(EbayCases::isClosed)
        val openDisputes: List<EbayPaymentDispute>
            get() = disputes.filterNot(EbayCases::isClosed)
        val closedDisputes: List<EbayPaymentDispute>
            get() = disputes.filter(EbayCases::isClosed)

        fun isBusy(id: String): Boolean = id in busyIds

        /** How many cases each tab is waiting on — what the tab label shows. */
        fun openCount(tab: Tab): Int = when (tab) {
            Tab.DISPUTES -> openDisputes.size
            Tab.RETURNS -> openReturns.size
            Tab.CANCELLATIONS -> openCancellations.size
        }
    }

    /** An evidence upload that failed. It is never retried automatically. */
    data class PendingEvidence(
        val disputeId: String,
        val image: ByteArray,
        val fileName: String,
    ) {
        // The array makes the generated equals compare identity while reading
        // as if it compared content, so both are written by hand on the id.
        override fun equals(other: Any?): Boolean =
            this === other || (other is PendingEvidence && other.disputeId == disputeId)

        override fun hashCode(): Int = disputeId.hashCode()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun selectTab(tab: Tab) {
        _state.value = _state.value.copy(tab = tab)
    }

    fun toggleClosed() {
        _state.value = _state.value.copy(showClosed = !_state.value.showClosed)
    }

    /**
     * Load all three lists.
     *
     * Each is caught on its own. An eBay account with disputes turned off
     * answers 502 for that one call, and letting it take the returns list down
     * with it would hide work the seller genuinely has.
     */
    fun load() {
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            var failure: String? = null
            val disputes = runCatching { service.disputes() }
                .onFailure { failure = service.message(it) }.getOrNull()
            val returns = runCatching { service.returns() }
                .onFailure { failure = failure ?: service.message(it) }.getOrNull()
            val cancellations = runCatching { service.cancellations() }
                .onFailure { failure = failure ?: service.message(it) }.getOrNull()

            _state.value = _state.value.copy(
                loading = false,
                disputes = disputes ?: _state.value.disputes,
                returns = returns ?: _state.value.returns,
                cancellations = cancellations ?: _state.value.cancellations,
                errorMessage = failure,
                // Land on a tab that has something on it, so a seller with one
                // open return does not open a screen that says "nothing here".
                tab = firstNonEmptyTab(disputes, returns, cancellations) ?: _state.value.tab,
            )
        }
    }

    private fun firstNonEmptyTab(
        disputes: List<EbayPaymentDispute>?,
        returns: List<EbayReturn>?,
        cancellations: List<EbayCancellation>?,
    ): Tab? = when {
        !disputes.isNullOrEmpty() && disputes.any { !EbayCases.isClosed(it) } -> Tab.DISPUTES
        !returns.isNullOrEmpty() && returns.any { !EbayCases.isClosed(it) } -> Tab.RETURNS
        !cancellations.isNullOrEmpty() && cancellations.any { !EbayCases.isClosed(it) } ->
            Tab.CANCELLATIONS
        else -> null
    }

    // ── the actions ──────────────────────────────────────────────────────

    fun decideReturn(case: EbayReturn, decision: String) =
        act(case.returnId) { service.decideReturn(case.returnId, decision, case.orderId) }

    fun refundReturn(case: EbayReturn) =
        act(case.returnId) { service.refundReturn(case.returnId, case.orderId) }

    fun decideCancellation(case: EbayCancellation, action: String) =
        act(case.cancelId) { service.decideCancellation(case.cancelId, action, case.orderId) }

    fun acceptDispute(case: EbayPaymentDispute) = act(case.paymentDisputeId) {
        service.resolveDispute(case.paymentDisputeId, "accept", orderId = case.orderId)
    }

    fun contestDispute(case: EbayPaymentDispute, note: String?) = act(case.paymentDisputeId) {
        service.resolveDispute(
            case.paymentDisputeId, "contest", note = note?.takeIf { it.isNotBlank() },
            orderId = case.orderId,
        )
    }

    /**
     * Send proof for a dispute.
     *
     * A failure is kept rather than swallowed. The upload is two server calls
     * and is not idempotent, so it cannot be retried behind the seller's back;
     * holding the bytes is what lets them press retry once, knowingly.
     */
    fun addEvidence(disputeId: String, image: ByteArray, fileName: String) {
        if (_state.value.isBusy(disputeId)) return
        _state.value = _state.value.copy(
            busyIds = _state.value.busyIds + disputeId,
            errorMessage = null,
            evidenceSent = false,
        )
        viewModelScope.launch {
            runCatching { service.addDisputeEvidence(disputeId, image, fileName) }
                .onSuccess {
                    _state.value = _state.value.copy(
                        pendingEvidence = null,
                        evidenceSent = true,
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        pendingEvidence = PendingEvidence(disputeId, image, fileName),
                        errorMessage = service.message(it),
                    )
                }
            _state.value = _state.value.copy(busyIds = _state.value.busyIds - disputeId)
        }
    }

    fun retryEvidence() {
        val pending = _state.value.pendingEvidence ?: return
        addEvidence(pending.disputeId, pending.image, pending.fileName)
    }

    fun dropPendingEvidence() {
        _state.value = _state.value.copy(pendingEvidence = null)
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(evidenceSent = false, errorMessage = null)
    }

    /**
     * Run one case action, then re-read from eBay.
     *
     * The reload runs on failure too. A refusal usually means eBay has moved
     * the case on already, and the list the seller is looking at is the thing
     * that is wrong.
     */
    private fun act(id: String, action: suspend () -> Unit) {
        if (_state.value.isBusy(id)) return
        _state.value = _state.value.copy(
            busyIds = _state.value.busyIds + id, errorMessage = null, evidenceSent = false,
        )
        viewModelScope.launch {
            val result = runCatching { action() }
            _state.value = _state.value.copy(
                busyIds = _state.value.busyIds - id,
                errorMessage = result.exceptionOrNull()?.let(service::message),
            )
            // Some of these move a sale to refunded or cancelled server-side,
            // so the local rows are stale too.
            runCatching { sync.pull() }
            load()
        }
    }
}
