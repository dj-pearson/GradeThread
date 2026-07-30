package com.gradethread.app.billing

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1366: the one network call in the billing flow.
 *
 * Split out as an interface for the same reason [PlayBilling] is: it is the
 * other half of what makes the purchase path testable. Together they let a test
 * drive "buyer pays, server rejects with a Stripe conflict, purchase is left
 * unsettled" without a Play Store, a card, or a server.
 *
 * Throws on failure — the caller classifies the error through
 * [PlayPurchaseRules.conflict], because what a failure MEANS is a decision and
 * decisions do not belong in a transport class.
 */
interface PurchaseVerifier {
    suspend fun verify(productId: String, purchaseToken: String): GooglePlayVerifyResponse
}

@Serializable
private data class GooglePlayVerifyRequest(
    val productId: String,
    val purchaseToken: String,
)

@Singleton
class EdgePurchaseVerifier @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) : PurchaseVerifier {

    companion object {
        const val VERIFY_PATH = "/api/payments/google/verify"
        private val json = Json { ignoreUnknownKeys = true }
    }

    override suspend fun verify(
        productId: String,
        purchaseToken: String,
    ): GooglePlayVerifyResponse {
        val body = json.encodeToString(
            GooglePlayVerifyRequest.serializer(),
            GooglePlayVerifyRequest(productId, purchaseToken),
        )
        return json.decodeFromString(
            GooglePlayVerifyResponse.serializer(),
            edge.postRaw(VERIFY_PATH, body),
        )
    }
}
