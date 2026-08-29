package com.gradethread.app.marketplaces.reconciliation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1356: unmatched eBay listings, one decision each.
 */
@Composable
fun ReconciliationScreen(onClose: () -> Unit = {}, viewModel: ReconciliationViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    var creating by remember { mutableStateOf<OrphanEbayListing?>(null) }
    var linking by remember { mutableStateOf<OrphanEbayListing?>(null) }
    var confirmCreateAll by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(
            stringResource(R.string.reconciliation_unmatched_ebay_listings),
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            stringResource(R.string.reconciliation_intro),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.reconciliation_that_didn_t_work), it, tone = InfoTone.Error)
        }
        state.banner?.let { InfoCard(stringResource(R.string.reconciliation_done), it, tone = InfoTone.Success) }
        state.bulkProgress?.let { (done, total) ->
            Text(
                stringResource(R.string.reconciliation_creating, done, total),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when {
            state.loading -> Text(
                stringResource(R.string.reconciliation_loading),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.orphans.isEmpty() -> Text(
                stringResource(R.string.reconciliation_nothing_reconcile_every_ebay_listing),
                style = MaterialTheme.typography.bodyMedium,
            )

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.orphans, key = { it.id }) { orphan ->
                    OrphanCard(
                        orphan = orphan,
                        rowError = state.rowErrors[orphan.id],
                        busy = state.busy,
                        onCreate = { creating = orphan },
                        onLink = {
                            viewModel.loadLinkCandidates()
                            linking = orphan
                        },
                        onIgnore = { viewModel.ignore(orphan) },
                    )
                }
            }
        }

        if (state.orphans.size > 1) {
            BrandSecondaryButton(
                text = stringResource(R.string.reconciliation_create_all, state.orphans.size),
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { confirmCreateAll = true }
        }

        BrandSecondaryButton(text = stringResource(R.string.reconciliation_back), modifier = Modifier.fillMaxWidth()) {
            onClose()
        }
    }

    creating?.let { orphan ->
        CreateItemDialog(
            orphan = orphan,
            busy = state.busy,
            onDismiss = { creating = null },
            onCreate = { title, sku, price ->
                viewModel.createItem(orphan, title, sku, price)
                creating = null
            },
        )
    }

    linking?.let { orphan ->
        LinkItemDialog(
            orphan = orphan,
            candidates = state.linkCandidates,
            onDismiss = { linking = null },
            onLink = { itemId ->
                viewModel.link(orphan, itemId)
                linking = null
            },
        )
    }

    if (confirmCreateAll) {
        AlertDialog(
            onDismissRequest = { confirmCreateAll = false },
            title = {
                Text(
                    pluralStringResource(R.plurals.reconciliation_create_title, state.orphans.size, state.orphans.size),
                )
            },
            text = {
                Text(
                    stringResource(R.string.reconciliation_create_body),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.createAll()
                    confirmCreateAll = false
                }) { Text(stringResource(R.string.reconciliation_create_them)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    confirmCreateAll = false
                }) { Text(stringResource(R.string.reconciliation_cancel)) }
            },
        )
    }
}

@Composable
private fun OrphanCard(
    orphan: OrphanEbayListing,
    rowError: String?,
    busy: Boolean,
    onCreate: () -> Unit,
    onLink: () -> Unit,
    onIgnore: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            orphan.displayTitle,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            orphan.currentPrice?.let {
                Text(Money.format(it), style = MaterialTheme.typography.bodyMedium)
            }
            orphan.customLabel?.takeIf { it.isNotBlank() }?.let {
                Text(
                    stringResource(R.string.reconciliation_sku_row, it),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        rowError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = stringResource(R.string.reconciliation_create_item),
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onCreate() }
            BrandSecondaryButton(
                text = stringResource(R.string.reconciliation_link),
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onLink() }
            BrandSecondaryButton(
                text = stringResource(R.string.reconciliation_ignore),
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onIgnore() }
        }
    }
}

@Composable
private fun CreateItemDialog(
    orphan: OrphanEbayListing,
    busy: Boolean,
    onDismiss: () -> Unit,
    onCreate: (String?, String?, Double?) -> Unit,
) {
    var title by remember(orphan.id) { mutableStateOf(orphan.suggestedTitle) }
    var sku by remember(orphan.id) { mutableStateOf(orphan.customLabel.orEmpty()) }
    var price by remember(orphan.id) {
        mutableStateOf(orphan.currentPrice?.let { String.format(java.util.Locale.US, "%.2f", it) }.orEmpty())
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.reconciliation_create_item_2)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text(stringResource(R.string.reconciliation_title)) },
                )
                OutlinedTextField(
                    value = sku,
                    onValueChange = { sku = it },
                    label = { Text(stringResource(R.string.reconciliation_sku)) },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text(stringResource(R.string.reconciliation_target_price)) },
                    prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
                )
                Text(
                    stringResource(R.string.reconciliation_item_starts_as_listed_ebay),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = title.isNotBlank() && !busy,
                onClick = {
                    onCreate(
                        title,
                        sku.takeIf { it.isNotBlank() },
                        com.gradethread.app.capture.CurrencyAmount.parseCents(price)
                            ?.takeIf { it > 0 }?.let { it / 100.0 },
                    )
                },
            ) { Text(stringResource(R.string.reconciliation_create)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.reconciliation_cancel)) } },
    )
}

@Composable
private fun LinkItemDialog(
    orphan: OrphanEbayListing,
    candidates: List<com.gradethread.app.sync.db.InventoryItemEntity>,
    onDismiss: () -> Unit,
    onLink: (String) -> Unit,
) {
    var query by remember(orphan.id) { mutableStateOf("") }
    val matches = remember(query, candidates) {
        val q = query.trim().lowercase()
        candidates
            .filter {
                q.isEmpty() ||
                    it.title.lowercase().contains(q) ||
                    it.sku?.lowercase()?.contains(q) == true
            }
            .take(30)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.reconciliation_link_item)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text(stringResource(R.string.reconciliation_search_items)) },
                    singleLine = true,
                )
                if (matches.isEmpty()) {
                    Text(
                        stringResource(R.string.reconciliation_no_match),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    LazyColumn(Modifier.heightIn(max = 320.dp)) {
                        items(matches, key = { it.id }) { item ->
                            TextButton(
                                onClick = { onLink(item.id) },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(item.title, maxLines = 2) }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.reconciliation_cancel)) } },
    )
}
