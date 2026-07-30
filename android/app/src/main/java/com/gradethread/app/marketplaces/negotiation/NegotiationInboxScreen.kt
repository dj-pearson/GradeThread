package com.gradethread.app.marketplaces.negotiation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import kotlin.math.roundToInt

/**
 * US-1354: best offers and buyer messages in one inbox.
 */
@Composable
fun NegotiationInboxScreen(
    filterItemId: String? = null,
    onClose: () -> Unit = {},
    viewModel: NegotiationInboxViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }
    var countering by remember { mutableStateOf<BestOffer?>(null) }
    var replyingTo by remember { mutableStateOf<BuyerMessage?>(null) }
    var sendOfferOpen by remember { mutableStateOf(false) }

    LaunchedEffect(filterItemId) { viewModel.bind(filterItemId) }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Offers & messages", style = MaterialTheme.typography.titleLarge)

        state.filterItemId?.let {
            // A deep-linked inbox is showing a SUBSET. Saying so — with a way
            // out — stops an empty list reading as "no offers at all".
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Showing one listing only.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::clearFilter) { Text("Show all") }
            }
        }

        state.errorMessage?.let {
            InfoCard("That didn't work", it, tone = InfoTone.Error)
        }
        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }

        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Offers") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Messages") })
        }

        if (tab == 0) {
            OffersTab(
                state = state,
                onAccept = viewModel::accept,
                onDecline = viewModel::decline,
                onCounter = { countering = it },
                modifier = Modifier.weight(1f),
            )
            if (state.showSendOffer) {
                BrandSecondaryButton(
                    text = "Send an offer to interested buyers",
                    enabled = !state.working,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    sendOfferOpen = true
                    viewModel.loadEligible()
                }
            }
        } else {
            MessagesTab(
                state = state,
                onReply = { replyingTo = it },
                modifier = Modifier.weight(1f),
            )
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    countering?.let { offer ->
        CounterDialog(
            offer = offer,
            working = state.working,
            onDismiss = { countering = null },
            onSend = { price, note ->
                viewModel.counter(offer, price, note)
                countering = null
            },
        )
    }

    replyingTo?.let { message ->
        ReplyDialog(
            message = message,
            working = state.working,
            onDismiss = { replyingTo = null },
            onSend = { body ->
                viewModel.reply(message, body)
                replyingTo = null
            },
        )
    }

    if (sendOfferOpen) {
        SendOfferDialog(
            state = state,
            onDismiss = { sendOfferOpen = false },
            onSend = { discount, note ->
                viewModel.sendOffer(state.eligible.map { it.listingId }, discount, note)
                sendOfferOpen = false
            },
        )
    }
}

@Composable
private fun OffersTab(
    state: NegotiationInboxViewModel.State,
    onAccept: (BestOffer) -> Unit,
    onDecline: (BestOffer) -> Unit,
    onCounter: (BestOffer) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (val phase = state.offersPhase) {
        is NegotiationInboxViewModel.Phase.Loading -> Hint("Loading offers…")
        is NegotiationInboxViewModel.Phase.Failed ->
            InfoCard("Couldn't load offers", phase.message, tone = InfoTone.Error)

        is NegotiationInboxViewModel.Phase.Ready -> if (state.visibleOffers.isEmpty()) {
            Hint("No open offers right now.")
        } else {
            LazyColumn(
                modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.visibleOffers, key = { it.bestOfferId }) { offer ->
                    OfferCard(offer, state.working, onAccept, onDecline, onCounter)
                }
            }
        }
    }
}

@Composable
private fun OfferCard(
    offer: BestOffer,
    working: Boolean,
    onAccept: (BestOffer) -> Unit,
    onDecline: (BestOffer) -> Unit,
    onCounter: (BestOffer) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            offer.itemTitle ?: "Listing ${offer.itemId}",
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                offer.price?.let { Money.format(it) } ?: "—",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            offer.buyerUsername?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        offer.price?.let { price ->
            OutcomeLine(price, offer.itemCost)
        }
        offer.message?.takeIf { it.isNotBlank() }?.let {
            Text("“$it”", style = MaterialTheme.typography.bodySmall)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = "Accept",
                enabled = !working,
                modifier = Modifier.weight(1f),
            ) { onAccept(offer) }
            BrandSecondaryButton(
                text = "Counter",
                enabled = !working,
                modifier = Modifier.weight(1f),
            ) { onCounter(offer) }
            BrandSecondaryButton(
                text = "Decline",
                enabled = !working,
                modifier = Modifier.weight(1f),
            ) { onDecline(offer) }
        }
    }
}

/** What the seller keeps at this price, when the cost basis is known. */
@Composable
private fun OutcomeLine(price: Double, itemCost: Double?) {
    val outcome = NegotiationRules.counterOutcome(price, itemCost)
    if (outcome == null) {
        Hint("No cost basis on this item, so there's no margin to show.")
        return
    }
    val losing = outcome.netCents < 0
    Text(
        "You keep ${Money.format(outcome.netCents)} " +
            "(${outcome.marginPctCents(price).roundToInt()}% after fees)",
        style = MaterialTheme.typography.bodySmall,
        color = if (losing) {
            MaterialTheme.colorScheme.error
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
}

@Composable
private fun MessagesTab(
    state: NegotiationInboxViewModel.State,
    onReply: (BuyerMessage) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (val phase = state.messagesPhase) {
        is NegotiationInboxViewModel.Phase.Loading -> Hint("Loading messages…")
        is NegotiationInboxViewModel.Phase.Failed ->
            InfoCard("Couldn't load messages", phase.message, tone = InfoTone.Error)

        is NegotiationInboxViewModel.Phase.Ready -> if (state.visibleMessages.isEmpty()) {
            Hint("No buyer messages in the last 30 days.")
        } else {
            LazyColumn(
                modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.visibleMessages, key = { it.messageId }) { message ->
                    Column(
                        Modifier.fillMaxWidth().cardStyle(),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text(
                            message.subject ?: "Message from ${message.senderUsername ?: "a buyer"}",
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                        )
                        message.body?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        if (message.answered) {
                            Hint("Replied")
                        } else {
                            BrandSecondaryButton(
                                text = "Reply",
                                enabled = !state.working,
                                modifier = Modifier.fillMaxWidth(),
                            ) { onReply(message) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CounterDialog(
    offer: BestOffer,
    working: Boolean,
    onDismiss: () -> Unit,
    onSend: (String, String?) -> Unit,
) {
    var price by remember(offer.bestOfferId) {
        mutableStateOf(offer.price?.let { String.format(java.util.Locale.US, "%.2f", it) }.orEmpty())
    }
    var note by remember(offer.bestOfferId) { mutableStateOf("") }
    val parsed = NegotiationRules.counterPrice(price)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Counter this offer") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text("Counter price") },
                    prefix = { Text("$") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
                )
                parsed?.let { OutcomeLine(it, offer.itemCost) }
                if (parsed != null && NegotiationRules.losesMoney(parsed, offer.itemCost)) {
                    // Not a block — a seller may well want to cut a loss. It
                    // just must not happen by accident.
                    Text(
                        "This counter is below what the item cost you.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("Note to the buyer (optional)") },
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = parsed != null && !working,
                onClick = { onSend(price, note.takeIf { it.isNotBlank() }) },
            ) { Text("Send counter") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ReplyDialog(
    message: BuyerMessage,
    working: Boolean,
    onDismiss: () -> Unit,
    onSend: (String) -> Unit,
) {
    var body by remember(message.messageId) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Reply to ${message.senderUsername ?: "buyer"}") },
        text = {
            OutlinedTextField(
                value = body,
                onValueChange = { body = it },
                label = { Text("Your reply") },
                minLines = 3,
            )
        },
        confirmButton = {
            TextButton(
                enabled = body.isNotBlank() && !working,
                onClick = { onSend(body) },
            ) { Text("Send") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun SendOfferDialog(
    state: NegotiationInboxViewModel.State,
    onDismiss: () -> Unit,
    onSend: (Int, String?) -> Unit,
) {
    var discount by remember { mutableIntStateOf(10) }
    var note by remember { mutableStateOf("") }
    val count = state.eligible.size

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Send an offer to interested buyers") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                when {
                    // The honest disabled state: the server's own copy, which
                    // never says "reconnect" when reconnecting can't help.
                    state.sendOfferBlocked -> Text(
                        state.sendOfferDetail
                            ?: "Sending offers isn't available on this eBay connection yet.",
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    state.loadingEligible -> Text("Checking which listings are eligible…")
                    count == 0 -> Text("No listings are eligible for an offer right now.")
                    else -> {
                        Text("Discount: $discount%")
                        Slider(
                            value = discount.toFloat(),
                            onValueChange = {
                                discount = NegotiationRules.discountPercent(it.roundToInt())
                            },
                            valueRange = NegotiationRules.MIN_DISCOUNT_PCT.toFloat()..
                                NegotiationRules.MAX_DISCOUNT_PCT.toFloat(),
                            steps = (
                                (
                                    NegotiationRules.MAX_DISCOUNT_PCT -
                                        NegotiationRules.MIN_DISCOUNT_PCT
                                    ) / NegotiationRules.DISCOUNT_STEP
                                ) - 1,
                        )
                        OutlinedTextField(
                            value = note,
                            onValueChange = { note = it },
                            label = { Text("Note to buyers (optional)") },
                        )
                        Text(
                            NegotiationRules.sendOfferConfirmation(count, discount),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        },
        confirmButton = {
            if (!state.sendOfferBlocked && count > 0) {
                TextButton(
                    enabled = !state.working,
                    onClick = { onSend(discount, note.takeIf { it.isNotBlank() }) },
                ) { Text("Send offers") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
