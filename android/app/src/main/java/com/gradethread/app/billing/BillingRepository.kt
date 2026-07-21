package com.gradethread.app.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.acknowledgePurchase
import com.android.billingclient.api.consumePurchase
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton
import kotlin.coroutines.resume

/** What the edge reports back after verifying a Play purchase. */
@Serializable
data class GooglePlayVerifyResponse(
    val plan: String = "free",
    val interval: String? = null,
    val status: String = "none",
    @SerialName("credits_balance") val creditsBalance: Int = 0,
)

@Serializable
private data class GooglePlayVerifyRequest(
    val productId: String,
    val purchaseToken: String,
)

/**
 * US-1338: the Play Billing half of the credit top-up.
 *
 * The client NEVER decides an entitlement. It hands the product id and the
 * purchase token to `POST /api/payments/google/verify`, which checks the token
 * with Google, maps the product through its own catalog and grants the
 * credits. That is also why the purchase is consumed only AFTER the server
 * confirms: consuming first would make the token unrecoverable, and a buyer who
 * lost their network between paying and verifying would have paid for nothing.
 */
@Singleton
class BillingRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        const val VERIFY_PATH = "/api/payments/google/verify"
        private val json = Json { ignoreUnknownKeys = true }
    }

    sealed class PurchaseOutcome {
        /** Verified server-side; [creditsBalance] is the post-grant balance. */
        data class Verified(val creditsBalance: Int) : PurchaseOutcome()

        /** The buyer backed out of Play's dialog. Not an error to report. */
        object Cancelled : PurchaseOutcome()

        data class Failed(val message: String) : PurchaseOutcome()
    }

    private val purchaseEvents = MutableSharedFlow<PurchaseSignal>(
        replay = 0,
        extraBufferCapacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    sealed class PurchaseSignal {
        data class Updated(val purchases: List<Purchase>) : PurchaseSignal()
        object Cancelled : PurchaseSignal()
        data class Error(val message: String) : PurchaseSignal()
    }

    val events: SharedFlow<PurchaseSignal> get() = purchaseEvents

    private val listener = PurchasesUpdatedListener { result, purchases ->
        val signal = when (result.responseCode) {
            BillingClient.BillingResponseCode.OK ->
                PurchaseSignal.Updated(purchases.orEmpty())
            BillingClient.BillingResponseCode.USER_CANCELED -> PurchaseSignal.Cancelled
            else -> PurchaseSignal.Error(describe(result))
        }
        purchaseEvents.tryEmit(signal)
    }

    private val client: BillingClient = BillingClient.newBuilder(context)
        .setListener(listener)
        // Required from Billing 7: declares we handle one-time products.
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder().enableOneTimeProducts().build(),
        )
        .build()

    /** Connect if needed. Returns false when Play Billing is unavailable. */
    suspend fun connect(): Boolean {
        if (client.isReady) return true
        return suspendCancellableCoroutine { continuation ->
            client.startConnection(
                object : com.android.billingclient.api.BillingClientStateListener {
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

    /**
     * Fetch Play's localized pricing for the credit packs.
     *
     * Returns fallback offers when Play is unavailable, so the paywall still
     * renders. It shows a price the buyer may not be charged, which is why the
     * purchase itself always goes through Play's own confirmed price — the
     * fallback is a label, never a commitment.
     */
    suspend fun creditPackOffers(): List<CreditPackOffer> {
        val fallback = CreditPack.entries.map { CreditPackOffer(it) }
        if (!connect()) return fallback

        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                CreditPack.entries.map { pack ->
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(pack.productId)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                },
            )
            .build()

        val result = runCatching { client.queryProductDetails(params) }.getOrNull()
            ?: return fallback
        val details = result.productDetailsList.orEmpty().associateBy { it.productId }
        return CreditPack.entries.map { pack ->
            CreditPackOffer(
                pack = pack,
                formattedPrice = details[pack.productId]
                    ?.oneTimePurchaseOfferDetails
                    ?.formattedPrice,
            )
        }
    }

    /** Launch Play's purchase dialog. The result arrives on [events]. */
    suspend fun launchPurchase(activity: Activity, pack: CreditPack): Boolean {
        if (!connect()) return false
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(pack.productId)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build(),
                ),
            )
            .build()
        val details: ProductDetails = runCatching { client.queryProductDetails(params) }
            .getOrNull()
            ?.productDetailsList
            ?.firstOrNull()
            ?: return false

        val flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(details)
                        .build(),
                ),
            )
            .build()
        return client.launchBillingFlow(activity, flow).responseCode ==
            BillingClient.BillingResponseCode.OK
    }

    /**
     * Verify a purchase server-side, then consume it.
     *
     * ORDER IS DELIBERATE. Consuming makes the token unusable, so it happens
     * only after the server has confirmed the grant — otherwise a buyer whose
     * connection dropped between paying and verifying would have destroyed the
     * only proof of their purchase.
     */
    suspend fun verifyAndConsume(purchase: Purchase): PurchaseOutcome {
        if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) {
            // PENDING (e.g. cash payment): nothing to grant yet. Play delivers
            // the completed purchase later.
            return PurchaseOutcome.Failed("This purchase is still pending with Google Play.")
        }
        val productId = purchase.products.firstOrNull()
            ?: return PurchaseOutcome.Failed("That purchase didn't name a product.")

        val response = runCatching {
            val body = json.encodeToString(
                GooglePlayVerifyRequest.serializer(),
                GooglePlayVerifyRequest(productId, purchase.purchaseToken),
            )
            json.decodeFromString(
                GooglePlayVerifyResponse.serializer(),
                edge.postRaw(VERIFY_PATH, body),
            )
        }.getOrElse { error ->
            Telemetry.breadcrumb("play verify failed: ${error.message}", "billing")
            // The purchase is NOT consumed — Play will redeliver it, and the
            // next verify attempt can still redeem it.
            return PurchaseOutcome.Failed(
                (error as? com.gradethread.app.platform.net.EdgeApiError)?.userMessage()
                    ?: "We couldn't confirm that purchase. It's safe — reopen this screen " +
                    "to finish it.",
            )
        }

        runCatching {
            if (CreditPack.fromProductId(productId) != null) {
                // Consumables must be consumed so the buyer can purchase again.
                client.consumePurchase(
                    ConsumeParams.newBuilder()
                        .setPurchaseToken(purchase.purchaseToken)
                        .build(),
                )
            } else if (!purchase.isAcknowledged) {
                client.acknowledgePurchase(
                    AcknowledgePurchaseParams.newBuilder()
                        .setPurchaseToken(purchase.purchaseToken)
                        .build(),
                )
            }
        }.onFailure {
            // The grant already landed, so this is not the buyer's problem.
            // Play re-delivers an unconsumed purchase and verify is idempotent.
            Telemetry.breadcrumb("play consume failed: ${it.message}", "billing")
        }

        return PurchaseOutcome.Verified(response.creditsBalance)
    }

    /**
     * Redeem anything Play is still holding for this user.
     *
     * Called when the paywall opens: a purchase that was paid for but never
     * verified (app killed mid-flow, network dropped) is otherwise invisible,
     * and the buyer is out the money with nothing to show.
     */
    suspend fun redeemOutstanding(): List<PurchaseOutcome> {
        if (!connect()) return emptyList()
        val params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.INAPP)
            .build()
        val purchases: List<Purchase> = runCatching {
            client.queryPurchasesAsync(params).purchasesList
        }.getOrNull().orEmpty()
        return purchases
            .filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
            .map { verifyAndConsume(it) }
    }

    private fun describe(result: BillingResult): String =
        result.debugMessage.takeIf { it.isNotBlank() }
            ?: "Play Billing error ${result.responseCode}"
}
