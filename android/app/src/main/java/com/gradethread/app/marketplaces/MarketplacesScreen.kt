package com.gradethread.app.marketplaces

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.runtime.Immutable
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

    MarketplacesContent(
        MarketplacesUiState(state, listings),
        MarketplacesActions(
            dismissMessages = viewModel::dismissMessages,
            setPrimary = viewModel::setPrimary,
            openRename = { renaming = it },
            rename = { id, label ->
                viewModel.rename(id, label)
                renaming = null
            },
            openDisconnect = { disconnecting = it },
            disconnect = {
                viewModel.disconnect(it)
                disconnecting = null
            },
            connect = viewModel::connect,
            syncListings = viewModel::syncListings,
            refresh = viewModel::load,
            queueDelist = viewModel::queueDelist,
            markDelistDone = viewModel::markDelistDone,
            cancelQueued = viewModel::cancelQueued,
            // A Custom Tab needs a real Context, and a screenshot test has
            // nowhere to send one.
            openExternal = { url -> CustomTabsLauncher.open(context, url) },
            openPromote = { promoting = it },
            openEdit = { editing = it },
            reprice = { id, price ->
                viewModel.repriceListing(id, price)
                editing = null
            },
            revise = {
                viewModel.reviseListing(it)
                editing = null
            },
            endListing = {
                viewModel.endListing(it)
                editing = null
            },
            openNegotiation = onOpenNegotiation,
            openBulkPricing = onOpenBulkPricing,
            openPostSale = onOpenPostSale,
            openRepricing = onOpenRepricing,
            openDrafts = onOpenDrafts,
            openAutomations = onOpenAutomations,
        ),
        modifier = modifier,
        renaming = renaming,
        disconnecting = disconnecting,
        promoting = promoting,
        editing = editing,
    )
}

/** The two flows this screen reads, in one place (US-2902 AC3). */
@Immutable
data class MarketplacesUiState(
    val state: MarketplacesViewModel.State = MarketplacesViewModel.State(),
    val listings: List<ListingCardModel> = emptyList(),
)

/**
 * Everything this screen can be asked to do (US-2902 AC3).
 *
 * Long because this screen IS the marketplace surface: it owns the connection,
 * the listings on it, the extension queue behind it and the six other screens
 * that hang off it. Splitting the record would group by nothing.
 */
@Suppress("LongParameterList")
@Immutable
data class MarketplacesActions(
    val dismissMessages: () -> Unit = {},
    val setPrimary: (String) -> Unit = {},
    val openRename: (MarketplaceConnection?) -> Unit = {},
    val rename: (String, String) -> Unit = { _, _ -> },
    val openDisconnect: (MarketplaceConnection?) -> Unit = {},
    val disconnect: (String) -> Unit = {},
    val connect: () -> Unit = {},
    val syncListings: () -> Unit = {},
    val refresh: () -> Unit = {},
    val queueDelist: (PendingDelist) -> Unit = {},
    val markDelistDone: (PendingDelist) -> Unit = {},
    val cancelQueued: (String) -> Unit = {},
    val openExternal: (String) -> Unit = {},
    val openPromote: (ListingCardModel?) -> Unit = {},
    val openEdit: (ListingCardModel?) -> Unit = {},
    val reprice: (String, Double) -> Unit = { _, _ -> },
    val revise: (String) -> Unit = {},
    val endListing: (String) -> Unit = {},
    val openNegotiation: () -> Unit = {},
    val openBulkPricing: () -> Unit = {},
    val openPostSale: () -> Unit = {},
    val openRepricing: () -> Unit = {},
    val openDrafts: () -> Unit = {},
    val openAutomations: () -> Unit = {},
)

/**
 * The eBay account surface with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE PROMOTION SHEET IS A SLOT. PromotionSheet resolves its own ViewModel
 * through Hilt, and RoborazziActivity is not a Hilt component, so composing the
 * real one here would kill any capture that reached it.
 *
 * ⚠ AN IMPORTED LISTING GETS NEITHER PROMOTE NOR EDIT, and the buttons are
 * absent rather than disabled. eBay authored those listings and owns their
 * lifecycle, so a greyed Edit would read as one tap from working. The fixture
 * carries one imported listing beside one of ours for exactly that comparison.
 *
 * ⚠ AND THE DELIST QUEUE'S BUTTON ORDER IS AN ARGUMENT. "Queue for my desktop"
 * comes first because it is the one that actually ends the listing; "I ended it
 * myself" second, because it clears the stamp without the extension - and a
 * stamp cleared on a listing that is still live IS the double sale this whole
 * queue exists to prevent.
 */
@Composable
fun MarketplacesContent(
    ui: MarketplacesUiState,
    actions: MarketplacesActions,
    modifier: Modifier = Modifier,
    renaming: MarketplaceConnection? = null,
    disconnecting: MarketplaceConnection? = null,
    promoting: ListingCardModel? = null,
    editing: ListingCardModel? = null,
    promotionSheet: @Composable (ListingCardModel) -> Unit = { listing ->
        com.gradethread.app.marketplaces.promotions.PromotionSheet(
            listingId = listing.id,
            listingTitle = listing.platformLabel + " · " + listing.priceText,
            onDismiss = { actions.openPromote(null) },
        )
    },
) {
    val state = ui.state
    val listings = ui.listings

    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.marketplaces_ebay_accounts), style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { Banner(it, MaterialTheme.colorScheme.error, actions.dismissMessages) }
        state.message?.let {
            Banner(it, MaterialTheme.colorScheme.onSurfaceVariant, actions.dismissMessages)
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
                    onRename = { actions.openRename(connection) },
                    onSetPrimary = { actions.setPrimary(connection.id) },
                    onDisconnect = { actions.openDisconnect(connection) },
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
        ) { actions.connect() }

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
            ) { actions.syncListings() }
        }

        if (state.canSync) {
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_offers_messages),
                modifier = Modifier.fillMaxWidth(),
            ) { actions.openNegotiation() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_bulk_pricing),
                modifier = Modifier.fillMaxWidth(),
            ) { actions.openBulkPricing() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_after_sale),
                modifier = Modifier.fillMaxWidth(),
            ) { actions.openPostSale() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_repricing),
                modifier = Modifier.fillMaxWidth(),
            ) { actions.openRepricing() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_draft_listings),
                modifier = Modifier.fillMaxWidth(),
            ) { actions.openDrafts() }
            BrandSecondaryButton(
                text = stringResource(R.string.marketplaces_automations),
                modifier = Modifier.fillMaxWidth(),
            ) { actions.openAutomations() }
        }

        BrandSecondaryButton(text = stringResource(R.string.marketplaces_refresh), modifier = Modifier.fillMaxWidth()) {
            actions.refresh()
        }

        DelistAndQueueSections(state, actions)
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
                        onOpenExternal = actions.openExternal,
                        // Promotions only apply to listings GradeThread
                        // published — an imported one has no offer to advertise.
                        onPromote = if (listing.isImported) {
                            null
                        } else {
                            { actions.openPromote(listing) }
                        },
                        // Same rule as promotions, for the same reason: eBay
                        // authored an imported listing and owns its lifecycle.
                        onEdit = if (listing.isImported) {
                            null
                        } else {
                            { actions.openEdit(listing) }
                        },
                    )
                }
            }
        }
    }

    MarketplacesDialogs(
        actions = actions,
        busyListingId = state.editingListingId,
        renaming = renaming,
        disconnecting = disconnecting,
        promoting = promoting,
        editing = editing,
        promotionSheet = promotionSheet,
    )
}

/**
 * The delist queue and the extension work behind it (US-2902 AC3).
 *
 * Split out of MarketplacesContent because inlined it took that body to a
 * cyclomatic complexity of 31 against a ceiling of 20. The sections belong
 * together: all three are about work that has left this phone and not yet
 * landed anywhere.
 */
@Composable
private fun ColumnScope.DelistAndQueueSections(state: MarketplacesViewModel.State, actions: MarketplacesActions) {
    // US-2481 AC1: sold elsewhere, still live here.
    //
    // ABOVE the queue section, because a listing that is still taking money
    // outranks the record of work already queued. The button order is the
    // argument: "Queue for my desktop" first, because it is the one that
    // actually ends the listing; "I ended it myself" second, because it is
    // the only thing that clears the stamp without the extension and a
    // stamp cleared on a live listing is the double sale itself.
    if (state.pendingDelists.isNotEmpty()) {
        Text(
            stringResource(R.string.marketplaces_pending_delists_title),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(top = Spacing.sm),
        )
        Text(
            stringResource(R.string.marketplaces_pending_delists_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.pendingDelists.forEach { row ->
            val blocked = pendingDelistBlockedReason(row)
            Column(Modifier.fillMaxWidth().padding(top = Spacing.xs)) {
                Text(
                    describePendingDelist(row),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    blocked ?: QUEUED_NOTICE,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (blocked == null) {
                        TextButton(
                            onClick = { actions.queueDelist(row) },
                            enabled = state.delistBusyId == null,
                        ) {
                            Text(stringResource(R.string.marketplaces_delist_queue))
                        }
                    }
                    TextButton(
                        onClick = { actions.markDelistDone(row) },
                        enabled = state.delistBusyId == null,
                    ) {
                        Text(stringResource(R.string.marketplaces_delist_did_it_myself))
                    }
                }
            }
        }
        state.delistMessage?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
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
                        describeQueuedWork(job),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { actions.cancelQueued(job.id) }) {
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
                    "• " + describeQueuedWork(job),
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
}

/**
 * The four things this screen can open over itself (US-2902 AC3).
 *
 * Together rather than inline for the same reason as the queue sections: the
 * body was over detekt's complexity ceiling. They are also the part a golden
 * most needs to reach, which is why every one of them is driven by a
 * parameter rather than by a remember.
 */
@Composable
private fun MarketplacesDialogs(
    actions: MarketplacesActions,
    busyListingId: String?,
    renaming: MarketplaceConnection?,
    disconnecting: MarketplaceConnection?,
    promoting: ListingCardModel?,
    editing: ListingCardModel?,
    promotionSheet: @Composable (ListingCardModel) -> Unit,
) {
    editing?.let { listing ->
        ListingEditSheet(
            listing = listing,
            busy = busyListingId == listing.id,
            onDismiss = { actions.openEdit(null) },
            onReprice = { price -> actions.reprice(listing.id, price) },
            onRevise = { actions.revise(listing.id) },
            onEnd = { actions.endListing(listing.id) },
        )
    }

    promoting?.let { listing -> promotionSheet(listing) }

    renaming?.let { connection ->
        var label by remember(connection.id) { mutableStateOf(connection.label.orEmpty()) }
        AlertDialog(
            onDismissRequest = { actions.openRename(null) },
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
                TextButton(onClick = { actions.rename(connection.id, label) }) {
                    Text(stringResource(R.string.marketplaces_save))
                }
            },
            dismissButton = {
                TextButton(onClick = { actions.openRename(null) }) {
                    Text(stringResource(R.string.marketplaces_cancel))
                }
            },
        )
    }

    disconnecting?.let { connection ->
        AlertDialog(
            onDismissRequest = { actions.openDisconnect(null) },
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
                    onClick = { actions.disconnect(connection.id) },
                ) { Text(stringResource(R.string.marketplaces_disconnect)) }
            },
            dismissButton = {
                TextButton(onClick = { actions.openDisconnect(null) }) {
                    Text(stringResource(R.string.marketplaces_cancel))
                }
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
private fun Banner(message: String, tone: androidx.compose.ui.graphics.Color, onDismiss: () -> Unit) {
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
