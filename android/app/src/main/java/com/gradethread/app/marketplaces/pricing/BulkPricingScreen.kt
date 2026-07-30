package com.gradethread.app.marketplaces.pricing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1355: bulk price editor — pick listings, choose an adjustment, see the new
 * price on every row before anything is pushed.
 */
@Composable
fun BulkPricingScreen(
    onClose: () -> Unit = {},
    viewModel: BulkPricingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Bulk pricing", style = MaterialTheme.typography.titleLarge)

        if (state.multiStore) {
            // Every push routes through the primary store's token, and the
            // listing rows don't record which store they belong to — so name it
            // rather than let a two-store seller assume otherwise.
            InfoCard(
                "Pushing through ${state.primaryStoreName ?: "your primary eBay store"}",
                "You have more than one eBay account connected. Bulk edits all go " +
                    "through the primary one.",
            )
        }

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard("Pushed", it, tone = InfoTone.Success) }

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            BulkPricing.Mode.entries.forEach { mode ->
                FilterChip(
                    selected = state.mode == mode,
                    onClick = { viewModel.setMode(mode) },
                    label = { Text(mode.label) },
                )
            }
        }

        if (state.mode != BulkPricing.Mode.NONE) {
            OutlinedTextField(
                value = state.inputText,
                onValueChange = viewModel::setInput,
                label = {
                    Text(if (state.mode == BulkPricing.Mode.SET) "New price" else "Reduce by")
                },
                prefix = { if (state.mode == BulkPricing.Mode.SET) Text("$") },
                suffix = { if (state.mode == BulkPricing.Mode.REDUCE) Text("%") },
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Decimal,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.inputText.isNotBlank() && state.value == null) {
                Text(
                    if (state.mode == BulkPricing.Mode.SET) {
                        "Enter a price greater than zero."
                    } else {
                        "Enter a reduction between 1 and 99%."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${state.selected.size} of ${state.listings.size} selected",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = viewModel::toggleAll) {
                Text(if (state.allSelected) "Clear all" else "Select all")
            }
        }

        when {
            state.loading -> Text(
                "Loading your live listings…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.listings.isEmpty() -> Text(
                "No live listings that FlipDesk published. Imported eBay listings are " +
                    "edited on eBay, so they can't be repriced here.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                items(state.listings, key = { it.id }) { listing ->
                    ListingRow(
                        listing = listing,
                        selected = listing.id in state.selected,
                        target = state.target(listing),
                        rowError = state.rowErrors[listing.id],
                        onToggle = { viewModel.toggle(listing.id) },
                    )
                }
            }
        }

        BrandPrimaryButton(
            text = when {
                state.busy -> "Pushing to eBay…"
                state.updates.isEmpty() -> "Nothing to push"
                else -> "Push ${state.updates.size} price changes"
            },
            enabled = state.canApply,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.apply() }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun ListingRow(
    listing: BulkListing,
    selected: Boolean,
    target: BulkPricing.Target,
    rowError: String?,
    onToggle: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = selected, onCheckedChange = { onToggle() })
            Text(
                listing.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(Money.format(listing.price), style = MaterialTheme.typography.bodyMedium)
            // The preview only shows for selected rows: an unselected row isn't
            // going anywhere, and showing it a new price implies otherwise.
            if (selected) {
                target.price?.let {
                    Text(
                        "  →  ${Money.format(it)}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
            listing.quantity?.let {
                Text(
                    "   Qty $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (selected) {
            target.error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        rowError?.let {
            // A per-listing failure from the last push. It stays on its row so a
            // partial batch reads as "these two didn't", not "it failed".
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}
