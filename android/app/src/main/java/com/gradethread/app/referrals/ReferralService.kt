package com.gradethread.app.referrals

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1385: the referral endpoints.
 *
 * Behind an interface so the view model is testable without a network.
 */
interface ReferralProviding {
    suspend fun me(): ReferralMe

    suspend fun redeem(code: String): RedeemResult
}

@Singleton
class ReferralService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) : ReferralProviding {

    override suspend fun me(): ReferralMe =
        json.decodeFromString(ReferralMe.serializer(), edge.getRaw(ME_PATH))

    /**
     * Attribute the caller as referred by [code].
     *
     * A BUSINESS rejection (bad code, own code, already referred, suspended)
     * comes back as `RedeemResult(ok = false, reason)` so the screen can say
     * something specific. A genuine auth or infrastructure failure is rethrown,
     * because "that code isn't valid" in front of an expired session sends
     * someone off retyping a code that was fine.
     */
    override suspend fun redeem(code: String): RedeemResult {
        val body = json.encodeToString(RedeemBody.serializer(), RedeemBody(code))
        return runCatching { edge.postRaw(REDEEM_PATH, body) }.fold(
            onSuccess = { RedeemResult(ok = true) },
            onFailure = { error ->
                val reason = (error as? EdgeApiError)?.let(::rejectionReason)
                    ?: throw error
                RedeemResult(ok = false, reason = reason)
            },
        )
    }

    /**
     * The machine-readable reason, or null when this wasn't a rejection.
     *
     * `BadRequest` keeps the raw body, so the tagged `error_code` survives the
     * mapping. `NotFound` does not, but on this endpoint a 404 is only ever an
     * unknown code or a missing account — both of which read the same to the
     * person typing, so it maps to `invalid_code` rather than inventing detail.
     */
    private fun rejectionReason(error: EdgeApiError): String? = when (error) {
        is EdgeApiError.BadRequest -> errorCode(error.body) ?: "invalid_code"
        is EdgeApiError.NotFound -> "invalid_code"
        is EdgeApiError.AccountSuspended -> "account_suspended"
        // Unauthorized, rate limits, 5xx: not the code's fault, and saying so
        // would be a lie the seller acts on.
        else -> null
    }

    private fun errorCode(body: String?): String? = body
        ?.let { runCatching { json.decodeFromString(ErrorWire.serializer(), it) }.getOrNull() }
        ?.errorCode
        ?.takeIf { it.isNotBlank() }

    companion object {
        const val ME_PATH = "/api/referrals/me"
        const val REDEEM_PATH = "/api/referrals/redeem"
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    }
}

@kotlinx.serialization.Serializable
private data class RedeemBody(val code: String)

@kotlinx.serialization.Serializable
private data class ErrorWire(
    @kotlinx.serialization.SerialName("error_code") val errorCode: String? = null,
)
