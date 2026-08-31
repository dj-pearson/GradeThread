package com.gradethread.app.billing

import com.gradethread.app.platform.net.EdgeApiError

/**
 * US-1366: every judgement the billing flow makes, with no Play Store and no
 * network behind it.
 *
 * Pure on purpose. The decisions here are the ones that cost real money when
 * they are wrong — consuming a subscription, acknowledging a consumable,
 * treating "you already pay on the web" as a generic failure — and none of them
 * should need a card and a device to check.
 */
object PlayPurchaseRules {

    /** What Play needs done with a purchase once the server has granted it. */
    enum class Settlement {
        /** Consumables: makes the token unusable so the pack can be bought again. */
        CONSUME,

        /** Subscriptions: Play auto-refunds an unacknowledged purchase in 3 days. */
        ACKNOWLEDGE,

        /** Already acknowledged, or a product we don't recognize — leave it alone. */
        NONE,
    }

    /**
     * Which product type a Play product id belongs to.
     *
     * Returns null for an id in neither catalog. That is not paranoia: Play
     * delivers purchases we did not initiate (a renewal, a purchase made on
     * another device, a promo code redemption), so the flow genuinely does meet
     * ids it has never asked for.
     */
    fun productType(productId: String?): PlayProductType? = when {
        CreditPack.fromProductId(productId) != null -> PlayProductType.INAPP
        SubscriptionProduct.fromProductId(productId) != null -> PlayProductType.SUBS
        else -> null
    }

    fun settlement(purchase: PlayPurchase): Settlement {
        val type = productType(purchase.productId) ?: return Settlement.NONE
        return when {
            type == PlayProductType.INAPP -> Settlement.CONSUME
            purchase.acknowledged -> Settlement.NONE
            else -> Settlement.ACKNOWLEDGE
        }
    }

    /**
     * Is this purchase worth sending to the server?
     *
     * PENDING purchases (Play's cash-at-a-kiosk flow) are not: nothing has been
     * paid yet, and verifying one just produces a failure the buyer can't act
     * on. Play delivers the completed purchase later.
     */
    fun redeemable(purchase: PlayPurchase): Boolean = purchase.state == PlayPurchaseState.PURCHASED &&
        productType(purchase.productId) != null

    // ── What a failed verify actually means ──────────────────────────────────

    /**
     * A verify that failed for a reason the buyer can DO something about.
     *
     * The point of naming these is that the generic message is wrong for every
     * one of them. "Something went wrong, try again" to someone already paying
     * on the web will have them tap it forever.
     */
    sealed class Conflict {
        /** Already subscribed through Stripe on the web. Play must not double-bill. */
        object ActiveStripeSubscription : Conflict()

        /** Already subscribed through the App Store. Managed on the iOS device. */
        object ActiveAppStoreSubscription : Conflict()

        /** The Play purchase belongs to a different GradeThread account. */
        object PurchaseNotOwned : Conflict()

        /** Play billing isn't configured on the server yet. */
        object NotConfigured : Conflict()

        val message: String
            get() = when (this) {
                ActiveStripeSubscription ->
                    "You already have a subscription billed on the web. Manage or cancel it " +
                        "there first, then you can subscribe through Google Play."
                ActiveAppStoreSubscription ->
                    "You already have a subscription billed through the App Store. Manage it " +
                        "on your iPhone or iPad."
                PurchaseNotOwned ->
                    "That Google Play purchase belongs to a different GradeThread account. " +
                        "Sign in with that account to use it."
                NotConfigured ->
                    "Google Play purchases aren't switched on yet. You can subscribe on the web."
            }

        /** Whether the fix lives on gradethread.com rather than in this app. */
        val routesToWeb: Boolean
            get() = this == ActiveStripeSubscription || this == NotConfigured
    }

    /**
     * Classify a verify failure.
     *
     * Keyed on the server's `error` STRING rather than the status code, because
     * the codes are shared: 409 is also "offer not open" elsewhere, and 403 maps
     * to [EdgeApiError.Unauthorized] whose copy ("your session expired, sign in
     * again") would send a buyer to re-authenticate over a purchase that simply
     * belongs to someone else.
     */
    fun conflict(error: Throwable?): Conflict? {
        val body = when (error) {
            is EdgeApiError.SubscriptionConflict -> return when (error.source) {
                EdgeApiError.SubscriptionSource.STRIPE -> Conflict.ActiveStripeSubscription
                EdgeApiError.SubscriptionSource.APPSTORE -> Conflict.ActiveAppStoreSubscription
            }
            is EdgeApiError.PurchaseNotOwned -> return Conflict.PurchaseNotOwned
            is EdgeApiError.BadRequest -> error.body ?: error.detail
            is EdgeApiError.ServerError -> error.detail
            else -> null
        } ?: return null

        // The typed cases above are the normal path. This is the fallback for a
        // body that reached us as plain text — a proxy rewrite, an older edge
        // build — where the marker is still readable but the shape isn't.
        return when {
            body.contains("ACTIVE_STRIPE_SUBSCRIPTION") -> Conflict.ActiveStripeSubscription
            body.contains("ACTIVE_APPSTORE_SUBSCRIPTION") -> Conflict.ActiveAppStoreSubscription
            body.contains("PURCHASE_NOT_OWNED_BY_ACCOUNT") -> Conflict.PurchaseNotOwned
            body.contains("Google Play billing is not configured") -> Conflict.NotConfigured
            else -> null
        }
    }

    /**
     * Should a failed verify leave the purchase for another attempt?
     *
     * Yes for anything transient, NO for a conflict. Keeping an unredeemable
     * purchase around means every paywall visit retries it and shows the same
     * dead end; the buyer's actual route out is elsewhere.
     */
    fun retryable(error: Throwable?): Boolean = conflict(error) == null

    // ── What Play told us without being asked ────────────────────────────────

    /**
     * Whether an entitlement refresh is warranted after a purchases-update.
     *
     * Play pushes renewals through the same listener as fresh purchases, and a
     * renewal carries a NEW token the server has never seen. Re-verifying is how
     * the plan's period end moves forward without waiting for a webhook.
     *
     * Refunds and revokes do NOT arrive here — Play tells the SERVER through a
     * Real-time Developer Notification, not the client. So the client never
     * decides someone lost access; it re-reads what the server already knows.
     */
    fun shouldReverify(signal: PlaySignal): List<PlayPurchase> = when (signal) {
        is PlaySignal.Updated -> signal.purchases.filter { redeemable(it) }
        else -> emptyList()
    }
}
