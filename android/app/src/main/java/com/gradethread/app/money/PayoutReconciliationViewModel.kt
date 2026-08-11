package com.gradethread.app.money

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.SaleEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1365: payouts against the books.
 *
 * Everything on screen comes from two Room tables, so the comparison works with
 * no signal (AC3) and re-emits by itself when the next pull writes new rows —
 * there is no "reload" step to forget. The only network action here is asking
 * for a sync; the reconciliation itself never touches it.
 */
@HiltViewModel
class PayoutReconciliationViewModel @Inject constructor(
    @dagger.hilt.android.qualifiers.ApplicationContext
    private val context: android.content.Context,
    db: GradeThreadDb,
    private val syncTrigger: SyncTrigger,
    /** US-2414: the payouts CSV, parsed and deduped server-side. */
    private val payoutImport: PayoutImportService,
) : ViewModel() {

    data class State(
        val reconciled: List<PayoutReconciliation.Reconciled> = emptyList(),
        val mismatches: List<PayoutReconciliation.Reconciled> = emptyList(),
        val matched: List<PayoutReconciliation.Reconciled> = emptyList(),
        val awaitingPayout: List<SaleEntity> = emptyList(),
        val unknownPayout: List<SaleEntity> = emptyList(),
        val refreshing: Boolean = false,
        val errorMessage: String? = null,
        /** US-2414: true while a payouts CSV is being read. */
        val importing: Boolean = false,
        /**
         * What the last import did. Held until dismissed, because the count
         * that matters most is `duplicates` — a seller who re-uploaded the same
         * export needs to be told nothing was double-counted, not shown a
         * silent success they will second-guess.
         */
        val importResult: PayoutImportResult? = null,
    )

    private val _refreshing = MutableStateFlow(false)
    private val _errorMessage = MutableStateFlow<String?>(null)

    private val _importing = MutableStateFlow(false)
    private val _importResult = MutableStateFlow<PayoutImportResult?>(null)

    val state: StateFlow<State> = combine(
        db.payouts().observeAll(),
        db.sales().observeAll(),
        _refreshing,
        _errorMessage,
        combine(_importing, _importResult) { importing, result -> importing to result },
    ) { payouts, sales, refreshing, error, importState ->
        val reconciled = PayoutReconciliation.reconcile(payouts, sales)
        State(
            reconciled = reconciled,
            mismatches = PayoutReconciliation.mismatches(reconciled),
            matched = reconciled.filter { it.matched },
            awaitingPayout = PayoutReconciliation.salesAwaitingPayout(sales),
            unknownPayout = PayoutReconciliation.salesWithUnknownPayout(payouts, sales),
            refreshing = refreshing,
            errorMessage = error,
            importing = importState.first,
            importResult = importState.second,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    /**
     * US-2414: read a payouts CSV the seller picked.
     *
     * The bytes go to the server and the ROWS come back through the ordinary
     * sync, so the reconciliation on this screen consumes them exactly as it
     * consumes webhook-ingested payouts — one comparison, one dedup rule, no
     * second path to keep in step.
     */
    fun importCsv(uri: android.net.Uri) {
        if (_importing.value) return
        _importing.value = true
        _errorMessage.value = null
        _importResult.value = null
        viewModelScope.launch {
            val csv = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openInputStream(uri)?.use {
                        it.readBytes().toString(Charsets.UTF_8)
                    }
                }.getOrNull()
            }
            when {
                csv.isNullOrBlank() -> _errorMessage.value = UNREADABLE
                // Checked before the upload rather than after: a 5MB file over
                // a cellular connection is a slow way to learn it was refused.
                csv.toByteArray().size > PayoutImportService.MAX_BYTES ->
                    _errorMessage.value = TOO_BIG

                else -> runCatching { payoutImport.importCsv(csv) }
                    .onSuccess { result ->
                        _importResult.value = result
                        // Only when something landed. A re-import that was all
                        // duplicates changed nothing to pull.
                        if (result.imported > 0) runCatching { syncTrigger.refresh() }
                    }
                    .onFailure { _errorMessage.value = PayoutImportService.message(it) }
            }
            _importing.value = false
        }
    }

    fun dismissImportResult() {
        _importResult.value = null
        _errorMessage.value = null
    }

    private companion object {
        const val UNREADABLE = "We couldn't read that file. Download the payouts report again and retry."
        const val TOO_BIG = "That file is too big. Export a shorter date range from Seller Hub."
    }

    /**
     * Pull, then let Room push the new rows through. Nothing is cleared first:
     * a failed sync leaves the last known comparison on screen, because stale
     * numbers a seller can read beat an empty screen they can't.
     */
    fun syncAndRefresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        _errorMessage.value = null
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }.onFailure { error ->
                _errorMessage.value = error.message ?: "Couldn't sync your payouts."
            }
            _refreshing.value = false
        }
    }
}
