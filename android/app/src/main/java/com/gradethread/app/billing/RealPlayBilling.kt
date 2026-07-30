package com.gradethread.app.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.acknowledgePurchase
import com.android.billingclient.api.consumePurchase
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * US-1366: the only class in the app that talks to Play Billing.
 *
 * Deliberately thin — it translates, it does not decide. Every judgement about
 * what a purchase means lives in [PlayPurchaseRules] and [BillingRepository],
 * where it can be tested. Anything clever added here is untestable by
 * construction.
 *
 * [ProductDetails] objects are cached from the last catalog read because
 * `launchBillingFlow` needs the object Play handed us, not an id, and re-querying
 * inside the launch would put a network round trip between the buyer's tap and
 * the dialog.
 */
@Singleton
class RealPlayBilling @Inject constructor(
    @ApplicationContext private val context: Context,
) : PlayBilling {

    private val detailsCache = ConcurrentHashMap<String, ProductDetails>()

    private val purchaseEvents = MutableSharedFlow<PlaySignal>(
        replay = 0,
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    override val events: SharedFlow<PlaySignal> get() = purchaseEvents

    private val listener = PurchasesUpdatedListener { result, purchases ->
        purchaseEvents.tryEmit(
            when (result.responseCode) {
                BillingClient.BillingResponseCode.OK ->
                    PlaySignal.Updated(purchases.orEmpty().map { it.toPlayPurchase() })
                BillingClient.BillingResponseCode.USER_CANCELED -> PlaySignal.Cancelled
                BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> PlaySignal.Error(
                    describe(result),
                    result.responseCode,
                    alreadyOwned = true,
                )
                else -> PlaySignal.Error(describe(result), result.responseCode)
            },
        )
    }

    private val client: BillingClient = BillingClient.newBuilder(context)
        .setListener(listener)
        // Required from Billing 7: declares we handle one-time products.
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder().enableOneTimeProducts().build(),
        )
        .build()

    override suspend fun connect(): Boolean {
        if (client.isReady) return true
        return suspendCancellableCoroutine { continuation ->
            client.startConnection(
                object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (continuation.isActive) {
                            continuation.resume(
                                result.responseCode == BillingClient.BillingResponseCode.OK,
                            )
                        }
                    }

                    override fun onBillingServiceDisconnected() {
                        // Reconnection is handled by the next connect() call —
                        // resuming false here would race the success path.
                    }
                },
            )
        }
    }

    override suspend fun products(
        productIds: List<String>,
        type: PlayProductType,
    ): List<PlayProduct> {
        if (productIds.isEmpty() || !connect()) return emptyList()
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                productIds.map { id ->
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(id)
                        .setProductType(type.playType())
                        .build()
                },
            )
            .build()

        val details = runCatching { client.queryProductDetails(params) }
            .getOrNull()
            ?.productDetailsList
            .orEmpty()
        details.forEach { detailsCache[it.productId] = it }
        return details.map { it.toPlayProduct() }
    }

    override suspend fun launch(
        activity: Activity,
        product: PlayProduct,
        type: PlayProductType,
    ): Boolean {
        if (!connect()) return false
        if (!detailsCache.containsKey(product.productId)) {
            // Warms the cache. Only reachable if the caller launches a product
            // the catalog read never returned.
            products(listOf(product.productId), type)
        }
        val details = detailsCache[product.productId] ?: return false

        val paramsBuilder = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
        if (type == PlayProductType.SUBS) {
            // A subscription without an offer token is not purchasable. Refusing
            // is better than launching a dialog that fails in front of the buyer.
            val offer = product.offerToken
                ?: details.subscriptionOfferDetails?.firstOrNull()?.offerToken
                ?: return false
            paramsBuilder.setOfferToken(offer)
        }

        val flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(paramsBuilder.build()))
            .build()
        return client.launchBillingFlow(activity, flow).responseCode ==
            BillingClient.BillingResponseCode.OK
    }

    override suspend fun purchases(type: PlayProductType): List<PlayPurchase> {
        if (!connect()) return emptyList()
        val params = QueryPurchasesParams.newBuilder()
            .setProductType(type.playType())
            .build()
        return runCatching { client.queryPurchasesAsync(params).purchasesList }
            .getOrNull()
            .orEmpty()
            .map { it.toPlayPurchase() }
    }

    override suspend fun consume(purchaseToken: String): Boolean = runCatching {
        client.consumePurchase(
            ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build(),
        ).billingResult.responseCode == BillingClient.BillingResponseCode.OK
    }.getOrDefault(false)

    override suspend fun acknowledge(purchaseToken: String): Boolean = runCatching {
        client.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken).build(),
        ).responseCode == BillingClient.BillingResponseCode.OK
    }.getOrDefault(false)

    private fun PlayProductType.playType(): String = when (this) {
        PlayProductType.INAPP -> BillingClient.ProductType.INAPP
        PlayProductType.SUBS -> BillingClient.ProductType.SUBS
    }

    private fun ProductDetails.toPlayProduct(): PlayProduct {
        val offer = subscriptionOfferDetails?.firstOrNull()
        return PlayProduct(
            productId = productId,
            formattedPrice = oneTimePurchaseOfferDetails?.formattedPrice
                // A subscription's price lives on its LAST pricing phase: an
                // offer that opens with a free trial or an intro price lists
                // that first, and quoting it as the price would tell a buyer
                // the plan costs $0.
                ?: offer?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice,
            offerToken = offer?.offerToken,
        )
    }

    private fun Purchase.toPlayPurchase(): PlayPurchase = PlayPurchase(
        productIds = products,
        purchaseToken = purchaseToken,
        state = when (purchaseState) {
            Purchase.PurchaseState.PURCHASED -> PlayPurchaseState.PURCHASED
            Purchase.PurchaseState.PENDING -> PlayPurchaseState.PENDING
            else -> PlayPurchaseState.UNSPECIFIED
        },
        acknowledged = isAcknowledged,
        autoRenewing = isAutoRenewing,
        orderId = orderId,
    )

    private fun describe(result: BillingResult): String =
        result.debugMessage.takeIf { it.isNotBlank() }
            ?: "Play Billing error ${result.responseCode}"
}
