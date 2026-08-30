package com.gradethread.app.money

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.MileageTripEntity
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
    /** US-3000: mileage trips, logged on the phone at the store. */
    private val mileage: MileageRepository,
    /** US-2491: what the unsold stock is worth. Server-computed. */
    private val equityService: EquityService,
) : ViewModel() {

    data class State(
        val metrics: MoneyMetrics = MoneyMetrics.EMPTY,
        val cashFlow: List<CashFlowMonth> = emptyList(),
        val aging: List<AgingBracket> = emptyList(),
        val timeOnMarket: TimeOnMarketStats = TimeOnMarketStats.EMPTY,
        val sourceRoi: List<SourceRoiRow> = emptyList(),
        val profitRows: List<ItemProfitRow> = emptyList(),
        val expenses: List<ExpenseEntity> = emptyList(),
        /** US-3000. Newest first, straight off Room so it works offline. */
        val trips: List<MileageTripEntity> = emptyList(),
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

    /**
     * US-2491: the equity card.
     *
     * Its own flow rather than a field on [State], because everything in State
     * is computed from Room and works offline. This needs a connection, and
     * folding it in would make the whole Money screen look broken on a train.
     */
    private val _equity = MutableStateFlow<EquitySummary?>(null)
    val equity: StateFlow<EquitySummary?> = _equity.asStateFlow()

    private val _equityTrend = MutableStateFlow<EquityTrend?>(null)
    val equityTrend: StateFlow<EquityTrend?> = _equityTrend.asStateFlow()

    private val _equityLoading = MutableStateFlow(false)
    val equityLoading: StateFlow<Boolean> = _equityLoading.asStateFlow()

    private val _equityError = MutableStateFlow<String?>(null)
    val equityError: StateFlow<String?> = _equityError.asStateFlow()

    /**
     * Load the equity summary and its trend.
     *
     * The trend is best-effort: it comes from a nightly snapshot job, so a
     * brand-new account legitimately has none, and failing the card over an
     * empty history would hide the number that IS available.
     */
    fun loadEquity() {
        if (_equityLoading.value) return
        _equityLoading.value = true
        _equityError.value = null
        viewModelScope.launch {
            runCatching { equityService.summary() }
                .onSuccess { _equity.value = it }
                .onFailure { _equityError.value = EquityService.message(it) }
            runCatching { equityService.trend() }.onSuccess { _equityTrend.value = it }
            _equityLoading.value = false
        }
    }

    private val zone: ZoneId = ZoneId.systemDefault()

    val state: StateFlow<State> = combine(
        db.items().observeAll(),
        db.sales().observeAll(),
        db.expenses().observeAll(),
        db.sources().observeAll(),
        db.mileageTrips().observeAll(),
    ) { items, sales, expenseRows, sources, trips ->
        // Read the clock ONCE per recompute so every panel buckets against the
        // same "now" — two panels reading it separately can straddle midnight
        // and disagree about which day a sale belongs to.
        val now = System.currentTimeMillis()
        val monthStart = DashboardRollup.startOfMonth(now, zone)
        // US-2339: expenses bucket in EXPENSE_ZONE, not the device zone.
        // spentOn carries a calendar date anchored at UTC midnight, so a
        // device-zone month boundary puts a 1st-of-the-month expense in the
        // previous month for anyone west of Greenwich. iOS reached the same
        // conclusion in US-1494 - parse and bucket in one zone.
        val expenseMonthStart =
            DashboardRollup.startOfMonth(now, ExpenseDraft.EXPENSE_ZONE)

        State(
            metrics = MoneyRollup.compute(items, sales, now, zone),
            cashFlow = MoneyAnalyticsRollup.cashFlow(
                items,
                sales,
                expenseRows,
                now,
                zone = zone,
            ),
            aging = MoneyAnalyticsRollup.inventoryAging(items, now, zone),
            timeOnMarket = MoneyAnalyticsRollup.timeOnMarket(items, sales, now, zone),
            sourceRoi = SourceRoiRollup.bySource(items, sales, sources),
            profitRows = MoneyAnalyticsRollup.itemProfitRows(items, sales),
            expenses = expenseRows,
            trips = trips,
            expensesThisMonth = Money.sum(expenseRows.filter { it.spentOn >= expenseMonthStart }) {
                it.amount
            },
            // Drives the empty state. Sales OR expenses count: a seller who has
            // only recorded costs so far still has a real (negative) P&L to see,
            // and showing them "no data yet" would hide it.
            hasAnyData = sales.isNotEmpty() ||
                expenseRows.isNotEmpty() ||
                items.isNotEmpty() ||
                trips.isNotEmpty(),
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

    /** @param onSaved invoked only on a durable outcome, so the sheet can close. */
    fun saveTrip(draft: TripDraft, onSaved: () -> Unit) {
        viewModelScope.launch {
            when (val outcome = mileage.save(draft)) {
                is MileageRepository.Outcome.Saved -> {
                    _notice.value = "Trip logged."
                    onSaved()
                }
                is MileageRepository.Outcome.Queued -> {
                    // The state this feature exists for. A trip is entered in a
                    // car park, so "saved offline" is the NORMAL outcome, not the
                    // exceptional one -- and saying "failed" would send the
                    // seller away to re-enter something already recorded.
                    _notice.value = "Logged offline — it'll sync when you're back online."
                    onSaved()
                }
                is MileageRepository.Outcome.Failed -> _notice.value = outcome.message
            }
        }
    }

    fun deleteTrip(id: String) {
        viewModelScope.launch {
            when (val outcome = mileage.delete(id)) {
                is MileageRepository.Outcome.Failed -> _notice.value = outcome.message
                is MileageRepository.Outcome.Queued ->
                    _notice.value = "Removed — the change will sync when you're back online."
                is MileageRepository.Outcome.Saved -> _notice.value = "Trip removed."
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
    suspend fun draftFor(id: String): ExpenseDraft? = db.expenses().byId(id)?.let { ExpenseDraft.from(it) }
}
