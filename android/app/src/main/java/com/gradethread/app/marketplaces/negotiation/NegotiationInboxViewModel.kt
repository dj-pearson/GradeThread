package com.gradethread.app.marketplaces.negotiation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1354: the negotiation inbox — best offers and buyer messages in one place.
 */
@HiltViewModel
class NegotiationInboxViewModel @Inject constructor(
    private val service: NegotiationService,
) : ViewModel() {

    sealed interface Phase {
        data object Loading : Phase
        data object Ready : Phase
        data class Failed(val message: String) : Phase
    }

    data class State(
        val offersPhase: Phase = Phase.Loading,
        val messagesPhase: Phase = Phase.Loading,
        val offers: List<BestOffer> = emptyList(),
        val messages: List<BuyerMessage> = emptyList(),
        /** Null until the probe answers; null means "assume it works". */
        val capability: NegotiationCapability? = null,
        val eligible: List<EligibleItem> = emptyList(),
        val loadingEligible: Boolean = false,
        /** US-999: a deep link can scope the inbox to one listing. */
        val filterItemId: String? = null,
        val working: Boolean = false,
        val banner: String? = null,
        val errorMessage: String? = null,
    ) {
        val visibleOffers: List<BestOffer>
            get() = NegotiationRules.offersForItem(offers, filterItemId)

        val visibleMessages: List<BuyerMessage>
            get() = NegotiationRules.messagesForItem(messages, filterItemId)

        val showSendOffer: Boolean get() = NegotiationRules.showSendOfferEntry(capability)

        /** True when the entry point is visible but the feature isn't usable. */
        val sendOfferBlocked: Boolean get() = capability?.sendOfferAvailable == false

        val sendOfferDetail: String? get() = capability?.detail
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(filterItemId: String?) {
        _state.value = _state.value.copy(filterItemId = filterItemId?.takeIf { it.isNotBlank() })
        refresh()
    }

    fun refresh() {
        loadCapability()
        loadOffers()
        loadMessages()
    }

    /**
     * Probe before rendering any send-offer entry point.
     *
     * A FAILED probe deliberately changes nothing: a network blip must not hide
     * a feature that works, and the send path gates on its own 501 anyway.
     */
    private fun loadCapability() {
        viewModelScope.launch {
            runCatching { service.capability() }
                .onSuccess { _state.value = _state.value.copy(capability = it) }
                .onFailure { error ->
                    // An older edge with no /capabilities route still gates the
                    // send path — honour that answer when it says so.
                    if (error is EdgeApiError.FeatureUnavailable) {
                        _state.value = _state.value.copy(
                            capability = NegotiationCapability(
                                sendOfferAvailable = false,
                                code = "feature_unavailable",
                                detail = error.detail,
                            ),
                        )
                    }
                }
        }
    }

    private fun loadOffers() {
        _state.value = _state.value.copy(offersPhase = Phase.Loading)
        viewModelScope.launch {
            runCatching { service.offers() }
                .onSuccess {
                    _state.value = _state.value.copy(offers = it, offersPhase = Phase.Ready)
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        offersPhase = Phase.Failed(service.message(it)),
                    )
                }
        }
    }

    private fun loadMessages() {
        _state.value = _state.value.copy(messagesPhase = Phase.Loading)
        viewModelScope.launch {
            runCatching { service.messages() }
                .onSuccess {
                    _state.value = _state.value.copy(messages = it, messagesPhase = Phase.Ready)
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        messagesPhase = Phase.Failed(service.message(it)),
                    )
                }
        }
    }

    /** Clear a deep link's filter without leaving the inbox. */
    fun clearFilter() {
        _state.value = _state.value.copy(filterItemId = null)
    }

    // ── Offer actions ────────────────────────────────────────────────────────

    fun accept(offer: BestOffer) = respond(offer, OfferAction.ACCEPT)

    fun decline(offer: BestOffer) = respond(offer, OfferAction.DECLINE)

    /**
     * Counter at [priceText]. Returns nothing; the sheet watches [State.working]
     * and [State.errorMessage], so a rejected counter keeps the sheet open with
     * its numbers intact instead of dropping the seller back to the list.
     */
    fun counter(offer: BestOffer, priceText: String, message: String?) {
        val price = NegotiationRules.counterPrice(priceText)
        if (price == null) {
            _state.value = _state.value.copy(
                errorMessage = "Enter a counter price greater than zero.",
            )
            return
        }
        respond(offer, OfferAction.COUNTER, price, message)
    }

    private fun respond(
        offer: BestOffer,
        action: OfferAction,
        counterPrice: Double? = null,
        message: String? = null,
    ) {
        if (_state.value.working) return
        _state.value = _state.value.copy(working = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching {
                service.respond(
                    bestOfferId = offer.bestOfferId,
                    itemId = offer.itemId,
                    action = action,
                    counterPrice = counterPrice,
                    message = message,
                )
            }
                .onSuccess {
                    Telemetry.event("ebay_offer_responded", mapOf("action" to action.wire))
                    _state.value = _state.value.copy(
                        working = false,
                        // Dropped locally rather than waiting for a refetch: the
                        // offer is no longer actionable either way, and leaving
                        // it on screen invites a second, failing tap.
                        offers = _state.value.offers.filterNot {
                            it.bestOfferId == offer.bestOfferId
                        },
                        banner = when (action) {
                            OfferAction.ACCEPT -> "Offer accepted."
                            OfferAction.DECLINE -> "Offer declined."
                            OfferAction.COUNTER -> "Counter sent."
                        },
                    )
                }
                .onFailure { error ->
                    val stale = error is EdgeApiError.OfferNotOpen
                    _state.value = _state.value.copy(
                        working = false,
                        // A 409 means the buyer already moved. Refreshing is the
                        // honest response, not an error the seller can act on.
                        offers = if (stale) {
                            _state.value.offers.filterNot { it.bestOfferId == offer.bestOfferId }
                        } else {
                            _state.value.offers
                        },
                        banner = if (stale) service.message(error) else null,
                        errorMessage = if (stale) null else service.message(error),
                    )
                }
        }
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    fun reply(message: BuyerMessage, body: String) {
        val text = body.trim()
        val itemId = message.itemId.orEmpty()
        val recipient = message.senderUsername.orEmpty()
        if (text.isEmpty()) return
        if (itemId.isEmpty() || recipient.isEmpty()) {
            // eBay needs both to route a reply. Saying which piece is missing
            // beats a 400 the seller can't interpret.
            _state.value = _state.value.copy(
                errorMessage = "This message is missing the item or sender eBay needs to reply.",
            )
            return
        }
        if (_state.value.working) return
        _state.value = _state.value.copy(working = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching {
                service.reply(
                    messageId = message.messageId,
                    itemId = itemId,
                    recipientId = recipient,
                    body = text,
                )
            }
                .onSuccess {
                    _state.value = _state.value.copy(
                        working = false,
                        banner = "Reply sent.",
                        messages = _state.value.messages.map {
                            if (it.messageId == message.messageId) it.copy(answered = true) else it
                        },
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        working = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    // ── Send offer to interested buyers ──────────────────────────────────────

    fun loadEligible() {
        if (_state.value.loadingEligible) return
        _state.value = _state.value.copy(loadingEligible = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.eligibleItems() }
                .onSuccess {
                    _state.value = _state.value.copy(eligible = it, loadingEligible = false)
                }
                .onFailure { error ->
                    // A 501 here is the scope gate, not a failure to fix by
                    // retrying — record the capability so the entry point stops
                    // offering something that can't work.
                    val gated = error as? EdgeApiError.FeatureUnavailable
                    _state.value = _state.value.copy(
                        loadingEligible = false,
                        capability = if (gated != null) {
                            NegotiationCapability(
                                sendOfferAvailable = false,
                                code = "feature_unavailable",
                                detail = gated.detail,
                            )
                        } else {
                            _state.value.capability
                        },
                        errorMessage = if (gated == null) service.message(error) else null,
                    )
                }
        }
    }

    fun sendOffer(listingIds: List<String>, discountPercent: Int, message: String?) {
        if (listingIds.isEmpty() || _state.value.working) return
        _state.value = _state.value.copy(working = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { service.sendOffer(listingIds, discountPercent, message) }
                .onSuccess {
                    Telemetry.event(
                        "ebay_send_offer",
                        mapOf(
                            "listings" to listingIds.size,
                            "discount_pct" to NegotiationRules.discountPercent(discountPercent),
                        ),
                    )
                    _state.value = _state.value.copy(
                        working = false,
                        banner = "Offers sent to interested buyers on ${listingIds.size} listings.",
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        working = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, errorMessage = null)
    }
}
