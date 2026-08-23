package com.gradethread.app.billing

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-2830: buying grades from inside the CONSUMER photo-grade flow.
 *
 * ⚠ WHY THIS IS NOT [CreditTopUpViewModel]. That one is the FlipDesk paywall and
 * it is coupled to an inventory item: after a purchase it polls
 * `grading.validate(itemId, tier)` to watch the balance move. The consumer flow
 * has a submission, not an item, so that poll would call validate on an id it
 * does not own.
 *
 * It does not need the poll at all, which is the useful half of the finding.
 * `POST /api/grade/pay/:id` is IDEMPOTENT per submission — it passes
 * `grade_pay:{submissionId}` as the debit's idempotency key, added by US-2298
 * after two concurrent calls charged a customer twice. So re-calling pay after a
 * purchase cannot double-charge, and the server's answer to "did the grant
 * land?" is simply whether that call now succeeds.
 *
 * `ConsumerGradeFlow.creditsPurchased()` already does exactly that and has had
 * no caller since US-2016. This view model is the purchase half in front of it.
 *
 * Everything below the purchase — Play connection, product query, verification,
 * settlement, redeeming an unverified purchase — is [BillingRepository] as it
 * already stands. It takes no item id and no tier, which is what makes reusing
 * it possible rather than a refactor.
 */
@HiltViewModel
class ConsumerCreditTopUpViewModel @Inject constructor(private val billing: BillingRepository) : ViewModel() {

    data class State(
        val offers: List<CreditPackOffer> = CreditPack.entries.map { CreditPackOffer(it) },
        val purchasing: Boolean = false,
        val errorMessage: String? = null,
        /**
         * A purchase that had already been paid for and never verified, found
         * and settled on open. Surfaced so the seller is told rather than left
         * to wonder why their balance moved on its own.
         */
        val recoveredCount: Int = 0,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Load the price list, and settle anything already bought.
     *
     * REDEEM BEFORE OFFERING TO SELL AGAIN. A purchase that was paid for but
     * never verified — the app was killed, the network dropped — is otherwise
     * invisible and the buyer is simply out the money. The FlipDesk sheet has
     * done this since US-1338; the consumer path had no equivalent, which is
     * AC5 of this story.
     */
    fun open(onRecovered: suspend () -> Unit) {
        viewModelScope.launch {
            _state.value = _state.value.copy(offers = billing.creditPackOffers())
            val redeemed = billing.redeemOutstanding()
                .filterIsInstance<BillingRepository.PurchaseOutcome.Verified>()
            if (redeemed.isEmpty()) return@launch
            Telemetry.event(
                "grade.credits_topup_recovered",
                mapOf("surface" to SURFACE, "count" to redeemed.size),
            )
            _state.value = _state.value.copy(recoveredCount = redeemed.size)
            onRecovered()
        }
    }

    /**
     * Buy [pack], then hand back to the flow.
     *
     * @param onPurchased call `ConsumerGradeFlow.creditsPurchased()`. The SERVER
     *   decides whether the submission is now paid; this never concludes it.
     */
    fun purchase(activity: Activity, pack: CreditPack, onPurchased: suspend () -> Unit) {
        if (_state.value.purchasing) return
        Telemetry.event(
            "grade.credits_topup_started",
            mapOf("surface" to SURFACE, "pack" to pack.productId),
        )
        _state.value = _state.value.copy(purchasing = true, errorMessage = null)

        viewModelScope.launch {
            if (!billing.launchPurchase(activity, pack)) {
                _state.value = _state.value.copy(
                    purchasing = false,
                    errorMessage = "Google Play isn't available on this device, so grades " +
                        "can't be bought here. You can still buy them on the web.",
                )
                return@launch
            }

            when (val signal = billing.events.first()) {
                // Backing out of a purchase dialog is a decision, not a failure.
                // Saying "something went wrong" would be a lie.
                is PlaySignal.Cancelled ->
                    _state.value = _state.value.copy(purchasing = false)

                is PlaySignal.Error ->
                    _state.value = _state.value.copy(
                        purchasing = false,
                        errorMessage = signal.message,
                    )

                is PlaySignal.Updated -> settle(signal.purchases, onPurchased)
            }
        }
    }

    private suspend fun settle(purchases: List<PlayPurchase>, onPurchased: suspend () -> Unit) {
        val outcomes = purchases.map { billing.verifyAndSettle(it) }
        val verified = outcomes.filterIsInstance<BillingRepository.PurchaseOutcome.Verified>()
        val failure = outcomes.filterIsInstance<BillingRepository.PurchaseOutcome.Failed>()
            .firstOrNull()

        if (verified.isEmpty() && failure != null) {
            _state.value = _state.value.copy(purchasing = false, errorMessage = failure.message)
            return
        }

        Telemetry.event(
            "grade.credits_topup_granted",
            mapOf("surface" to SURFACE, "packs" to verified.size),
        )
        _state.value = _state.value.copy(purchasing = false)
        // HANDED BACK EVEN IF ONE OF SEVERAL FAILED: at least one grant landed,
        // and the pay route is the authority on whether that is enough for this
        // submission. Deciding here would be this client second-guessing it.
        onPurchased()
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    private companion object {
        /**
         * The funnel is compared across surfaces, so this uses the SAME event
         * names as the FlipDesk sheet and differs only in this value. A
         * separate event name would make the consumer path invisible in the
         * charts that already exist.
         */
        val SURFACE = TopUpSurface.CONSUMER
    }
}
