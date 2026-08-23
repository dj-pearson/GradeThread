package com.gradethread.app.billing

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.grading.GradeTier
import com.gradethread.app.grading.GradingService
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1338: the in-flow credit top-up.
 *
 * The purchase funnel is instrumented end to end (blocked → started →
 * granted/timed-out) because the interesting number is not how many people buy
 * — it is how many get blocked, start a purchase, and then DON'T end up
 * unblocked. A timeout is indistinguishable from a lost sale without it.
 */
@HiltViewModel
class CreditTopUpViewModel @Inject constructor(
    private val billing: BillingRepository,
    /** Re-used as the balance read: validate already reports the credit balance. */
    private val grading: GradingService,
) : ViewModel() {

    data class State(
        val offers: List<CreditPackOffer> = CreditPack.entries.map { CreditPackOffer(it) },
        val phase: CreditTopUpFlow.State = CreditTopUpFlow.State.Idle,
        val errorMessage: String? = null,
    ) {
        val busy: Boolean
            get() = phase is CreditTopUpFlow.State.Purchasing ||
                phase is CreditTopUpFlow.State.AwaitingGrant
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** The item whose validation supplies the balance, and the tier in play. */
    private var itemId: String? = null
    private var tier: GradeTier = GradeTier.default

    /**
     * "single" or "bulk" — the funnel is compared across the two surfaces, so
     * they must be distinguishable and must use the same event names.
     */
    private var surface: String = TopUpSurface.SINGLE

    fun open(itemId: String, tier: GradeTier, creditsRequired: Int, surface: String = TopUpSurface.SINGLE) {
        this.itemId = itemId
        this.tier = tier
        this.surface = surface
        Telemetry.event(
            "grade.credits_blocked",
            mapOf("surface" to surface, "credits_required" to creditsRequired),
        )
        viewModelScope.launch {
            _state.value = _state.value.copy(offers = billing.creditPackOffers())
            // A purchase that was paid for but never verified (app killed,
            // network dropped) is otherwise invisible and the buyer is simply
            // out the money. Redeem before offering to sell them another.
            redeemOutstanding()
        }
    }

    private suspend fun redeemOutstanding() {
        val redeemed = billing.redeemOutstanding()
            .filterIsInstance<BillingRepository.PurchaseOutcome.Verified>()
        if (redeemed.isEmpty()) return
        Telemetry.event("grade.credits_topup_recovered", mapOf("count" to redeemed.size))
        _state.value = _state.value.copy(
            phase = CreditTopUpFlow.State.Granted(redeemed.last().creditsBalance),
        )
    }

    /**
     * Buy [pack].
     *
     * @param onGranted re-validate, so the server (not us) decides whether
     *   submit is unblocked.
     */
    fun purchase(activity: Activity, pack: CreditPack, onGranted: suspend () -> Unit) {
        if (_state.value.busy) return
        val baseline = currentBalance()
        Telemetry.event(
            "grade.credits_topup_started",
            mapOf("surface" to surface, "pack" to pack.productId, "baseline" to baseline),
        )
        _state.value = _state.value.copy(
            phase = CreditTopUpFlow.State.Purchasing,
            errorMessage = null,
        )

        viewModelScope.launch {
            if (!billing.launchPurchase(activity, pack)) {
                _state.value = _state.value.copy(
                    phase = CreditTopUpFlow.State.Idle,
                    errorMessage = "Google Play isn't available on this device, so credits " +
                        "can't be bought here. You can still buy them on the web.",
                )
                return@launch
            }

            when (val signal = billing.events.first()) {
                is PlaySignal.Cancelled ->
                    // Backing out of a purchase dialog is a decision, not a
                    // failure — saying "something went wrong" would be a lie.
                    _state.value = _state.value.copy(phase = CreditTopUpFlow.State.Idle)

                is PlaySignal.Error ->
                    _state.value = _state.value.copy(
                        phase = CreditTopUpFlow.State.Idle,
                        errorMessage = signal.message,
                    )

                is PlaySignal.Updated -> {
                    _state.value = _state.value.copy(phase = CreditTopUpFlow.State.AwaitingGrant)
                    settle(signal.purchases, baseline, onGranted)
                }
            }
        }
    }

    private suspend fun settle(purchases: List<PlayPurchase>, baseline: Int, onGranted: suspend () -> Unit) {
        val outcomes = purchases.map { billing.verifyAndSettle(it) }
        val failure = outcomes.filterIsInstance<BillingRepository.PurchaseOutcome.Failed>()
            .firstOrNull()
        val verifiedBalance = outcomes
            .filterIsInstance<BillingRepository.PurchaseOutcome.Verified>()
            .maxOfOrNull { it.creditsBalance }

        if (verifiedBalance == null && failure != null) {
            _state.value = _state.value.copy(
                phase = CreditTopUpFlow.State.Failed(failure.message),
                errorMessage = failure.message,
            )
            return
        }

        val terminal = CreditTopUpFlow.awaitGrant(
            baseline = baseline,
            verifiedBalance = verifiedBalance,
            fetchBalance = { fetchBalance() },
            sleep = { delay(it) },
        )
        _state.value = _state.value.copy(phase = terminal)

        when (terminal) {
            is CreditTopUpFlow.State.Granted -> Telemetry.event(
                "grade.credits_topup_granted",
                mapOf("surface" to surface, "balance" to terminal.balance),
            )
            CreditTopUpFlow.State.TimedOut ->
                Telemetry.event("grade.credits_topup_timeout", mapOf("surface" to surface))
            else -> Unit
        }
        // Re-validated even on TIMEOUT: the grant may have landed between the
        // last poll and now, and the server is the authority on whether submit
        // is unblocked — not our poll loop's patience.
        onGranted()
    }

    /** "Check again" after a timeout. */
    fun recheck(onGranted: suspend () -> Unit) {
        if (_state.value.busy) return
        val baseline = currentBalance()
        _state.value = _state.value.copy(phase = CreditTopUpFlow.State.AwaitingGrant)
        viewModelScope.launch {
            val terminal = CreditTopUpFlow.awaitGrant(
                baseline = baseline - 1, // any positive balance counts as "arrived"
                verifiedBalance = null,
                fetchBalance = { fetchBalance() },
                sleep = { delay(it) },
                maxPolls = 3,
            )
            _state.value = _state.value.copy(phase = terminal)
            onGranted()
        }
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    private var lastKnownBalance: Int = 0

    private fun currentBalance(): Int = lastKnownBalance

    fun observedBalance(balance: Int) {
        lastKnownBalance = balance
    }

    private suspend fun fetchBalance(): Int? {
        val id = itemId ?: return null
        return runCatching { grading.validate(id, tier).user.creditBalance }.getOrNull()
    }
}
