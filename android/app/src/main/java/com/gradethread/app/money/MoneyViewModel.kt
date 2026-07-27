package com.gradethread.app.money

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.ZoneId
import javax.inject.Inject

/**
 * US-1363/US-1364: the Money tab.
 *
 * Every figure is a PURE ROLLUP over Room — no network call of its own (AC1). A
 * seller doing their books on a plane sees the same numbers they saw at home,
 * and the panels appear instantly instead of after six round trips.
 *
 * The rollups are recomputed in [combine] rather than inside the composable so
 * the arithmetic runs once per data change, not once per recomposition. On a
 * large inventory the aging + cash-flow passes are the most expensive thing on
 * the screen, and doing them during layout is what makes a Money tab feel slow.
 */
@HiltViewModel
class MoneyViewModel @Inject constructor(
    private val db: GradeThreadDb,
    private val syncTrigger: SyncTrigger,
    private val expenses: ExpenseRepository,
) : ViewModel() {

    data class State(
        val metrics: MoneyMetrics = MoneyMetrics.EMPTY,
        val cashFlow: List<CashFlowMonth> = emptyList(),
        val aging: List<AgingBracket> = emptyList(),
        val timeOnMarket: TimeOnMarketStats = TimeOnMarketStats.EMPTY,
        val sourceRoi: List<SourceRoiRow> = emptyList(),
        val profitRows: List<ItemProfitRow> = emptyList(),
        val expenses: List<ExpenseEntity> = emptyList(),
        /** Operating expenses this month — layered onto the KPI row. */
        val expensesThisMonth: Double = 0.0,
        val hasAnyData: Boolean = false,
    )

    private val _sort = MutableStateFlow(ItemProfitSort.RECENT)
    val sort: StateFlow<ItemProfitSort> = _sort.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _refreshError = MutableStateFlow<String?>(null)
    val refreshError: StateFlow<String?> = _refreshError.asStateFlow()

    /** One-shot feedback for the expense sheet (saved / queued / failed). */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val zone: ZoneId = ZoneId.systemDefault()

    val state: StateFlow<State> = combine(
        db.items().observeAll(),
        db.sales().observeAll(),
        db.expenses().observeAll(),
        db.sources().observeAll(),
    ) { items, sales, expenseRows, sources ->
        // Read the clock ONCE per recompute so every panel buckets against the
        // same "now" — two panels reading it separately can straddle midnight
        // and disagree about which day a sale belongs to.
        val now = System.currentTimeMillis()
        val monthStart = DashboardRollup.startOfMonth(now, zone)

        State(
            metrics = MoneyRollup.compute(items, sales, now, zone),
            cashFlow = MoneyAnalyticsRollup.cashFlow(
                items, sales, expenseRows, now, zone = zone,
            ),
            aging = MoneyAnalyticsRollup.inventoryAging(items, now, zone),
            timeOnMarket = MoneyAnalyticsRollup.timeOnMarket(items, sales, now, zone),
            sourceRoi = SourceRoiRollup.bySource(items, sales, sources),
            profitRows = MoneyAnalyticsRollup.itemProfitRows(items, sales),
            expenses = expenseRows,
            expensesThisMonth = Money.sum(expenseRows.filter { it.spentOn >= monthStart }) {
                it.amount
            },
            // Drives the empty state. Sales OR expenses count: a seller who has
            // only recorded costs so far still has a real (negative) P&L to see,
            // and showing them "no data yet" would hide it.
            hasAnyData = sales.isNotEmpty() || expenseRows.isNotEmpty() || items.isNotEmpty(),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    fun setSort(sort: ItemProfitSort) {
        _sort.value = sort
    }

    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }.onFailure { error ->
                // A banner, never an emptied screen: the cached figures are
                // still the truth we last knew.
                _refreshError.value = error.message ?: "Couldn't refresh your finances."
            }
            _refreshing.value = false
        }
    }

    fun dismissRefreshError() {
        _refreshError.value = null
    }

    fun dismissNotice() {
        _notice.value = null
    }

    /** @param onSaved invoked only on a durable outcome, so the sheet can close. */
    fun saveExpense(draft: ExpenseDraft, onSaved: () -> Unit) {
        viewModelScope.launch {
            when (val outcome = expenses.save(draft)) {
                is ExpenseRepository.Outcome.Saved -> {
                    _notice.value = "Expense saved."
                    onSaved()
                }
                is ExpenseRepository.Outcome.Queued -> {
                    // Truthful: it IS in their ledger, and the queue will send
                    // it. Saying "saved" alone would be a half-truth; saying
                    // "failed" would be wrong.
                    _notice.value = "Saved offline — it'll sync when you're back online."
                    onSaved()
                }
                is ExpenseRepository.Outcome.Failed -> _notice.value = outcome.message
            }
        }
    }

    fun deleteExpense(id: String) {
        viewModelScope.launch {
            when (val outcome = expenses.delete(id)) {
                is ExpenseRepository.Outcome.Failed -> _notice.value = outcome.message
                is ExpenseRepository.Outcome.Queued ->
                    _notice.value = "Removed — the change will sync when you're back online."
                is ExpenseRepository.Outcome.Saved -> _notice.value = "Expense removed."
            }
        }
    }

    /** Seed the form for an edit, straight from the cached row. */
    suspend fun draftFor(id: String): ExpenseDraft? =
        db.expenses().byId(id)?.let { ExpenseDraft.from(it) }
}
