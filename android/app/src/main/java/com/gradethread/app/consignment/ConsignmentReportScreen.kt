package com.gradethread.app.consignment

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.R
import com.gradethread.app.money.Money
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1372 AC3: what each consignor is owed.
 *
 * Items and sales come from Room, so the money math works offline; only the
 * consignor NAMES need the network, and a failure there leaves the last list
 * in place rather than blanking the report.
 */
@HiltViewModel
class ConsignmentReportViewModel @Inject constructor(db: GradeThreadDb, private val service: ConsignorProviding) :
    ViewModel() {

    data class State(
        val rows: List<ConsignmentReportRow> = emptyList(),
        val consignorCount: Int = 0,
        val unsoldConsigned: Int = 0,
        val loading: Boolean = false,
        val errorMessage: String? = null,
    ) {
        val totalOwed: Double get() = ConsignmentReport.totalOwed(rows)
        val totalYourCut: Double get() = ConsignmentReport.totalYourCut(rows)
        val emptyMessage: String
            get() = ConsignmentReport.emptyMessage(consignorCount, unsoldConsigned)
    }

    private val consignors = MutableStateFlow<List<Consignor>>(emptyList())
    private val loading = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)

    val state: StateFlow<State> = combine(
        db.items().observeAll(),
        db.sales().observeAll(),
        consignors,
        loading,
        error,
    ) { items, sales, people, isLoading, errorMessage ->
        State(
            rows = ConsignmentReport.compute(items, sales, people),
            consignorCount = people.size,
            unsoldConsigned = ConsignmentReport.unsoldConsignedCount(items, sales),
            loading = isLoading,
            errorMessage = errorMessage,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    fun load() {
        if (loading.value) return
        loading.value = true
        error.value = null
        viewModelScope.launch {
            runCatching { service.list() }
                .onSuccess { consignors.value = it }
                .onFailure {
                    error.value = "Couldn't load your consignors, so names may be missing."
                }
            loading.value = false
        }
    }

    fun dismissError() {
        error.value = null
    }
}

@Composable
fun ConsignmentReportScreen(onClose: () -> Unit = {}, viewModel: ConsignmentReportViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    ConsignmentReportContent(
        state = state,
        onClose = onClose,
        onRetry = viewModel::load,
    )
}

/**
 * Who is owed what, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE FIGURES ON THIS SCREEN ARE OWED TO SOMEONE ELSE. Everywhere else a
 * layout regression misreports the seller's own money to the seller. Here it
 * misreports what a CONSIGNOR is owed, to the person who has to pay them - and
 * the split between `consignorPayout` and `yourCut` is the whole point of the
 * row. Two columns swapping places is a plausible regression and an ugly
 * conversation.
 *
 * `load` reaches this function as onRetry rather than staying with the wrapper's
 * LaunchedEffect: it is BOTH, and the error state's retry button is a thing a
 * person presses. Leaving it out would have made that button dead in every
 * capture - which is how the first attempt at this extraction failed, and it
 * failed loudly rather than silently only because the body still named
 * `viewModel`.
 */
@Composable
fun ConsignmentReportContent(
    state: ConsignmentReportViewModel.State,
    modifier: Modifier = Modifier,
    onClose: () -> Unit = {},
    onRetry: () -> Unit = {},
) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(
            stringResource(R.string.consignment_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            // Naming what's excluded, because a consignor will ask.
            stringResource(R.string.consignment_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.consignment_heads_up), it, tone = InfoTone.Warning)
        }

        if (state.rows.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().cardStyle(),
                verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
            ) {
                Text(
                    stringResource(R.string.consignment_total_owed, Money.format(state.totalOwed)),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(
                        R.string.consignment_you_keep,
                        Money.format(state.totalYourCut),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (state.rows.isEmpty()) {
                item {
                    InfoCard(
                        stringResource(R.string.consignment_empty_title),
                        state.emptyMessage,
                    )
                }
            }
            items(state.rows, key = { it.consignorId }) { row -> ReportCard(row) }
        }

        BrandSecondaryButton(
            text = if (state.loading) {
                stringResource(R.string.common_refreshing)
            } else {
                stringResource(R.string.common_refresh)
            },
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        ) { onRetry() }
        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { onClose() }
    }
}

@Composable
private fun ReportCard(row: ConsignmentReportRow) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                row.consignorName,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            Text(
                Money.format(row.consignorPayout),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            pluralStringResource(
                R.plurals.consignment_row_summary,
                row.itemsSold,
                row.itemsSold,
                Money.format(row.grossRevenue),
                Money.format(row.fees),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            // The three numbers side by side, so the arithmetic is checkable
            // rather than something the seller has to trust.
            stringResource(
                R.string.consignment_row_net,
                Money.format(row.netProceeds),
                Money.format(row.yourCut),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
