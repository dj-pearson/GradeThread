package com.gradethread.app.analytics

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1368: the analytics tab.
 *
 * Room-backed and reactive, and every figure on screen is computed by
 * [AnalyticsRollup] on this device (AC3). The only thing that leaves is the
 * optional AI narrative, and it takes finished numbers rather than data.
 */
@HiltViewModel
class AnalyticsViewModel @Inject constructor(
    db: GradeThreadDb,
    private val narratives: AnalyticsNarrativeService,
) : ViewModel() {

    data class State(
        val range: AnalyticsRange = AnalyticsRange.Days(90),
        val gradedCount: Int = 0,
        val averageGrade: Double? = null,
        val gradeDistribution: List<GradeBucket> = emptyList(),
        val topBrands: List<BrandProfit> = emptyList(),
        val sellThrough: List<SellThroughRow> = emptyList(),
        val inventoryValue: List<StatusValue> = emptyList(),
        val roiBuckets: List<RoiBucket> = emptyList(),
        val pnl: PeriodPnL = PeriodPnL.EMPTY,
        val overallSellThrough: Double? = null,
        val itemCount: Int = 0,
    ) {
        val hasAnything: Boolean get() = itemCount > 0
        val inventoryTotal: Double get() = inventoryValue.sumOf { it.value }
    }

    data class NarrativeState(
        val generating: Boolean = false,
        val narrative: AnalyticsNarrative? = null,
        val errorMessage: String? = null,
    )

    private val range = MutableStateFlow<AnalyticsRange>(AnalyticsRange.Days(90))

    private val _narrative = MutableStateFlow(NarrativeState())
    val narrative: StateFlow<NarrativeState> = _narrative.asStateFlow()

    val state: StateFlow<State> = combine(
        db.items().observeAll(),
        db.sales().observeAll(),
        range,
    ) { items, sales, chosen ->
        // `now` is read once per recomputation rather than per helper, so every
        // panel on screen is scoped to the SAME window. Reading it inside each
        // rollup would let a slow frame put two charts on different days.
        val nowMs = System.currentTimeMillis()
        val since = chosen.startMs(nowMs)
        val roi = AnalyticsRollup.gradingRoiBuckets(items, sales, since)
        State(
            range = chosen,
            gradedCount = AnalyticsRollup.gradedCount(items),
            averageGrade = AnalyticsRollup.averageGrade(items),
            gradeDistribution = AnalyticsRollup.gradeDistribution(items),
            topBrands = AnalyticsRollup.topBrandsByProfit(items, sales, since),
            sellThrough = AnalyticsRollup.sellThroughByBrand(items),
            inventoryValue = AnalyticsRollup.inventoryValueByStatus(items),
            roiBuckets = roi,
            pnl = AnalyticsRollup.periodPnL(items, sales, since),
            overallSellThrough = AnalyticsRollup.overallSellThroughRate(items),
            itemCount = items.size,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    fun setRange(value: AnalyticsRange) {
        if (value == range.value) return
        range.value = value
        // A new window means the old summary describes a period nobody is
        // looking at any more. Keeping it would be worse than showing none.
        _narrative.value = NarrativeState()
        Telemetry.event("analytics.range_changed", mapOf("range" to value.label))
    }

    fun setCustomRange(days: Int) = setRange(AnalyticsRange.custom(days))

    /**
     * Ask the server to narrate the numbers we already computed.
     *
     * On demand only, never on load: it spends one of the account's AI actions,
     * and spending someone's quota because they opened a tab is not a thing to
     * do to them.
     */
    fun generateNarrative() {
        if (_narrative.value.generating) return
        val current = state.value
        _narrative.value = NarrativeState(generating = true)
        Telemetry.event("analytics.narrative_requested", mapOf("range" to current.range.label))
        viewModelScope.launch {
            val request = narratives.request(
                range = current.range,
                pnl = current.pnl,
                sellThroughRate = current.overallSellThrough,
                roiLift = AnalyticsRollup.headlineRoiLift(current.roiBuckets),
                topBrand = current.topBrands.firstOrNull()?.brand,
            )
            _narrative.value = runCatching { narratives.generate(request) }
                .fold(
                    onSuccess = { NarrativeState(narrative = it) },
                    onFailure = {
                        NarrativeState(errorMessage = narratives.failureMessage(it))
                    },
                )
        }
    }

    fun dismissNarrativeError() {
        _narrative.value = _narrative.value.copy(errorMessage = null)
    }
}
