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
 * Replaces the `SectionPlaceholder` this destination rendered. Every panel reads
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
                Text("Money", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = viewModel::refresh, enabled = !refreshing) {
                    Text(if (refreshing) "Refreshing…" else "Refresh")
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
                    label = "Revenue (mo)",
                    value = Money.format(state.metrics.revenueThisMonth),
                    modifier = Modifier.weight(1f),
                )
                KpiTile(
                    label = "Net profit (mo)",
                    value = Money.format(state.metrics.netProfitThisMonth),
                    modifier = Modifier.weight(1f),
                )
                KpiTile(
                    label = "ROI (mo)",
                    // "—" rather than 0% when no cost basis is recorded.
                    value = Money.formatPercent(state.metrics.roiThisMonth),
                    modifier = Modifier.weight(1f),
                )
            }
        }
        item {
            Text(
                "Operating expenses this month: ${Money.format(state.expensesThisMonth)}. " +
                    "Net profit is before expenses.",
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
            Panel("Revenue, last 6 months") {
                BarChart(
                    bars = state.metrics.monthlyRevenue.map { BarDatum(it.label, it.revenue) },
                    description = "Revenue by month: " + state.metrics.monthlyRevenue
                        .joinToString(", ") { "${it.label} ${Money.formatCompact(it.revenue)}" },
                )
            }
        }

        // ── Cash flow ────────────────────────────────────────────────────────
        item {
            Panel("Cash flow — in vs out") {
                GroupedBarChart(
                    labels = state.cashFlow.map { it.label },
                    seriesA = state.cashFlow.map { it.revenue },
                    // Money out is expenses PLUS the cost basis of what sold —
                    // showing expenses alone would make a month that bought
                    // heavily look profitable.
                    seriesB = state.cashFlow.map { it.expenses + it.costBasis },
                    description = "Cash flow by month: " + state.cashFlow.joinToString(", ") {
                        "${it.label} net ${Money.formatCompact(it.net)}"
                    },
                )
                state.cashFlow.lastOrNull()?.let { current ->
                    Text(
                        "This month: in ${Money.format(current.revenue)}, " +
                            "out ${Money.format(current.expenses + current.costBasis)}, " +
                            "net ${Money.format(current.net)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = Spacing.xxs),
                    )
                }
            }
        }

        // ── Inventory aging ──────────────────────────────────────────────────
        item {
            Panel("Inventory aging — capital tied up") {
                BarChart(
                    bars = state.aging.map { BarDatum(it.label, it.count.toDouble()) },
                    description = "Inventory aging: " + state.aging.joinToString(", ") {
                        "${it.label}, ${it.count} items, ${Money.formatCompact(it.value)}"
                    },
                )
                state.aging.lastOrNull()?.takeIf { it.count > 0 }?.let { oldest ->
                    Text(
                        "${oldest.count} items held 60+ days " +
                            "(${Money.format(oldest.value)} of cost basis).",
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
                Panel("Time on market") {
                    Text(
                        "Average ${state.timeOnMarket.averageDays} days to sell " +
                            "across ${state.timeOnMarket.soldCount} sales.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    BarChart(
                        bars = state.timeOnMarket.distribution.map {
                            BarDatum(it.label, it.count.toDouble())
                        },
                        description = "Days to sell: " + state.timeOnMarket.distribution
                            .joinToString(", ") { "${it.label}, ${it.count}" },
                        modifier = Modifier.padding(top = Spacing.xs),
                    )
                }
            }
        }

        // ── ROI by source ────────────────────────────────────────────────────
        if (state.sourceRoi.isNotEmpty()) {
            item { PanelHeader("ROI by source") }
            items(state.sourceRoi, key = { it.sourceId ?: "__none__" }) { row ->
                SourceRoiRowView(row)
                HorizontalDivider()
            }
        }

        // ── Per-item P&L ─────────────────────────────────────────────────────
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Profit by item",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onOpenSales) { Text("All sales") }
                // US-1365: the "did I actually get paid" question sits next to
                // the sales it is about, not in a settings screen.
                TextButton(onClick = onOpenPayouts) { Text("Payouts") }
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
                    "No completed sales yet — refunded and cancelled orders don't count here.",
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
                    "Expenses",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        sheetDraft = ExpenseDraft(spentOnMs = System.currentTimeMillis())
                    },
                ) { Text("Add") }
            }
        }
        if (state.expenses.isEmpty()) {
            item {
                Text(
                    "Record supplies, shipping and software so your P&L reflects what you " +
                        "actually spend.",
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
        Text("Nothing to report yet", style = MaterialTheme.typography.titleMedium)
        Text(
            "Once you catalog items and record sales, your revenue, profit, cash flow and " +
                "inventory aging appear here — computed on your device, so it works offline.",
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
        TextButton(onClick = onDismiss) { Text("Dismiss") }
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
    Card(modifier) {
        Column(Modifier.padding(Spacing.sm).semantics { contentDescription = "$label: $value" }) {
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
                "${row.soldCount}/${row.acquiredCount} sold · " +
                    "spend ${Money.format(row.spend)}",
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
                "${formatDate(row.saleDateMs)} · sold ${Money.format(row.revenue)} · " +
                    "cost ${Money.format(row.costBasis)}",
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
        TextButton(onClick = onDelete) { Text("Remove") }
    }
}

/** Medium-format local date — locale-aware, matching the currency formatting. */
private fun formatDate(epochMs: Long, locale: Locale = Locale.getDefault()): String =
    runCatching {
        Instant.ofEpochMilli(epochMs)
            .atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
    }.getOrElse { "—" }
