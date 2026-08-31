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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.ui.text
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

    // US-2414: any MIME type. Drive, Files and the mail apps all report a
    // downloaded CSV differently, and a strict filter hides the file the seller
    // is looking straight at.
    val picker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri -> uri?.let(viewModel::importCsv) }

    PayoutReconciliationContent(
        state,
        PayoutReconciliationActions(
            openItem = onOpenItem,
            // The picker stays in the wrapper. It needs an Activity result
            // registry, which a preview and a screenshot test do not have, so
            // the body only ever sees "the seller asked to import".
            pickCsv = { picker.launch(arrayOf("*/*")) },
            loadQueue = viewModel::loadQueue,
            runMatcher = viewModel::runMatcher,
            matchPayout = viewModel::matchPayout,
            dismissPayout = viewModel::dismissPayout,
            dismissSweep = viewModel::dismissSweep,
            dismissImportResult = viewModel::dismissImportResult,
            syncAndRefresh = viewModel::syncAndRefresh,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class PayoutReconciliationActions(
    val openItem: (String) -> Unit = {},
    val pickCsv: () -> Unit = {},
    val loadQueue: () -> Unit = {},
    val runMatcher: () -> Unit = {},
    val matchPayout: (String, String) -> Unit = { _, _ -> },
    val dismissPayout: (String) -> Unit = {},
    val dismissSweep: () -> Unit = {},
    val dismissImportResult: () -> Unit = {},
    val syncAndRefresh: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * The reconciliation screen with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE FOUR BUCKETS ARE FOUR DIFFERENT ANSWERS ABOUT A SELLER'S MONEY, and
 * three of them are not a problem:
 *
 *   mismatches     eBay paid a different amount than the books expected
 *   awaitingPayout sold, not paid yet - eBay holds it, nothing is wrong
 *   unknownPayout  paid, but the deposit has not synced to THIS device
 *   matched        agreed
 *
 * A bucket that renders under the wrong heading turns "eBay has not paid out
 * yet" into "money is missing", which is a support ticket and a bad afternoon.
 * The headings are part of the layout, so only a capture can see them.
 */
@Composable
fun PayoutReconciliationContent(
    state: PayoutReconciliationViewModel.State,
    actions: PayoutReconciliationActions,
    modifier: Modifier = Modifier,
) {
    val onOpenItem = actions.openItem
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.payouts_title), style = MaterialTheme.typography.titleLarge)
        Text(
            PayoutReconciliation.summary(state.reconciled).text(),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            // The offline promise, stated: this screen is built from synced
            // rows, so it works on a train and updates when the next pull lands.
            stringResource(R.string.payouts_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.common_that_didnt_work), it, tone = InfoTone.Error)
        }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (state.mismatches.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.payouts_mismatched, state.mismatches.size),
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
                        stringResource(R.string.payouts_awaiting, state.awaitingPayout.size),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = Spacing.sm),
                    )
                }
                items(state.awaitingPayout, key = { "await-${it.id}" }) { sale ->
                    SaleLine(sale, stringResource(R.string.payouts_waiting_on_ebay), onOpenItem)
                }
            }

            if (state.unknownPayout.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.payouts_unknown, state.unknownPayout.size),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = Spacing.sm),
                    )
                }
                items(state.unknownPayout, key = { "unknown-${it.id}" }) { sale ->
                    // Not "missing money": the deposit just hasn't reached this
                    // device, which is a shrug rather than a support ticket.
                    SaleLine(
                        sale,
                        stringResource(R.string.payouts_deposit_not_local),
                        onOpenItem,
                    )
                }
            }

            item {
                Text(
                    stringResource(R.string.payouts_matched, state.matched.size),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            if (state.matched.isEmpty()) {
                item { Hint(stringResource(R.string.payouts_empty)) }
            }
            items(state.matched, key = { "ok-${it.payout.id}" }) { entry ->
                PayoutCard(entry, onOpenItem)
            }
        }

        // US-2489: the SERVER matcher. Kept below the local comparison and
        // labelled, because that comparison works with no signal and this does
        // not — merging them would make one screen that is quietly wrong
        // offline.
        Text(
            stringResource(R.string.payouts_matcher_title),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            stringResource(R.string.payouts_matcher_help),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        val queue = state.queue
        if (queue == null) {
            BrandSecondaryButton(
                text = stringResource(R.string.payouts_matcher_load),
                enabled = !state.queueBusy,
                modifier = Modifier.fillMaxWidth(),
            ) { actions.loadQueue() }
        } else {
            Text(
                if (queue.hasMore) {
                    // Reported, not silently truncated: a seller with 200
                    // unmatched deposits must not think they cleared the list.
                    stringResource(R.string.payouts_queue_truncated, queue.showing, queue.total)
                } else {
                    pluralStringResource(R.plurals.payouts_queue_count, queue.total, queue.total)
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            BrandSecondaryButton(
                text = stringResource(R.string.payouts_matcher_run),
                enabled = !state.queueBusy,
                modifier = Modifier.fillMaxWidth(),
            ) { actions.runMatcher() }
            for (entry in queue.queue) {
                QueuedPayoutCard(entry, state.queueBusy, actions.matchPayout, actions.dismissPayout)
            }
        }

        state.sweep?.let { sweep ->
            Column(Modifier.fillMaxWidth()) {
                Text(
                    stringResource(
                        R.string.payouts_sweep_result,
                        sweep.autoMatched,
                        sweep.ambiguous,
                        sweep.noCandidates,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = actions.dismissSweep) {
                    Text(stringResource(R.string.common_dismiss))
                }
            }
        }

        // US-2414: the eBay payouts export, so reconciliation is not a job
        // that can only be finished at a computer.
        BrandSecondaryButton(
            text = if (state.importing) {
                stringResource(R.string.payouts_importing)
            } else {
                stringResource(R.string.payouts_import_cta)
            },
            enabled = !state.importing,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.pickCsv() }

        state.importResult?.let { result ->
            Column(Modifier.fillMaxWidth()) {
                Text(
                    // Duplicates are stated, not hidden: a seller who
                    // re-uploaded the same export needs to be told nothing was
                    // counted twice, or they will go looking for the money.
                    stringResource(
                        R.string.payouts_import_result,
                        result.imported,
                        result.duplicates,
                        result.skipped,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = actions.dismissImportResult) {
                    Text(stringResource(R.string.common_dismiss))
                }
            }
        }

        BrandSecondaryButton(
            text = if (state.refreshing) {
                stringResource(R.string.payouts_syncing)
            } else {
                stringResource(R.string.payouts_sync_cta)
            },
            enabled = !state.refreshing,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.syncAndRefresh() }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.close() }
    }
}

/**
 * US-2489: one payout the server could not match on its own.
 *
 * The candidates are the server's, with its score and its reasons shown as
 * written. Re-ranking or re-wording them here would be a second opinion the
 * seller cannot check against anything.
 */
@Composable
private fun QueuedPayoutCard(
    entry: PayoutQueueEntry,
    busy: Boolean,
    onMatch: (String, String) -> Unit,
    onDismiss: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            entry.payout.amount?.let(Money::format)
                ?: stringResource(R.string.payouts_amount_unknown),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        entry.payout.payoutDate?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (entry.candidates.isEmpty()) {
            Text(
                stringResource(R.string.payouts_no_candidates),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        for (candidate in entry.candidates) {
            Column(Modifier.fillMaxWidth().padding(top = Spacing.xxs)) {
                Text(
                    candidate.itemTitle ?: stringResource(R.string.payouts_untitled_item),
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    // The server's own words for why it thinks so.
                    candidate.reasons.joinToString(", "),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(
                    onClick = { onMatch(entry.payout.id, candidate.saleId) },
                    enabled = !busy,
                ) { Text(stringResource(R.string.payouts_match_this)) }
            }
        }

        TextButton(
            onClick = { onDismiss(entry.payout.id) },
            enabled = !busy,
        ) { Text(stringResource(R.string.payouts_not_a_sale)) }
    }
}

@Composable
private fun PayoutCard(entry: PayoutReconciliation.Reconciled, onOpenItem: (String) -> Unit) {
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
            PayoutReconciliation.deltaLabel(entry).text(),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (entry.matched) FontWeight.Normal else FontWeight.SemiBold,
            color = if (entry.matched) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.error
            },
        )
        Text(
            pluralStringResource(
                R.plurals.payouts_entry_summary,
                entry.saleCount,
                entry.saleCount,
                Money.format(entry.recordedCents / 100.0),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PayoutReconciliation.estimateNote(entry)?.let {
            Text(
                it.text(),
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
            Hint(stringResource(R.string.payouts_more_sales, entry.sales.size - 5))
        }
    }
}

@Composable
private fun SaleLine(sale: SaleEntity, note: String, onOpenItem: (String) -> Unit) {
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
