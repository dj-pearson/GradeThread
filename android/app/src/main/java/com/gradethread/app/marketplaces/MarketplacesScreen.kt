package com.gradethread.app.marketplaces

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1350: connected eBay accounts.
 */
@Composable
fun MarketplacesScreen(
    modifier: Modifier = Modifier,
    /** US-1354: opens the offers + messages inbox. */
    onOpenNegotiation: () -> Unit = {},
    /** US-1355: opens the bulk price editor. */
    onOpenBulkPricing: () -> Unit = {},
    /** US-1357: opens the post-sale shipping + feedback surface. */
    onOpenPostSale: () -> Unit = {},
    /** US-1358: opens repricing rules + suggestions. */
    onOpenRepricing: () -> Unit = {},
    /** US-1359: opens the AutoLister drafts library. */
    onOpenDrafts: () -> Unit = {},
    /** US-1362: opens the automation rules. */
    onOpenAutomations: () -> Unit = {},
    viewModel: MarketplacesViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()
    val listings by viewModel.listings.collectAsState(initial = emptyList())

    LaunchedEffect(Unit) { viewModel.load() }

    // The consent bounce-back. Cleared after handling so re-entering the
    // screen later can't re-process an old consent.
    LaunchedEffect(Unit) {
        EbayOAuthCallbacks.callbacks.collect { uri ->
            viewModel.onCallback(uri)
            EbayOAuthCallbacks.clear()
        }
    }

    // Launched as an effect, not in the click handler: the consent URL arrives
    // asynchronously from the edge, and a recomposition must not reopen a tab
    // that is already up.
    LaunchedEffect(state.pendingConsentUrl) {
        state.pendingConsentUrl?.let { url ->
            CustomTabsLauncher.open(context, url)
            viewModel.onConsentLaunched()
        }
    }

    var renaming by remember { mutableStateOf<MarketplaceConnection?>(null) }
    var disconnecting by remember { mutableStateOf<MarketplaceConnection?>(null) }
    // US-1357: the promotion + sale sheet, opened from a listing card.
    var promoting by remember { mutableStateOf<ListingCardModel?>(null) }

    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("eBay accounts", style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { Banner(it, MaterialTheme.colorScheme.error, viewModel::dismissMessages) }
        state.message?.let {
            Banner(it, MaterialTheme.colorScheme.onSurfaceVariant, viewModel::dismissMessages)
        }

        when {
            state.loading -> Text(
                "Loading…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.connections.isEmpty() -> Text(
                "No eBay account connected yet. Connecting one lets FlipDesk publish " +
                    "listings and pull your sales.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            else -> state.connections.forEach { connection ->
                ConnectionRow(
                    connection = connection,
                    onRename = { renaming = connection },
                    onSetPrimary = { viewModel.setPrimary(connection.id) },
                    onDisconnect = { disconnecting = connection },
                )
            }
        }

        if (state.confirming) {
            Text(
                "Finishing the connection…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        BrandPrimaryButton(
            text = if (state.connecting) "Opening eBay…" else "Connect an eBay account",
            enabled = !state.connecting && !state.confirming,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.connect() }

        if (state.canSync) {
            BrandSecondaryButton(
                text = if (state.syncing) "Syncing from eBay…" else "Sync listings from eBay",
                enabled = !state.syncing,
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.syncListings() }
        }

        if (state.canSync) {
            BrandSecondaryButton(
                text = "Offers & messages",
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenNegotiation() }
            BrandSecondaryButton(
                text = "Bulk pricing",
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenBulkPricing() }
            BrandSecondaryButton(
                text = "After the sale",
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenPostSale() }
            BrandSecondaryButton(
                text = "Repricing",
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenRepricing() }
            BrandSecondaryButton(
                text = "Draft listings",
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenDrafts() }
            BrandSecondaryButton(
                text = "Automations",
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenAutomations() }
        }

        BrandSecondaryButton(text = "Refresh", modifier = Modifier.fillMaxWidth()) {
            viewModel.load()
        }

        // US-1351: the listings the pull merged. Weighted + lazy so a seller
        // with a few hundred live listings scrolls them instead of composing
        // every card into a Column that can't scroll.
        Text(
            "Listings",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(top = Spacing.sm),
        )
        if (listings.isEmpty()) {
            Text(
                "No listings cached yet. Sync to pull the ones live on eBay.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(listings, key = { it.id }) { listing ->
                    ListingCard(
                        listing,
                        onOpenExternal = { url -> CustomTabsLauncher.open(context, url) },
                        // Promotions only apply to listings GradeThread
                        // published — an imported one has no offer to advertise.
                        onPromote = if (listing.isImported) null else {
                            { promoting = listing }
                        },
                    )
                }
            }
        }
    }

    promoting?.let { listing ->
        com.gradethread.app.marketplaces.promotions.PromotionSheet(
            listingId = listing.id,
            listingTitle = listing.platformLabel + " · " + listing.priceText,
            onDismiss = { promoting = null },
        )
    }

    renaming?.let { connection ->
        var label by remember(connection.id) { mutableStateOf(connection.label.orEmpty()) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename this account") },
            text = {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("Label") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.rename(connection.id, label); renaming = null }) {
                    Text("Save")
                }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }

    disconnecting?.let { connection ->
        AlertDialog(
            onDismissRequest = { disconnecting = null },
            title = { Text("Disconnect ${connection.displayName}?") },
            text = {
                Text(
                    "FlipDesk stops publishing and syncing for this account. Listings " +
                        "already live on eBay stay live.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { viewModel.disconnect(connection.id); disconnecting = null },
                ) { Text("Disconnect") }
            },
            dismissButton = {
                TextButton(onClick = { disconnecting = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun ConnectionRow(
    connection: MarketplaceConnection,
    onRename: () -> Unit,
    onSetPrimary: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                connection.displayName,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (connection.isPrimary) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
            )
            if (connection.isPrimary) {
                Text(
                    "Primary",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
        if (connection.needsReconnect) {
            // A connection that still exists but can't refresh is the one that
            // silently stops publishing — say so rather than showing it as
            // healthy.
            Text(
                "Needs reconnecting — eBay stopped accepting the saved sign-in.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Row {
            TextButton(onClick = onRename) { Text("Rename") }
            if (!connection.isPrimary) {
                TextButton(onClick = onSetPrimary) { Text("Make primary") }
            }
            TextButton(onClick = onDisconnect) {
                Text("Disconnect", color = MaterialTheme.colorScheme.error)
            }
        }
        HorizontalDivider()
    }
}

@Composable
private fun Banner(
    message: String,
    tone: androidx.compose.ui.graphics.Color,
    onDismiss: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(tone.copy(alpha = 0.10f), RoundedCornerShape(8.dp))
            .padding(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = tone,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onDismiss) { Text("Dismiss") }
    }
}
