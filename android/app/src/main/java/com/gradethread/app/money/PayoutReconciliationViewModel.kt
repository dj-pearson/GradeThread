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
    db: GradeThreadDb,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    data class State(
        val reconciled: List<PayoutReconciliation.Reconciled> = emptyList(),
        val mismatches: List<PayoutReconciliation.Reconciled> = emptyList(),
        val matched: List<PayoutReconciliation.Reconciled> = emptyList(),
        val awaitingPayout: List<SaleEntity> = emptyList(),
        val unknownPayout: List<SaleEntity> = emptyList(),
        val refreshing: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _refreshing = MutableStateFlow(false)
    private val _errorMessage = MutableStateFlow<String?>(null)

    val state: StateFlow<State> = combine(
        db.payouts().observeAll(),
        db.sales().observeAll(),
        _refreshing,
        _errorMessage,
    ) { payouts, sales, refreshing, error ->
        val reconciled = PayoutReconciliation.reconcile(payouts, sales)
        State(
            reconciled = reconciled,
            mismatches = PayoutReconciliation.mismatches(reconciled),
            matched = reconciled.filter { it.matched },
            awaitingPayout = PayoutReconciliation.salesAwaitingPayout(sales),
            unknownPayout = PayoutReconciliation.salesWithUnknownPayout(payouts, sales),
            refreshing = refreshing,
            errorMessage = error,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

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
