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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.ui.theme.Spacing
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
@Composable
fun SalesScreen(
    onOpenItem: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: SalesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val refreshError by viewModel.refreshError.collectAsStateWithLifecycle()

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Sales", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = viewModel::refresh, enabled = !refreshing) {
                Text(if (refreshing) "Refreshing…" else "Refresh")
            }
        }

        Text(
            "${state.completedCount} completed · " +
                "${Money.format(state.realizedRevenue)} revenue · " +
                "${Money.format(state.realizedProfit)} net",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .padding(horizontal = Spacing.md)
                .semantics {
                    contentDescription = "${state.completedCount} completed sales, " +
                        "${Money.format(state.realizedRevenue)} revenue, " +
                        "${Money.format(state.realizedProfit)} net profit"
                },
        )
        if (state.excludedCount > 0) {
            Text(
                // Named explicitly: a seller who sees 12 rows and a total for 10
                // needs to know WHY, or they assume the total is broken.
                "${state.excludedCount} refunded, cancelled or pending — shown below, " +
                    "excluded from totals.",
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
                TextButton(onClick = viewModel::dismissRefreshError) { Text("Dismiss") }
            }
        }

        HorizontalDivider()

        if (state.rows.isEmpty()) {
            Column(Modifier.fillMaxSize().padding(Spacing.xl)) {
                Text("No sales yet", style = MaterialTheme.typography.titleMedium)
                Text(
                    "When an item sells, it lands here with its realized profit — sale price " +
                        "minus fees, shipping and what the item cost you.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.rows, key = { it.saleId }) { row ->
                    SaleRowView(row) { onOpenItem(row.itemId) }
                    HorizontalDivider()
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
                "${formatDate(row.saleDateMs)} · sold ${Money.format(row.revenue)} · " +
                    "fees ${Money.format(row.fees)} · cost ${Money.format(row.costBasis)}",
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
                StatusChip(row.statusLabel)
            }
        }
    }
}

@Composable
private fun StatusChip(text: String) {
    val tone = when (text) {
        "Refunded", "Cancelled" -> Color(0xFFE94560)
        "Pending" -> Color(0xFFF59E0B)
        else -> Color(0xFF6B7280)
    }
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = tone,
        modifier = Modifier
            .background(tone.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = Spacing.xs, vertical = 2.dp),
    )
}

private fun formatDate(epochMs: Long, locale: Locale = Locale.getDefault()): String =
    runCatching {
        Instant.ofEpochMilli(epochMs)
            .atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
    }.getOrElse { "—" }
