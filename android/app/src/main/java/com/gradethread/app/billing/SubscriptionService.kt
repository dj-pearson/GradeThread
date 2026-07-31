package com.gradethread.app.billing

import android.app.Activity
import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1366: the app's one view of "what does this account currently pay for".
 *
 * Everything here goes through the server. Play tells us a purchase happened;
 * only `POST /api/payments/google/verify` decides what it entitles. That split
 * is what keeps a rooted device from granting itself Business.
 *
 * It also runs for the whole process, because the events that matter most
 * arrive unprompted: Play pushes a RENEWAL through the same listener as a fresh
 * purchase, carrying a token the server has never seen. Re-verifying it is how
 * the period end moves forward without waiting on a webhook.
 */
@Singleton
class SubscriptionService @Inject constructor(
    private val billing: BillingRepository,
) {

    data class State(
        val entitlement: GooglePlayVerifyResponse? = null,
        val offers: List<SubscriptionOffer> = SubscriptionProduct.entries.map {
            SubscriptionOffer(it)
        },
        val purchasing: Boolean = false,
        val loadingOffers: Boolean = false,
        /** Set when the buyer must act outside this app. */
        val conflict: PlayPurchaseRules.Conflict? = null,
        val errorMessage: String? = null,
        /** True once Play has been asked at least once, success or not. */
        val loaded: Boolean = false,
    ) {
        val plan: PlanTier? get() = entitlement?.tier
        val subscribed: Boolean get() = entitlement?.subscribed == true
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Start listening for the purchases Play sends us on its own schedule.
     *
     * Call once from the application scope. Renewals and purchases completed on
     * another device both arrive this way, and neither has a screen open to
     * catch them.
     */
    fun observe(scope: CoroutineScope) {
        scope.launch {
            billing.events.collect { signal ->
                // "You already own this" is the one Play error that isn't one:
                // it means an earlier purchase was paid for and never verified,
                // so the fix is to redeem it, not to show a failure.
                if (signal is PlaySignal.Error && signal.alreadyOwned) {
                    refresh()
                    return@collect
                }
                val purchases = PlayPurchaseRules.shouldReverify(signal)
                if (purchases.isEmpty()) return@collect
                Telemetry.breadcrumb("play purchases updated (${purchases.size})", "billing")
                purchases.forEach { apply(billing.verifyAndSettle(it)) }
            }
        }
    }

    /** Load Play's prices and redeem anything still outstanding. */
    suspend fun refresh() {
        _state.value = _state.value.copy(loadingOffers = true)
        val offers = billing.subscriptionOffers()
        // A purchase that was paid for but never verified is invisible
        // otherwise, and the buyer is out the money with nothing to show.
        val recovered = billing.redeemOutstanding()
        val stillOwned = billing.activeSubscription() != null
        _state.value = _state.value.copy(
            offers = offers,
            loadingOffers = false,
            loaded = true,
        )
        recovered.forEach { apply(it) }

        // Refund or revoke. Play never pushes those to the client — it tells the
        // SERVER through a Real-time Developer Notification — so all we can
        // honestly do is stop showing a plan Play no longer backs. Note the
        // direction: this only ever REMOVES an entitlement. Granting one from
        // what the device believes is how a rooted phone gets Business for free.
        if (!stillOwned && _state.value.subscribed && recovered.isEmpty()) {
            Telemetry.breadcrumb("play no longer owns a subscription", "billing")
            _state.value = _state.value.copy(entitlement = null)
        }
    }

    /**
     * Buy [offer]. Returns false when Play never opened its dialog — the
     * outcome of a dialog that DID open arrives through [observe].
     */
    suspend fun purchase(activity: Activity, offer: SubscriptionOffer): Boolean {
        if (_state.value.purchasing) return false
        _state.value = _state.value.copy(
            purchasing = true,
            errorMessage = null,
            conflict = null,
        )
        Telemetry.event(
            "billing.subscribe_started",
            mapOf("product" to offer.product.productId),
        )
        val launched = billing.launchSubscription(activity, offer)
        if (!launched) {
            _state.value = _state.value.copy(
                purchasing = false,
                errorMessage = if (offer.purchasable) {
                    "Google Play couldn't open the purchase screen. Try again, or subscribe " +
                        "on the web."
                } else {
                    // Naming the real reason: an offer with no token is not a
                    // transient failure, and "try again" would never work.
                    "That plan isn't available through Google Play right now. You can " +
                        "subscribe on the web."
                },
            )
        }
        return launched
    }

    /**
     * Fold a verify outcome into the state.
     *
     * A conflict clears `purchasing` and is KEPT on state rather than shown as a
     * one-shot toast: the buyer has to go somewhere else to fix it, and a
     * message that disappears while they are reading it is no help.
     */
    private fun apply(outcome: BillingRepository.PurchaseOutcome) {
        when (outcome) {
            is BillingRepository.PurchaseOutcome.Verified -> {
                Telemetry.event(
                    "billing.subscribe_verified",
                    mapOf(
                        "plan" to outcome.entitlement.plan,
                        "status" to outcome.entitlement.status,
                    ),
                )
                _state.value = _state.value.copy(
                    entitlement = outcome.entitlement,
                    purchasing = false,
                    conflict = null,
                    errorMessage = null,
                )
            }

            is BillingRepository.PurchaseOutcome.Failed -> {
                outcome.conflict?.let {
                    Telemetry.event("billing.subscribe_conflict", mapOf("kind" to it.toString()))
                }
                _state.value = _state.value.copy(
                    purchasing = false,
                    conflict = outcome.conflict,
                    errorMessage = outcome.message,
                )
            }

            BillingRepository.PurchaseOutcome.Cancelled ->
                _state.value = _state.value.copy(purchasing = false)
        }
    }

    /** Where to send a buyer whose fix isn't in this app. */
    fun webBillingUrl(): String = BillingRepository.WEB_BILLING_URL

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null, conflict = null)
    }
}
