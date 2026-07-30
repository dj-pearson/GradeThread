package com.gradethread.app.billing

import android.app.Activity
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * US-1366 AC4: a Play Store that does what the test says.
 *
 * `BillingClient`, `Purchase` and `ProductDetails` are final classes with no
 * public constructors, so the alternative to this is testing money-handling code
 * by buying things on a phone. It records what was consumed and acknowledged,
 * because the bugs that cost real money here are settlement bugs: consuming a
 * subscription kills it, and failing to acknowledge one gets it auto-refunded
 * after three days.
 */
class FakePlayBilling(
    var connected: Boolean = true,
) : PlayBilling {

    var catalog: MutableMap<PlayProductType, List<PlayProduct>> = mutableMapOf()
    var owned: MutableMap<PlayProductType, List<PlayPurchase>> = mutableMapOf()

    val launched = mutableListOf<Pair<PlayProduct, PlayProductType>>()
    val consumed = mutableListOf<String>()
    val acknowledged = mutableListOf<String>()

    /** Set false to model Play rejecting the settlement call. */
    var settlementSucceeds: Boolean = true

    /** Set false to model launchBillingFlow refusing to open. */
    var launchSucceeds: Boolean = true

    private val signals = MutableSharedFlow<PlaySignal>(
        replay = 0,
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    override val events: SharedFlow<PlaySignal> get() = signals

    /** Push what Play would have pushed. */
    fun emit(signal: PlaySignal) {
        signals.tryEmit(signal)
    }

    override suspend fun connect(): Boolean = connected

    override suspend fun products(
        productIds: List<String>,
        type: PlayProductType,
    ): List<PlayProduct> {
        if (!connected) return emptyList()
        return catalog[type].orEmpty().filter { it.productId in productIds }
    }

    override suspend fun launch(
        activity: Activity,
        product: PlayProduct,
        type: PlayProductType,
    ): Boolean {
        if (!connected) return false
        launched += product to type
        return launchSucceeds
    }

    override suspend fun purchases(type: PlayProductType): List<PlayPurchase> =
        if (connected) owned[type].orEmpty() else emptyList()

    override suspend fun consume(purchaseToken: String): Boolean {
        consumed += purchaseToken
        return settlementSucceeds
    }

    override suspend fun acknowledge(purchaseToken: String): Boolean {
        acknowledged += purchaseToken
        return settlementSucceeds
    }
}

/** A [PurchaseVerifier] that answers however the test needs it to. */
class FakePurchaseVerifier(
    var response: GooglePlayVerifyResponse = GooglePlayVerifyResponse(),
    var error: Throwable? = null,
) : PurchaseVerifier {

    val calls = mutableListOf<Pair<String, String>>()

    override suspend fun verify(
        productId: String,
        purchaseToken: String,
    ): GooglePlayVerifyResponse {
        calls += productId to purchaseToken
        error?.let { throw it }
        return response
    }
}
