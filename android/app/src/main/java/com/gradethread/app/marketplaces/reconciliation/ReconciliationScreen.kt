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
fun ReconciliationScreen(
    onClose: () -> Unit = {},
    viewModel: ReconciliationViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var creating by remember { mutableStateOf<OrphanEbayListing?>(null) }
    var linking by remember { mutableStateOf<OrphanEbayListing?>(null) }
    var confirmCreateAll by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Unmatched eBay listings", style = MaterialTheme.typography.titleLarge)
        Text(
            "These are live on eBay but aren't linked to anything in your inventory. " +
                "Create an item, link an existing one, or ignore it.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }
        state.bulkProgress?.let { (done, total) ->
            Text(
                "Creating items… $done of $total",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when {
            state.loading -> Text(
                "Loading…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.orphans.isEmpty() -> Text(
                "Nothing to reconcile. Every eBay listing is matched to an item.",
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
                text = "Create items for all ${state.orphans.size}",
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { confirmCreateAll = true }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
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
            title = { Text("Create ${state.orphans.size} items?") },
            text = {
                Text(
                    "One new inventory item per listing, using each listing's title, " +
                        "SKU and price. You can edit them afterwards.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.createAll()
                    confirmCreateAll = false
                }) { Text("Create them") }
            },
            dismissButton = {
                TextButton(onClick = { confirmCreateAll = false }) { Text("Cancel") }
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
                    "   SKU $it",
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
                text = "Create item",
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onCreate() }
            BrandSecondaryButton(
                text = "Link",
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onLink() }
            BrandSecondaryButton(
                text = "Ignore",
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
        title = { Text("Create an item") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                )
                OutlinedTextField(
                    value = sku,
                    onValueChange = { sku = it },
                    label = { Text("SKU") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text("Target price") },
                    prefix = { Text("$") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
                )
                Text(
                    "The item starts as Listed — eBay says this listing is live.",
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
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
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
        title = { Text("Link to an item") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("Search your items") },
                    singleLine = true,
                )
                if (matches.isEmpty()) {
                    Text(
                        "Nothing matches. Items sync to this device, so a very new one " +
                            "may not be here yet.",
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
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
