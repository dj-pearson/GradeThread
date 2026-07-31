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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import java.text.DateFormat
import java.util.Date

/**
 * US-1365: what eBay actually deposited, against what the books say.
 */
@Composable
fun PayoutReconciliationScreen(
    onOpenItem: (String) -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: PayoutReconciliationViewModel = hiltViewModel(),
) {
    // No load-on-appear: the state flow is Room-backed, so it already carries
    // the cached comparison on the first frame and re-emits after every sync.
    val state by viewModel.state.collectAsState()

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Payouts", style = MaterialTheme.typography.titleLarge)
        Text(
            PayoutReconciliation.summary(state.reconciled),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            // The offline promise, stated: this screen is built from synced
            // rows, so it works on a train and updates when the next pull lands.
            "Read from what's already on this device. Sync to check for new deposits.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (state.mismatches.isNotEmpty()) {
                item {
                    Text(
                        "Don't match (${state.mismatches.size})",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                items(state.mismatches, key = { "bad-${it.payout.id}" }) { entry ->
                    PayoutCard(entry, onOpenItem)
                }
            }

            if (state.awaitingPayout.isNotEmpty()) {
                item {
                    Text(
                        "Sold, not paid out yet (${state.awaitingPayout.size})",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = Spacing.sm),
                    )
                }
                items(state.awaitingPayout, key = { "await-${it.id}" }) { sale ->
                    SaleLine(sale, "waiting on eBay", onOpenItem)
                }
            }

            if (state.unknownPayout.isNotEmpty()) {
                item {
                    Text(
                        "Payout not synced yet (${state.unknownPayout.size})",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = Spacing.sm),
                    )
                }
                items(state.unknownPayout, key = { "unknown-${it.id}" }) { sale ->
                    // Not "missing money": the deposit just hasn't reached this
                    // device, which is a shrug rather than a support ticket.
                    SaleLine(sale, "deposit not on this device yet", onOpenItem)
                }
            }

            item {
                Text(
                    "Matched (${state.matched.size})",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            if (state.matched.isEmpty()) {
                item { Hint("Nothing reconciled yet.") }
            }
            items(state.matched, key = { "ok-${it.payout.id}" }) { entry ->
                PayoutCard(entry, onOpenItem)
            }
        }

        BrandSecondaryButton(
            text = if (state.refreshing) "Syncing…" else "Sync and re-check",
            enabled = !state.refreshing,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.syncAndRefresh() }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun PayoutCard(
    entry: PayoutReconciliation.Reconciled,
    onOpenItem: (String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                Money.format(entry.payoutCents / 100.0),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            entry.payout.payoutDate?.let {
                Text(
                    DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            PayoutReconciliation.deltaLabel(entry),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (entry.matched) FontWeight.Normal else FontWeight.SemiBold,
            color = if (entry.matched) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.error
            },
        )
        Text(
            "${entry.saleCount} ${if (entry.saleCount == 1) "sale" else "sales"} · " +
                "recorded ${Money.format(entry.recordedCents / 100.0)}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PayoutReconciliation.estimateNote(entry)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // The related sales, so a mismatch points at something actionable
        // rather than at a number.
        entry.sales.take(5).forEach { sale ->
            SaleLine(sale, Money.format(sale.salePrice), onOpenItem)
        }
        if (entry.sales.size > 5) {
            Hint("…and ${entry.sales.size - 5} more.")
        }
    }
}

@Composable
private fun SaleLine(
    sale: SaleEntity,
    note: String,
    onOpenItem: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            // Tapping through to the item is the point: a mismatch is only
            // useful if it leads somewhere you can act.
            .clickable { onOpenItem(sale.inventoryItemId) }
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            sale.buyerUsername ?: sale.platformOrderId ?: sale.id.take(8),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        Text(
            note,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
