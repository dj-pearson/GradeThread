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
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
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
    // US-2490: the listing whose price/edit/end sheet is open.
    var editing by remember { mutableStateOf<ListingCardModel?>(null) }

    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.marketplaces_ebay_accounts), style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { Banner(it, MaterialTheme.colorScheme.error, viewModel::dismissMessages) }
        state.message?.let {
            Banner(it, MaterialTheme.colorScheme.onSurfaceVariant, viewModel::dismissMessages)
        }

        when {
            state.loading -> Text(
                stringResource(R.string.marketplaces_loading),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.connections.isEmpty() -> Text(
                stringResource(R.string.marketplaces_empty),
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
                stringResource(R.string.marketplaces_finishing_connection),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        BrandPrimaryButton(
            text = stringResource(
                if (state.connecting) {
                    R.string.marketplaces_opening_ebay
                } else {
                    R.string.marketplaces_connect_ebay
                },
            ),
            enabled = !state.connecting && !state.confirming,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.connect() }

        if (state.canSync) {
            BrandSecondaryButton(
                text = stringResource(
                    if (state.syncing) {
                        R.string.marketplaces_syncing
                    } else {
                        R.string.marketplaces_sync_listings
                    },
                ),
                enabled = !state.syncing,
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.syncListings() }
        }

        if (state.canSync) {
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_offers_messages),
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenNegotiation() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_bulk_pricing),
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenBulkPricing() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_after_sale),
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenPostSale() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_repricing),
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenRepricing() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_draft_listings),
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenDrafts() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_automations),
                modifier = Modifier.fillMaxWidth(),
            ) { onOpenAutomations() }
        }

        BrandSecondaryButton(text = stringResource(R.string.marketplaces_refresh), modifier = Modifier.fillMaxWidth()) {
            viewModel.load()
        }

        // US-2481: extension work this phone queued that the desktop has not
        // run yet. Placed above the listings because it answers the question a
        // seller actually opens this screen with after queuing something at a
        // thrift store — "did that happen?" — and the honest answer is "not
        // until your browser opens."
        if (state.queuePending.isNotEmpty() || state.queueNeedsAttention.isNotEmpty()) {
            Text(
                stringResource(R.string.marketplaces_queued_for_desktop),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = Spacing.sm),
            )
            if (state.queuePending.isNotEmpty()) {
                // The sentence comes from the repository layer, shared verbatim
                // with web and iOS, so no platform can soften it into something
                // that reads like the work is already done.
                Text(
                    QUEUED_NOTICE,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                state.queuePending.forEach { job ->
                    Row(
                        Modifier.fillMaxWidth().padding(top = Spacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            viewModel.describeQueued(job),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { viewModel.cancelQueued(job.id) }) {
                            Text(stringResource(R.string.marketplaces_cancel))
                        }
                    }
                }
            }
            if (state.queueNeedsAttention.isNotEmpty()) {
                Text(
                    stringResource(R.string.marketplaces_queue_didnt_run),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = Spacing.xs),
                )
                state.queueNeedsAttention.forEach { job ->
                    Text(
                        "• " + viewModel.describeQueued(job),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // US-1351: the listings the pull merged. Weighted + lazy so a seller
        // with a few hundred live listings scrolls them instead of composing
        // every card into a Column that can't scroll.
        Text(
            stringResource(R.string.marketplaces_listings),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(top = Spacing.sm),
        )
        if (listings.isEmpty()) {
            Text(
                stringResource(R.string.marketplaces_no_listings_cached_yet_sync),
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
                        // Same rule as promotions, for the same reason: eBay
                        // authored an imported listing and owns its lifecycle.
                        onEdit = if (listing.isImported) null else {
                            { editing = listing }
                        },
                    )
                }
            }
        }
    }

    editing?.let { listing ->
        ListingEditSheet(
            listing = listing,
            busy = state.editingListingId == listing.id,
            onDismiss = { editing = null },
            onReprice = { price ->
                viewModel.repriceListing(listing.id, price)
                editing = null
            },
            onRevise = {
                viewModel.reviseListing(listing.id)
                editing = null
            },
            onEnd = {
                viewModel.endListing(listing.id)
                editing = null
            },
        )
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
            title = { Text(stringResource(R.string.marketplaces_rename_this_account)) },
            text = {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text(stringResource(R.string.marketplaces_label)) },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.rename(connection.id, label); renaming = null }) {
                    Text(stringResource(R.string.marketplaces_save))
                }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text(stringResource(R.string.marketplaces_cancel)) } },
        )
    }

    disconnecting?.let { connection ->
        AlertDialog(
            onDismissRequest = { disconnecting = null },
            title = {
                Text(stringResource(R.string.marketplaces_disconnect_title, connection.displayName))
            },
            text = {
                Text(
                    stringResource(R.string.marketplaces_disconnect_body),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { viewModel.disconnect(connection.id); disconnecting = null },
                ) { Text(stringResource(R.string.marketplaces_disconnect)) }
            },
            dismissButton = {
                TextButton(onClick = { disconnecting = null }) { Text(stringResource(R.string.marketplaces_cancel)) }
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
                    stringResource(R.string.marketplaces_primary),
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
                stringResource(R.string.marketplaces_needs_reconnecting_ebay_stopped_accepting),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Row {
            TextButton(onClick = onRename) { Text(stringResource(R.string.marketplaces_rename)) }
            if (!connection.isPrimary) {
                TextButton(onClick = onSetPrimary) { Text(stringResource(R.string.marketplaces_make_primary)) }
            }
            TextButton(onClick = onDisconnect) {
                Text(stringResource(R.string.marketplaces_disconnect), color = MaterialTheme.colorScheme.error)
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
        TextButton(onClick = onDismiss) { Text(stringResource(R.string.marketplaces_dismiss)) }
    }
}
