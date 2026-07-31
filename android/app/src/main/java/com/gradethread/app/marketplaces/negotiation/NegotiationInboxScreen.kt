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
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
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
        Text(stringResource(R.string.negotiation_offers_messages), style = MaterialTheme.typography.titleLarge)

        state.filterItemId?.let {
            // A deep-linked inbox is showing a SUBSET. Saying so — with a way
            // out — stops an empty list reading as "no offers at all".
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.negotiation_showing_one_listing_only),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::clearFilter) { Text(stringResource(R.string.negotiation_show_all)) }
            }
        }

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.negotiation_that_didn_t_work), it, tone = InfoTone.Error)
        }
        state.banner?.let { InfoCard(stringResource(R.string.negotiation_done), it, tone = InfoTone.Success) }

        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.negotiation_offers)) })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.negotiation_messages)) })
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
                    text = stringResource(R.string.negotiation_send_offer_interested_buyers),
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

        BrandSecondaryButton(text = stringResource(R.string.negotiation_back), modifier = Modifier.fillMaxWidth()) { onClose() }
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
        is NegotiationInboxViewModel.Phase.Loading -> Hint(stringResource(R.string.negotiation_loading_offers))
        is NegotiationInboxViewModel.Phase.Failed ->
            InfoCard(stringResource(R.string.negotiation_couldn_t_load_offers), phase.message, tone = InfoTone.Error)

        is NegotiationInboxViewModel.Phase.Ready -> if (state.visibleOffers.isEmpty()) {
            Hint(stringResource(R.string.negotiation_no_open_offers))
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
            offer.itemTitle
                ?: stringResource(R.string.negotiation_listing_fallback, offer.itemId),
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
            Text(
                stringResource(R.string.negotiation_quoted, it),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = stringResource(R.string.negotiation_accept),
                enabled = !working,
                modifier = Modifier.weight(1f),
            ) { onAccept(offer) }
            BrandSecondaryButton(
                text = stringResource(R.string.negotiation_counter),
                enabled = !working,
                modifier = Modifier.weight(1f),
            ) { onCounter(offer) }
            BrandSecondaryButton(
                text = stringResource(R.string.negotiation_decline),
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
        Hint(stringResource(R.string.negotiation_no_cost_basis))
        return
    }
    val losing = outcome.netCents < 0
    Text(
        stringResource(
            R.string.negotiation_you_keep,
            Money.format(outcome.netCents),
            outcome.marginPctCents(price).roundToInt(),
        ),
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
    val unknownBuyer = stringResource(R.string.negotiation_a_buyer)
    when (val phase = state.messagesPhase) {
        is NegotiationInboxViewModel.Phase.Loading -> Hint(stringResource(R.string.negotiation_loading_messages))
        is NegotiationInboxViewModel.Phase.Failed ->
            InfoCard(stringResource(R.string.negotiation_couldn_t_load_messages), phase.message, tone = InfoTone.Error)

        is NegotiationInboxViewModel.Phase.Ready -> if (state.visibleMessages.isEmpty()) {
            Hint(stringResource(R.string.negotiation_no_messages))
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
                            message.subject ?: stringResource(
                                R.string.negotiation_message_from,
                                message.senderUsername ?: unknownBuyer,
                            ),
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                        )
                        message.body?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        if (message.answered) {
                            Hint(stringResource(R.string.negotiation_replied))
                        } else {
                            BrandSecondaryButton(
                                text = stringResource(R.string.negotiation_reply),
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
        title = { Text(stringResource(R.string.negotiation_counter_this_offer)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text(stringResource(R.string.negotiation_counter_price)) },
                    prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
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
                        stringResource(R.string.negotiation_this_counter_below_what_item),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.negotiation_note_buyer_optional)) },
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = parsed != null && !working,
                onClick = { onSend(price, note.takeIf { it.isNotBlank() }) },
            ) { Text(stringResource(R.string.negotiation_send_counter)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.negotiation_cancel)) } },
    )
}

@Composable
private fun ReplyDialog(
    message: BuyerMessage,
    working: Boolean,
    onDismiss: () -> Unit,
    onSend: (String) -> Unit,
) {
    val unknownBuyer = stringResource(R.string.negotiation_a_buyer)
    var body by remember(message.messageId) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    R.string.negotiation_reply_to,
                    message.senderUsername ?: unknownBuyer,
                ),
            )
        },
        text = {
            OutlinedTextField(
                value = body,
                onValueChange = { body = it },
                label = { Text(stringResource(R.string.negotiation_reply_2)) },
                minLines = 3,
            )
        },
        confirmButton = {
            TextButton(
                enabled = body.isNotBlank() && !working,
                onClick = { onSend(body) },
            ) { Text(stringResource(R.string.negotiation_send)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.negotiation_cancel)) } },
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
        title = { Text(stringResource(R.string.negotiation_send_offer_interested_buyers)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                when {
                    // The honest disabled state: the server's own copy, which
                    // never says "reconnect" when reconnecting can't help.
                    state.sendOfferBlocked -> Text(
                        state.sendOfferDetail
                            ?: stringResource(R.string.negotiation_send_blocked),
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    state.loadingEligible -> Text(stringResource(R.string.negotiation_checking_which_listings_are_eligible))
                    count == 0 -> Text(stringResource(R.string.negotiation_no_listings_are_eligible_offer))
                    else -> {
                        Text(stringResource(R.string.negotiation_discount, discount))
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
                            label = { Text(stringResource(R.string.negotiation_note_buyers_optional)) },
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
                ) { Text(stringResource(R.string.negotiation_send_offers)) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.negotiation_close)) } },
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
