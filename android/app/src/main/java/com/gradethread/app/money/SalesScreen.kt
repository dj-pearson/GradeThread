package com.gradethread.app.money

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.R
import com.gradethread.app.ui.text
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.statusAmber
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * US-1371: the sales list with per-item realized P&L (iOS `SalesView`).
 *
 * Two rules this screen exists to hold apart:
 *
 *  - the LIST shows every sale, including refunded and cancelled ones. Hiding
 *    them would make a seller's history disagree with their eBay account;
 *  - the TOTALS count only completed sales (00111), because a reversed order was
 *    never revenue.
 *
 * Both come from the same [SalePnL] helpers the Money tab uses, so the figure
 * here and the figure there can't diverge.
 */
// PullToRefreshBox is still ExperimentalMaterial3Api in Compose BOM
// 2025.04.00, the same opt-in InventoryListScreen carries.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SalesScreen(
    onOpenItem: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: SalesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val refreshError by viewModel.refreshError.collectAsStateWithLifecycle()

    SalesContent(
        state = state,
        refreshing = refreshing,
        refreshError = refreshError,
        actions = SalesActions(
            refresh = viewModel::refresh,
            dismissRefreshError = viewModel::dismissRefreshError,
            openItem = onOpenItem,
        ),
        modifier = modifier,
    )
}

/** Everything the sales list can do. Defaults are no-ops, so a golden passes none. */
@Immutable
data class SalesActions(
    val refresh: () -> Unit = {},
    val dismissRefreshError: () -> Unit = {},
    val openItem: (String) -> Unit = {},
)

/**
 * The sales list with no ViewModel attached (US-2902 AC3).
 *
 * `refreshing` and `refreshError` stay separate parameters rather than being
 * folded into a wrapper state: SalesViewModel.State is already a state object,
 * and nesting one inside another buys nothing but a longer path at every read
 * site in the body below.
 *
 * The layout is unchanged from the version inside SalesScreen - `summarySpoken`
 * moved in with it because pluralStringResource needs a composable scope - so
 * the extraction cannot have altered what a golden records.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SalesContent(
    state: SalesSummary,
    refreshing: Boolean,
    refreshError: String?,
    actions: SalesActions,
    modifier: Modifier = Modifier,
) {
    // Hoisted: `semantics { }` is not a composable scope. Spelled out for
    // TalkBack, since the visible line leans on separators to carry meaning.
    val summarySpoken = pluralStringResource(
        R.plurals.sales_summary_spoken,
        state.completedCount,
        state.completedCount,
        Money.format(state.realizedRevenue),
        Money.format(state.realizedProfit),
    )

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.sales_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = actions.refresh, enabled = !refreshing) {
                Text(
                    if (refreshing) {
                        stringResource(R.string.common_refreshing)
                    } else {
                        stringResource(R.string.common_refresh)
                    },
                )
            }
        }

        Text(
            pluralStringResource(
                R.plurals.sales_summary,
                state.completedCount,
                state.completedCount,
                Money.format(state.realizedRevenue),
                Money.format(state.realizedProfit),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .padding(horizontal = Spacing.md)
                .semantics { contentDescription = summarySpoken },
        )
        if (state.excludedCount > 0) {
            Text(
                // Named explicitly: a seller who sees 12 rows and a total for 10
                // needs to know WHY, or they assume the total is broken.
                pluralStringResource(
                    R.plurals.sales_excluded,
                    state.excludedCount,
                    state.excludedCount,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.md),
            )
        }

        refreshError?.let { message ->
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
                TextButton(onClick = actions.dismissRefreshError) {
                    Text(stringResource(R.string.common_dismiss))
                }
            }
        }

        HorizontalDivider()

        // US-2910 AC3: the GESTURE, not just the button.
        //
        // The Refresh button above has been here since this screen was built
        // and the view model's refresh() is real - what was missing is the pull,
        // which is what a thumb reaches for on a list and the only affordance
        // available one-handed in a shop. Inventory was the only sync-backed
        // list of five that had it.
        //
        // WRAPPED AROUND THE WHOLE CONDITIONAL, empty branch included. Wrapping
        // only the LazyColumn would leave the empty state un-pullable, which is
        // exactly the state a seller pulls from: they are looking at nothing and
        // want to know whether that is the truth or the network.
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = actions.refresh,
            modifier = Modifier.weight(1f),
        ) {
            if (state.rows.isEmpty()) {
                // fillMaxSize so the empty column still fills the pull area -
                // a short child would leave most of the screen unable to start
                // the gesture.
                Column(Modifier.fillMaxSize().padding(Spacing.xl)) {
                    Text(
                        stringResource(R.string.sales_empty_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        stringResource(R.string.sales_empty_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(state.rows, key = { it.saleId }) { row ->
                        SaleRowView(row) { actions.openItem(row.itemId) }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun SaleRowView(row: SaleRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
            Text(
                stringResource(
                    R.string.sales_row_detail,
                    formatDate(row.saleDateMs),
                    Money.format(row.revenue),
                    Money.format(row.fees),
                    Money.format(row.costBasis),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            if (row.countsTowardTotals) {
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
            } else {
                // No P&L figure for a reversed order — printing one would imply
                // money that never landed.
                StatusChip(row.status, row.statusLabel)
            }
        }
    }
}

@Composable
private fun StatusChip(status: String, label: UiMessage) {
    // US-2976: keyed on the WIRE status, not on the label. This used to match
    // the English words, so a translated label fell through to the neutral
    // grey and a refunded sale lost the only cue saying the money went back.
    val tone = when (status) {
        "refunded", "cancelled" -> MaterialTheme.colorScheme.error
        "pending" -> statusAmber()
        else -> Color(0xFF6B7280)
    }
    Text(
        text = label.text(),
        style = MaterialTheme.typography.labelSmall,
        color = tone,
        modifier = Modifier
            .background(tone.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = Spacing.xs, vertical = 2.dp),
    )
}

private fun formatDate(epochMs: Long, locale: Locale = Locale.getDefault()): String = runCatching {
    Instant.ofEpochMilli(epochMs)
        .atZone(ZoneId.systemDefault())
        .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
}.getOrElse { "—" }
