package com.gradethread.app.billing

import android.app.Activity
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

/** What the edge reports back after verifying a Play purchase. */
@Serializable
data class GooglePlayVerifyResponse(
    val plan: String = "free",
    val interval: String? = null,
    val status: String = "none",
    @SerialName("credits_balance") val creditsBalance: Int = 0,
) {
    val tier: PlanTier? get() = PlanTier.fromSlug(plan)
    val subscribed: Boolean get() = status == "active" && tier != null
}

/**
 * US-1338/US-1366: the Play Billing side of credits AND subscriptions.
 *
 * The client NEVER decides an entitlement. It hands the product id and the
 * purchase token to `POST /api/payments/google/verify`, which checks the token
 * with Google, maps the product through its own catalog and grants the plan or
 * the credits.
 *
 * Everything Play-specific lives behind [PlayBilling], so this whole class runs
 * against a fake in unit tests — the purchase paths that involve real money are
 * exactly the ones you cannot afford to check by hand.
 */
@Singleton
class BillingRepository @Inject constructor(
    private val play: PlayBilling,
    private val verifier: PurchaseVerifier,
) {

    companion object {
        /** Where a buyer goes when the fix isn't in this app. */
        const val WEB_BILLING_URL = "https://gradethread.com/dashboard/settings/billing"
    }

    sealed class PurchaseOutcome {
        /** Verified server-side; the response carries the post-grant state. */
        data class Verified(val entitlement: GooglePlayVerifyResponse) : PurchaseOutcome() {
            val creditsBalance: Int get() = entitlement.creditsBalance
        }

        /** The buyer backed out of Play's dialog. Not an error to report. */
        object Cancelled : PurchaseOutcome()

        /**
         * [conflict] non-null means the buyer must act somewhere else — retrying
         * here cannot work, and the UI should say where to go instead.
         */
        data class Failed(
            val message: String,
            val conflict: PlayPurchaseRules.Conflict? = null,
        ) : PurchaseOutcome()
    }

    /** Purchase results from Play, including renewals nobody tapped for. */
    val events: SharedFlow<PlaySignal> get() = play.events

    suspend fun connect(): Boolean = play.connect()

    // ── Credit packs (consumables) ───────────────────────────────────────────

    /**
     * Fetch Play's localized pricing for the credit packs.
     *
     * Returns fallback offers when Play is unavailable, so the paywall still
     * renders. It shows a price the buyer may not be charged, which is why the
     * purchase itself always goes through Play's own confirmed price — the
     * fallback is a label, never a commitment.
     */
    suspend fun creditPackOffers(): List<CreditPackOffer> {
        val details = play.products(CreditPack.productIds, PlayProductType.INAPP)
            .associateBy { it.productId }
        return CreditPack.entries.map { pack ->
            CreditPackOffer(pack, details[pack.productId]?.formattedPrice)
        }
    }

    /** Launch Play's purchase dialog. The result arrives on [events]. */
    suspend fun launchPurchase(activity: Activity, pack: CreditPack): Boolean =
        play.launch(activity, PlayProduct(pack.productId), PlayProductType.INAPP)

    // ── Subscriptions ────────────────────────────────────────────────────────

    /**
     * Play's localized pricing for the FlipDesk plans.
     *
     * Same fallback contract as the credit packs, with one addition: an offer
     * with no token is reported as not purchasable rather than silently priced,
     * because Play will refuse a subscription flow without one and the buyer
     * would just watch a dialog fail to open.
     */
    suspend fun subscriptionOffers(): List<SubscriptionOffer> {
        val details = play.products(SubscriptionProduct.productIds, PlayProductType.SUBS)
            .associateBy { it.productId }
        return SubscriptionProduct.entries.map { product ->
            val row = details[product.productId]
            SubscriptionOffer(product, row?.formattedPrice, row?.offerToken)
        }
    }

    /** Launch Play's subscription dialog. The result arrives on [events]. */
    suspend fun launchSubscription(activity: Activity, offer: SubscriptionOffer): Boolean {
        if (!offer.purchasable) return false
        return play.launch(
            activity,
            PlayProduct(offer.product.productId, offer.formattedPrice, offer.offerToken),
            PlayProductType.SUBS,
        )
    }

    /** What Play says this account currently subscribes to, if anything. */
    suspend fun activeSubscription(): PlayPurchase? =
        play.purchases(PlayProductType.SUBS)
            .firstOrNull { PlayPurchaseRules.redeemable(it) }

    // ── Verify + settle ──────────────────────────────────────────────────────

    /**
     * Verify a purchase server-side, then settle it with Play.
     *
     * ORDER IS DELIBERATE. Consuming makes the token unusable and acknowledging
     * is what stops Play auto-refunding, so both happen only after the server
     * has confirmed the grant — otherwise a buyer whose connection dropped
     * between paying and verifying would have destroyed the only proof of their
     * purchase.
     */
    suspend fun verifyAndSettle(purchase: PlayPurchase): PurchaseOutcome {
        if (purchase.state == PlayPurchaseState.PENDING) {
            // Play's cash-payment flow: nothing has been paid yet, so there is
            // nothing to grant. Play delivers the completed purchase later.
            return PurchaseOutcome.Failed("This purchase is still pending with Google Play.")
        }
        if (!PlayPurchaseRules.redeemable(purchase)) {
            return PurchaseOutcome.Failed("That purchase didn't name a product we sell.")
        }
        val productId = purchase.productId!!

        val response = runCatching {
            verifier.verify(productId, purchase.purchaseToken)
        }.getOrElse { error ->
            val conflict = PlayPurchaseRules.conflict(error)
            Telemetry.breadcrumb(
                "play verify failed: ${conflict ?: error.message}",
                "billing",
            )
            // Not settled — Play redelivers the purchase, and verify is
            // idempotent by token, so a transient failure costs nothing.
            return PurchaseOutcome.Failed(
                conflict?.message
                    ?: (error as? EdgeApiError)?.userMessage()
                    ?: "We couldn't confirm that purchase. It's safe — reopen this screen " +
                    "to finish it.",
                conflict,
            )
        }

        settle(purchase)
        return PurchaseOutcome.Verified(response)
    }

    private suspend fun settle(purchase: PlayPurchase) {
        val settlement = PlayPurchaseRules.settlement(purchase)
        val ok = when (settlement) {
            PlayPurchaseRules.Settlement.CONSUME -> play.consume(purchase.purchaseToken)
            PlayPurchaseRules.Settlement.ACKNOWLEDGE -> play.acknowledge(purchase.purchaseToken)
            PlayPurchaseRules.Settlement.NONE -> true
        }
        if (!ok) {
            // The grant already landed, so this is not the buyer's problem. Play
            // redelivers an unsettled purchase and verify is idempotent.
            Telemetry.breadcrumb("play $settlement failed for ${purchase.productId}", "billing")
        }
    }

    /**
     * Redeem anything Play is still holding for this account.
     *
     * Called when a paywall opens: a purchase that was paid for but never
     * verified (app killed mid-flow, network dropped, a renewal that arrived
     * while the app was closed) is otherwise invisible, and the buyer is out the
     * money with nothing to show.
     */
    suspend fun redeemOutstanding(): List<PurchaseOutcome> {
        if (!play.connect()) return emptyList()
        val outstanding = play.purchases(PlayProductType.INAPP) +
            play.purchases(PlayProductType.SUBS)
        return outstanding
            .filter { PlayPurchaseRules.redeemable(it) }
            .map { verifyAndSettle(it) }
    }
}
