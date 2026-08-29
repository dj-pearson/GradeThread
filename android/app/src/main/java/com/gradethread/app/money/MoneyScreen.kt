package com.gradethread.app.money

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.R
import com.gradethread.app.ui.components.BarChart
import com.gradethread.app.ui.components.BarDatum
import com.gradethread.app.ui.components.GroupedBarChart
import com.gradethread.app.ui.theme.ContentMaxWidth
import com.gradethread.app.ui.theme.Spacing
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * US-1363/US-1364: the Money tab (iOS `MoneyView`).
 *
 * Replaces the `SectionPlaceholder` this destination rendered (that scaffold was
 * deleted in US-2792). Every panel reads
 * from the pure rollups, so this file contains NO arithmetic — that split is what
 * makes the figures unit-testable and is why the iOS surface it mirrors keeps its
 * math in `MoneyAnalyticsRollup`.
 */
// US-2910 AC3. PullToRefreshBox is still ExperimentalMaterial3Api on
// Compose BOM 2025.04.00 - the same opt-in InventoryListScreen carries.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoneyScreen(
    onOpenSales: () -> Unit,
    onOpenPayouts: () -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: MoneyViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val sort by viewModel.sort.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val refreshError by viewModel.refreshError.collectAsStateWithLifecycle()
    val notice by viewModel.notice.collectAsStateWithLifecycle()
    // US-2491: server-computed, so it is loaded once on open rather than
    // recomputed with the Room-backed panels around it.
    val equity by viewModel.equity.collectAsStateWithLifecycle()
    val equityTrend by viewModel.equityTrend.collectAsStateWithLifecycle()
    val equityLoading by viewModel.equityLoading.collectAsStateWithLifecycle()
    val equityError by viewModel.equityError.collectAsStateWithLifecycle()
    androidx.compose.runtime.LaunchedEffect(Unit) { viewModel.loadEquity() }
    MoneyContent(
        ui = MoneyUiState(
            state = state,
            sort = sort,
            refreshing = refreshing,
            refreshError = refreshError,
            notice = notice,
            equity = equity,
            equityTrend = equityTrend,
            equityLoading = equityLoading,
            equityError = equityError,
        ),
        actions = MoneyActions(
            onRefresh = viewModel::refresh,
            onDismissRefreshError = viewModel::dismissRefreshError,
            onDismissNotice = viewModel::dismissNotice,
            onRetryEquity = viewModel::loadEquity,
            onSetSort = viewModel::setSort,
            onDeleteExpense = viewModel::deleteExpense,
            onSaveExpense = viewModel::saveExpense,
        ),
        onOpenSales = onOpenSales,
        onOpenPayouts = onOpenPayouts,
        modifier = modifier,
    )
}

/**
 * US-2902 AC3: the nine flows this screen collects, as one value.
 *
 * WHY AN AGGREGATE AND NOT NINE PARAMETERS. MoneyViewModel exposes nine
 * separate StateFlows rather than one state object, which is fine for the
 * ViewModel and unworkable for a content function: nine of those plus seven
 * callbacks plus two navigation lambdas is a signature nobody reads, and
 * detekt's LongParameterList would refuse it anyway.
 *
 * The aggregate is built in the wrapper from the collected values, so the
 * ViewModel's own API is untouched. @Immutable is honest here because every
 * field is a read-only snapshot of a flow.
 */
@Immutable
data class MoneyUiState(
    val state: MoneyViewModel.State,
    val sort: ItemProfitSort,
    val refreshing: Boolean,
    val refreshError: String?,
    val notice: String?,
    val equity: EquitySummary?,
    val equityTrend: EquityTrend?,
    val equityLoading: Boolean,
    val equityError: String?,
)

/** Everything this screen can do, with defaults so a golden needs none of it. */
@Immutable
data class MoneyActions(
    val onRefresh: () -> Unit = {},
    val onDismissRefreshError: () -> Unit = {},
    val onDismissNotice: () -> Unit = {},
    val onRetryEquity: () -> Unit = {},
    val onSetSort: (ItemProfitSort) -> Unit = {},
    val onDeleteExpense: (String) -> Unit = {},
    val onSaveExpense: (ExpenseDraft, () -> Unit) -> Unit = { _, _ -> },
)

/**
 * The money screen with no ViewModel in it.
 *
 * The nine values are unpacked to locals immediately below rather than
 * threaded through as ui.state, ui.sort and so on. That keeps the body
 * identical to what it was before the split, which is the point: a refactor
 * that also rewrites three hundred lines of layout is a refactor whose diff
 * nobody can check.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MoneyContent(
    ui: MoneyUiState,
    actions: MoneyActions,
    onOpenSales: () -> Unit,
    onOpenPayouts: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = ui.state
    val sort = ui.sort
    val refreshing = ui.refreshing
    val refreshError = ui.refreshError
    val notice = ui.notice
    val equity = ui.equity
    val equityTrend = ui.equityTrend
    val equityLoading = ui.equityLoading
    val equityError = ui.equityError

    var sheetDraft by remember { mutableStateOf<ExpenseDraft?>(null) }
    val sortedRows = remember(state.profitRows, sort) {
        MoneyAnalyticsRollup.sortProfitRows(state.profitRows, sort)
    }

    // US-2910 AC3: the GESTURE, not just the button.
    //
    // The Refresh control above has been here since this screen was
    // built and the view model's refresh() is real. What was missing
    // is the pull - what a thumb reaches for on a list, and the only
    // affordance available one-handed in a shop. Inventory was the
    // only sync-backed list of five that had it.
    //
    // The whole list is inside, so a screen showing nothing is still
    // pullable - that is the state a seller pulls from.
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = actions.onRefresh,
        // detekt ModifierParameter: the caller's modifier belongs on the
        // ROOT-most layout, and after this wrap that is the box, not the list.
        modifier = modifier.fillMaxSize(),
    ) {
        // US-2905 AC2/AC4: the same bound inventory carries. Here the list IS
        // the whole screen - there is no chrome above the box - so the bound
        // goes on the LazyColumn. Before fillMaxSize, never after: fillMaxSize
        // sets the minimum width too, which makes a later bound a silent no-op.
        LazyColumn(
            Modifier
                .widthIn(max = ContentMaxWidth)
                .fillMaxSize(),
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.money_money),
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = actions.onRefresh, enabled = !refreshing) {
                        Text(
                            stringResource(
                                if (refreshing) R.string.common_refreshing else R.string.common_refresh,
                            ),
                        )
                    }
                }
            }

            refreshError?.let { message ->
                item { Banner(message, onDismiss = actions.onDismissRefreshError) }
            }
            notice?.let { message ->
                item { Banner(message, onDismiss = actions.onDismissNotice) }
            }

            // ── KPI row ──────────────────────────────────────────────────────────
            item {
                val revenue = Money.format(state.metrics.revenueThisMonth)
                val netProfit = Money.format(state.metrics.netProfitThisMonth)
                // "—" rather than 0% when no cost basis is recorded.
                val roi = Money.formatPercent(state.metrics.roiThisMonth)
                // US-2979: ONE size for the row, chosen by its longest value.
                // Sizing each tile independently is what the first fix did, and
                // it left "124%" at full size beside two shrunken dollar
                // figures - which reads as a mistake rather than as a fit.
                val valueSize = kpiFontSize(
                    maxOf(revenue.length, netProfit.length, roi.length),
                )
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    KpiTile(
                        label = stringResource(R.string.money_revenue_mo),
                        value = revenue,
                        valueSize = valueSize,
                        modifier = Modifier.weight(1f),
                    )
                    KpiTile(
                        label = stringResource(R.string.money_net_profit_mo),
                        value = netProfit,
                        valueSize = valueSize,
                        modifier = Modifier.weight(1f),
                    )
                    KpiTile(
                        label = stringResource(R.string.money_roi_mo),
                        value = roi,
                        valueSize = valueSize,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            item {
                Text(
                    stringResource(
                        R.string.money_expenses_this_month,
                        Money.format(state.expensesThisMonth),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xxs),
                )
            }

            if (!state.hasAnyData) {
                item { EmptyState() }
                return@LazyColumn
            }

            // ── Revenue chart ────────────────────────────────────────────────────
            item {
                val revenueItem = stringResource(R.string.money_revenue_spoken_item)
                Panel(stringResource(R.string.money_revenue_title)) {
                    BarChart(
                        bars = state.metrics.monthlyRevenue.map { BarDatum(it.label, it.revenue) },
                        description = stringResource(
                            R.string.money_revenue_spoken,
                            state.metrics.monthlyRevenue.joinToString(", ") {
                                revenueItem.format(it.label, Money.formatCompact(it.revenue))
                            },
                        ),
                    )
                }
            }

            // ── Cash flow ────────────────────────────────────────────────────────
            item {
                // The per-entry template is read ONCE, here, and formatted inside
                // the join: `joinToString`'s lambda is not a composable scope, so a
                // stringResource call inside it would not compile.
                val cashFlowItem = stringResource(R.string.money_cash_flow_spoken_item)
                Panel(stringResource(R.string.money_cash_flow_title)) {
                    GroupedBarChart(
                        labels = state.cashFlow.map { it.label },
                        seriesA = state.cashFlow.map { it.revenue },
                        // Money out is expenses PLUS the cost basis of what sold —
                        // showing expenses alone would make a month that bought
                        // heavily look profitable.
                        seriesB = state.cashFlow.map { it.expenses + it.costBasis },
                        description = stringResource(
                            R.string.money_cash_flow_spoken,
                            state.cashFlow.joinToString(", ") {
                                cashFlowItem.format(it.label, Money.formatCompact(it.net))
                            },
                        ),
                    )
                    state.cashFlow.lastOrNull()?.let { current ->
                        Text(
                            stringResource(
                                R.string.money_this_month_summary,
                                Money.format(current.revenue),
                                Money.format(current.expenses + current.costBasis),
                                Money.format(current.net),
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = Spacing.xxs),
                        )
                    }
                }
            }

            // ── Inventory aging ──────────────────────────────────────────────────
            item {
                // US-2977: built with map rather than inside joinToString, and the
                // difference is not style. pluralStringResource is @Composable, and
                // joinToString's transform is NOT an inline lambda — it cannot host a
                // composable call. map IS inline, so the composable context carries
                // into it. This was the only one of the 63 plural candidates whose
                // blocker was structural rather than a wording question.
                val agingParts = state.aging.map { bucket ->
                    pluralStringResource(
                        R.plurals.money_aging_spoken_item,
                        bucket.count,
                        bucket.label,
                        bucket.count,
                        Money.formatCompact(bucket.value),
                    )
                }
                Panel(stringResource(R.string.money_aging_title)) {
                    BarChart(
                        bars = state.aging.map { BarDatum(it.label, it.count.toDouble()) },
                        description = stringResource(
                            R.string.money_aging_spoken,
                            agingParts.joinToString(", "),
                        ),
                    )
                    state.aging.lastOrNull()?.takeIf { it.count > 0 }?.let { oldest ->
                        Text(
                            pluralStringResource(
                                R.plurals.money_aging_oldest,
                                oldest.count,
                                oldest.count,
                                Money.format(oldest.value),
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(top = Spacing.xxs),
                        )
                    }
                }
            }

            // ── Time on market ───────────────────────────────────────────────────
            if (state.timeOnMarket.hasData) {
                item {
                    val daysToSellItem = stringResource(R.string.money_days_to_sell_spoken_item)
                    val averageDaysShown =
                        state.timeOnMarket.averageDays?.let { Math.round(it).toInt() } ?: 0
                    Panel(stringResource(R.string.money_time_on_market_title)) {
                        Text(
                            // The resource takes `%1$d` and averageDays is a
                            // nullable Double, so passing it straight through is
                            // not just a type error — it would throw
                            // IllegalFormatConversionException when the panel is
                            // drawn. `hasData` means soldCount > 0, so the elvis
                            // branch is unreachable in practice.
                            stringResource(
                                R.string.money_time_on_market_summary,
                                averageDaysShown,
                                state.timeOnMarket.soldCount,
                            ),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        BarChart(
                            bars = state.timeOnMarket.distribution.map {
                                BarDatum(it.label, it.count.toDouble())
                            },
                            description = stringResource(
                                R.string.money_days_to_sell_spoken,
                                state.timeOnMarket.distribution.joinToString(", ") {
                                    daysToSellItem.format(it.label, it.count)
                                },
                            ),
                            modifier = Modifier.padding(top = Spacing.xs),
                        )
                    }
                }
            }

            // ── ROI by source ────────────────────────────────────────────────────
            if (state.sourceRoi.isNotEmpty()) {
                item { PanelHeader(stringResource(R.string.money_roi_by_source)) }
                items(state.sourceRoi, key = { it.sourceId ?: "__none__" }) { row ->
                    SourceRoiRowView(row)
                    HorizontalDivider()
                }
            }

            // ── Per-item P&L ─────────────────────────────────────────────────────
            item {
                InventoryEquityCard(
                    summary = equity,
                    trend = equityTrend,
                    loading = equityLoading,
                    errorMessage = equityError,
                    onRetry = actions.onRetryEquity,
                )
            }
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.money_profit_by_item),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onOpenSales) { Text(stringResource(R.string.money_all_sales)) }
                    // US-1365: the "did I actually get paid" question sits next to
                    // the sales it is about, not in a settings screen.
                    TextButton(onClick = onOpenPayouts) { Text(stringResource(R.string.money_payouts)) }
                }
            }
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    ItemProfitSort.entries.forEach { option ->
                        FilterChip(
                            selected = option == sort,
                            onClick = { actions.onSetSort(option) },
                            label = { Text(option.label) },
                        )
                    }
                }
            }
            if (sortedRows.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.money_no_completed_sales),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(Spacing.md),
                    )
                }
            } else {
                items(sortedRows, key = { it.saleId }) { row ->
                    ItemProfitRowView(row)
                    HorizontalDivider()
                }
            }

            // ── Expenses (US-1364) ───────────────────────────────────────────────
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.money_expenses),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = {
                            sheetDraft = ExpenseDraft(spentOnMs = System.currentTimeMillis())
                        },
                    ) { Text(stringResource(R.string.money_add)) }
                }
            }
            if (state.expenses.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.money_expenses_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
                    )
                }
            } else {
                items(state.expenses, key = { it.id }) { expense ->
                    ExpenseRowView(
                        expense = expense,
                        onEdit = { sheetDraft = ExpenseDraft.from(expense) },
                        onDelete = { actions.onDeleteExpense(expense.id) },
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    sheetDraft?.let { draft ->
        ExpenseFormSheet(
            initial = draft,
            onDismiss = { sheetDraft = null },
            onSave = { edited -> actions.onSaveExpense(edited) { sheetDraft = null } },
        )
    }
}

@Composable
private fun EmptyState() {
    Column(Modifier.fillMaxWidth().padding(Spacing.xl)) {
        Text(stringResource(R.string.money_nothing_to_report_yet), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.money_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Banner(message: String, onDismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onDismiss) { Text(stringResource(R.string.money_dismiss)) }
    }
}

@Composable
private fun PanelHeader(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
    )
}

@Composable
private fun Panel(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Column(Modifier.padding(top = Spacing.xs)) { content() }
    }
}

@Composable
private fun KpiTile(label: String, value: String, valueSize: TextUnit, modifier: Modifier = Modifier) {
    val spoken = stringResource(R.string.money_tile_spoken, label, value)
    Card(modifier) {
        Column(Modifier.padding(Spacing.sm).semantics { contentDescription = spoken }) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                value,
                style = MaterialTheme.typography.titleMedium.copy(fontSize = valueSize),
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

/**
 * One pass, decided from the string length, and NOT from measuring.
 *
 * ⚠ THE MEASURE-AND-RETRY VERSION SHIPPED A WORSE BUG THAN THE ONE IT FIXED,
 * which is the whole reason this is written down. It rendered at the type scale,
 * dropped a step on didOverflowWidth, and gated drawing behind a `fits` flag so
 * the oversized frame was never painted. On a five-figure month the golden came
 * back with the Revenue tile EMPTY - the flag had not settled by capture. A
 * blank headline figure is worse than a wrapped one: a wrapped number is ugly
 * and still readable, a missing one tells the seller nothing and reads as a data
 * error.
 *
 * So the size is decided before layout and there is no gate left to fail.
 *
 * THE THRESHOLD IS MEASURED, NOT GUESSED. Three equal-width tiles in a 411dp row
 * leave about 104dp inside the card padding, and at titleMedium the value ran
 * out of room at eight characters - which is exactly how "$1,284.50" came to
 * render as "$1,284.5" then "0". Eight is the boundary because that is where it
 * broke.
 *
 * Truncation is deliberately not an option at any size: "$1,28…" is not a
 * smaller revenue figure, it is a wrong one.
 */
private fun kpiFontSize(longestValue: Int): TextUnit = when {
    longestValue <= KPI_CHARS_AT_FULL_SIZE -> 16.sp
    longestValue <= KPI_CHARS_AT_REDUCED_SIZE -> 12.sp
    else -> 10.sp
}

/** Where titleMedium ran out of tile: "$1,284.50" is 9 and it wrapped. */
private const val KPI_CHARS_AT_FULL_SIZE = 8

/** 12sp still fits a five-figure amount with cents ("$18,642.75" is 10). */
private const val KPI_CHARS_AT_REDUCED_SIZE = 11

@Composable
private fun SourceRoiRowView(row: SourceRoiRow) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.sourceName, style = MaterialTheme.typography.bodyMedium)
            Text(
                stringResource(
                    R.string.money_source_row_detail,
                    row.soldCount,
                    row.acquiredCount,
                    Money.format(row.spend),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column {
            Text(
                Money.format(row.netProfit),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (row.netProfit < 0) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
            Text(
                Money.formatPercent(row.roi),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ItemProfitRowView(row: ItemProfitRow) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
            Text(
                stringResource(
                    R.string.money_sale_row_detail,
                    formatDate(row.saleDateMs),
                    Money.format(row.revenue),
                    Money.format(row.costBasis),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column {
            Text(
                Money.format(row.netProfit),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (row.netProfit < 0) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
            Text(
                Money.formatPercent(row.roi),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ExpenseRowView(
    expense: com.gradethread.app.sync.db.ExpenseEntity,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onEdit)
            .padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                ExpenseDraft.labelFor(expense.category),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                listOfNotNull(formatDate(expense.spentOn), expense.expenseDescription)
                    .joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(Money.format(expense.amount), style = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = onDelete) { Text(stringResource(R.string.money_remove)) }
    }
}

/** Medium-format local date — locale-aware, matching the currency formatting. */
private fun formatDate(epochMs: Long, locale: Locale = Locale.getDefault()): String = runCatching {
    Instant.ofEpochMilli(epochMs)
        // US-2339: EXPENSE_ZONE, not the device zone. A row shown as
        // the 11th while the server holds the 12th is the same
        // off-by-one the sync used to write back.
        .atZone(ExpenseDraft.EXPENSE_ZONE)
        .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
}.getOrElse { "—" }
