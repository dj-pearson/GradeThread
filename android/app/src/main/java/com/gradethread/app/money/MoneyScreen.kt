package com.gradethread.app.money

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.ui.components.BarChart
import com.gradethread.app.ui.components.BarDatum
import com.gradethread.app.ui.components.GroupedBarChart
import com.gradethread.app.ui.theme.Spacing
import java.time.Instant
import java.time.ZoneId
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

    var sheetDraft by remember { mutableStateOf<ExpenseDraft?>(null) }
    val sortedRows = remember(state.profitRows, sort) {
        MoneyAnalyticsRollup.sortProfitRows(state.profitRows, sort)
    }

    LazyColumn(modifier.fillMaxSize()) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.money_money), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = viewModel::refresh, enabled = !refreshing) {
                    Text(
                        stringResource(
                            if (refreshing) R.string.common_refreshing else R.string.common_refresh,
                        ),
                    )
                }
            }
        }

        refreshError?.let { message ->
            item { Banner(message, onDismiss = viewModel::dismissRefreshError) }
        }
        notice?.let { message ->
            item { Banner(message, onDismiss = viewModel::dismissNotice) }
        }

        // ── KPI row ──────────────────────────────────────────────────────────
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                KpiTile(
                    label = stringResource(R.string.money_revenue_mo),
                    value = Money.format(state.metrics.revenueThisMonth),
                    modifier = Modifier.weight(1f),
                )
                KpiTile(
                    label = stringResource(R.string.money_net_profit_mo),
                    value = Money.format(state.metrics.netProfitThisMonth),
                    modifier = Modifier.weight(1f),
                )
                KpiTile(
                    label = stringResource(R.string.money_roi_mo),
                    // "—" rather than 0% when no cost basis is recorded.
                    value = Money.formatPercent(state.metrics.roiThisMonth),
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
            val agingItem = stringResource(R.string.money_aging_spoken_item)
            Panel(stringResource(R.string.money_aging_title)) {
                BarChart(
                    bars = state.aging.map { BarDatum(it.label, it.count.toDouble()) },
                    description = stringResource(
                        R.string.money_aging_spoken,
                        state.aging.joinToString(", ") {
                            agingItem.format(it.label, it.count, Money.formatCompact(it.value))
                        },
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
                onRetry = viewModel::loadEquity,
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
                        onClick = { viewModel.setSort(option) },
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
                    onDelete = { viewModel.deleteExpense(expense.id) },
                )
                HorizontalDivider()
            }
        }
    }

    sheetDraft?.let { draft ->
        ExpenseFormSheet(
            initial = draft,
            onDismiss = { sheetDraft = null },
            onSave = { edited -> viewModel.saveExpense(edited) { sheetDraft = null } },
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
private fun KpiTile(label: String, value: String, modifier: Modifier = Modifier) {
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
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

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
private fun formatDate(epochMs: Long, locale: Locale = Locale.getDefault()): String =
    runCatching {
        Instant.ofEpochMilli(epochMs)
            // US-2339: EXPENSE_ZONE, not the device zone. A row shown as
            // the 11th while the server holds the 12th is the same
            // off-by-one the sync used to write back.
            .atZone(ExpenseDraft.EXPENSE_ZONE)
            .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
    }.getOrElse { "—" }
