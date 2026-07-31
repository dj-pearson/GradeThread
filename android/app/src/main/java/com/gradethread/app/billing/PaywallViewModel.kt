package com.gradethread.app.billing

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1367: the paywall.
 *
 * The current plan comes from the SERVER, not from what Play last told us. Play
 * knows what was bought on this device; the account may be paying through
 * Stripe on the web or through the App Store, and a paywall that offers someone
 * the plan they already have will happily charge them twice.
 */
@HiltViewModel
class PaywallViewModel @Inject constructor(
    private val subscriptions: SubscriptionService,
    private val billing: BillingRepository,
    private val plans: AccountPlanReader,
) : ViewModel() {

    data class State(
        val interval: SubscriptionInterval = SubscriptionInterval.YEARLY,
        val rows: List<PaywallPricing.TierRow> = emptyList(),
        val creditPacks: List<CreditPackOffer> = CreditPack.entries.map { CreditPackOffer(it) },
        val currentPlan: PlanTier? = null,
        val loading: Boolean = true,
        val purchasing: Boolean = false,
        val conflict: PlayPurchaseRules.Conflict? = null,
        val errorMessage: String? = null,
    ) {
        /** The yearly toggle's headline, e.g. "Save up to 17%". */
        val yearlyPitch: String?
            get() = PaywallPricing.bestYearlySavingsPercent()?.let { "Save up to $it%" }
    }

    private val interval = MutableStateFlow(SubscriptionInterval.YEARLY)
    private val serverPlan = MutableStateFlow<PlanTier?>(null)
    private val creditPacks =
        MutableStateFlow(CreditPack.entries.map { CreditPackOffer(it) })
    private val loading = MutableStateFlow(true)

    val state: StateFlow<State> = combine(
        subscriptions.state,
        interval,
        serverPlan,
        creditPacks,
        loading,
    ) { subs, chosen, plan, packs, isLoading ->
        // The server's answer wins; Play's verify response is the fallback for
        // the moment right after a purchase, before the row is re-read.
        val current = plan ?: subs.plan
        State(
            interval = chosen,
            rows = PaywallPricing.rows(subs.offers, chosen, current),
            creditPacks = packs,
            currentPlan = current,
            loading = isLoading,
            purchasing = subs.purchasing,
            conflict = subs.conflict,
            errorMessage = subs.errorMessage,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    fun load() {
        loading.value = true
        Telemetry.screen("paywall")
        viewModelScope.launch {
            // Play's catalog and the plan row are independent; neither should
            // hold the other up, and the paywall renders with fallback prices
            // either way.
            launch { subscriptions.refresh() }
            launch { creditPacks.value = billing.creditPackOffers() }
            serverPlan.value = plans.current()
            loading.value = false
        }
    }

    fun setInterval(value: SubscriptionInterval) {
        interval.value = value
    }

    fun subscribe(activity: Activity, row: PaywallPricing.TierRow) {
        if (!row.purchasable) return
        viewModelScope.launch { subscriptions.purchase(activity, row.offer) }
    }

    fun buyCredits(activity: Activity, pack: CreditPack) {
        viewModelScope.launch {
            Telemetry.event("paywall.credits_started", mapOf("pack" to pack.productId))
            billing.launchPurchase(activity, pack)
            // The outcome lands on the process-wide purchases listener, which
            // verifies and settles it. Nothing to await here.
        }
    }

    /** "I already paid" — re-checks Play for anything unredeemed. */
    fun restore() {
        viewModelScope.launch { subscriptions.refresh() }
    }

    fun dismissError() {
        subscriptions.dismissError()
    }

    fun webBillingUrl(): String = subscriptions.webBillingUrl()
}
