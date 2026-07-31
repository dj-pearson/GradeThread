package com.gradethread.app.billing

import android.app.Activity
import kotlinx.coroutines.flow.SharedFlow

/**
 * US-1366: the seam between our billing logic and Google Play.
 *
 * Everything crossing this boundary is a plain Kotlin type. That is the whole
 * point: `BillingClient`, `Purchase` and `ProductDetails` are final classes with
 * package-private constructors, so any code that touches them directly can only
 * be tested on a device with a real Play Store and a real card. Behind this
 * interface the purchase flow runs against [FakePlayBilling] in a plain JVM
 * test, which is the difference between "we think refunds are handled" and
 * knowing it.
 */
interface PlayBilling {

    /** Purchase results Play pushes at us, including ones we didn't ask for. */
    val events: SharedFlow<PlaySignal>

    /** Connect if needed. False means Play Billing is unusable on this device. */
    suspend fun connect(): Boolean

    /** Play's catalog rows for [productIds]. Missing ids are simply absent. */
    suspend fun products(productIds: List<String>, type: PlayProductType): List<PlayProduct>

    /** Open Play's purchase dialog. The outcome arrives on [events], not here. */
    suspend fun launch(activity: Activity, product: PlayProduct, type: PlayProductType): Boolean

    /** What Play currently says this account owns. */
    suspend fun purchases(type: PlayProductType): List<PlayPurchase>

    /** Consumables only — makes the token unusable and re-buyable. */
    suspend fun consume(purchaseToken: String): Boolean

    /** Subscriptions and non-consumables. Play refunds an unacknowledged buy. */
    suspend fun acknowledge(purchaseToken: String): Boolean
}

enum class PlayProductType { INAPP, SUBS }

enum class PlayPurchaseState { PURCHASED, PENDING, UNSPECIFIED }

/**
 * A catalog row.
 *
 * [offerToken] is required to buy a subscription and meaningless for a one-time
 * product — Play models a subscription as a product with one or more offers
 * (base plan, intro price, free trial), and the flow must name which one.
 */
data class PlayProduct(
    val productId: String,
    val formattedPrice: String? = null,
    val offerToken: String? = null,
)

data class PlayPurchase(
    val productIds: List<String>,
    val purchaseToken: String,
    val state: PlayPurchaseState,
    val acknowledged: Boolean = false,
    /**
     * Subscriptions only. False means the buyer cancelled but keeps access
     * until the period ends — NOT that access is gone.
     */
    val autoRenewing: Boolean = false,
    val orderId: String? = null,
) {
    /** Play allows multi-product purchases; ours are always one. */
    val productId: String? get() = productIds.firstOrNull()
}

sealed class PlaySignal {
    /** One or more purchases became ours. Includes renewals we didn't start. */
    data class Updated(val purchases: List<PlayPurchase>) : PlaySignal()

    /** The buyer backed out of Play's dialog. A decision, not a failure. */
    object Cancelled : PlaySignal()

    /**
     * Play refused. [alreadyOwned] separates the one case that is not really an
     * error: buying something this account already has, which usually means an
     * earlier purchase never got verified and should be redeemed instead.
     */
    data class Error(
        val message: String,
        val responseCode: Int = 0,
        val alreadyOwned: Boolean = false,
    ) : PlaySignal()
}
