package com.gradethread.app.platform.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1306: typed errors surfaced by [EdgeApi] — the UI switches on these to
 * render the right message + recovery action instead of a raw HTTP code.
 * Mirrors iOS EdgeAPIError case-for-case (incl. the US-794/1182/1510/1421
 * discriminator mappings).
 */
sealed class EdgeApiError : Exception() {

    object Unauthorized : EdgeApiError()

    /** 403 `code=email_unverified` — actionable "verify your email", and no
     *  futile token refresh (a fresh token is still unverified). US-1182. */
    object EmailUnverified : EdgeApiError()

    /** 429; [retryAfterSeconds] carries the server's Retry-After hint. */
    data class RateLimited(val retryAfterSeconds: Long? = null) : EdgeApiError()

    data class NotFound(val detail: String?) : EdgeApiError()
    data class BadRequest(val detail: String?) : EdgeApiError()
    data class ServerError(val detail: String?) : EdgeApiError()
    data class Decoding(val reason: String) : EdgeApiError()
    data class Network(val reason: String) : EdgeApiError()

    /** 403 `workspace_access_revoked` — drop the stale scope, recover under
     *  the personal tenant (US-794). */
    object WorkspaceAccessRevoked : EdgeApiError()

    /** 501 `feature_unavailable` / `reconnect_required` — a calm "not
     *  available" state; retrying can't succeed (US-1510/US-1421). */
    data class FeatureUnavailable(val detail: String?) : EdgeApiError()

    /** 409 `offer_not_open` — refresh the inbox instead of erroring (US-1510). */
    object OfferNotOpen : EdgeApiError()

    /** User-facing copy, mirroring the iOS errorDescription strings. */
    fun userMessage(): String = when (this) {
        Unauthorized -> "Your session expired. Sign in again to continue."
        EmailUnverified ->
            "Please confirm your email to use this feature. Check your inbox for the verification link we sent when you signed up."
        is RateLimited -> retryAfterSeconds?.takeIf { it >= 1 }
            ?.let { "You're going a little too fast. Try again in ${it}s." }
            ?: "You're going a little too fast. Try again in a moment."
        is NotFound -> detail ?: "We couldn't find that."
        is BadRequest -> detail ?: "Something about that request wasn't right."
        is ServerError -> detail ?: "Something went wrong on our end. Please try again."
        is Decoding -> "Unexpected response from server: $reason"
        is Network -> "Network error: $reason"
        WorkspaceAccessRevoked ->
            "You no longer have access to that workspace — switched to your own account."
        is FeatureUnavailable -> detail ?: "This feature isn't available yet."
        OfferNotOpen ->
            "This offer is no longer available — it may have expired or already been answered."
    }

    companion object {

        /** Edge error body: `{ error, detail, error_code }` — the auth
         *  middleware uses the shorter `code` key; both are honored. */
        @Serializable
        internal data class WirePayload(
            val error: String? = null,
            val detail: String? = null,
            val error_code: String? = null,
            val code: String? = null,
        ) {
            val discriminator: String? get() = error_code ?: code
        }

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /** Maps (statusCode, body) to a typed error — iOS `from(statusCode:)`. */
        fun from(statusCode: Int, body: String): EdgeApiError {
            val payload = runCatching { json.decodeFromString<WirePayload>(body) }.getOrNull()
            val detail = payload?.detail ?: payload?.error ?: bodyPreview(body)

            if (statusCode == 403 && payload?.discriminator == "workspace_access_revoked") {
                return WorkspaceAccessRevoked
            }
            if (statusCode == 403 && payload?.discriminator == "email_unverified") {
                return EmailUnverified
            }
            // Keyed on the discriminator, not the status, so the mapping
            // survives a status tweak on the edge (US-1510/US-1421).
            if (payload?.discriminator == "feature_unavailable" ||
                payload?.discriminator == "reconnect_required"
            ) {
                return FeatureUnavailable(detail)
            }
            if (payload?.discriminator == "offer_not_open") return OfferNotOpen

            return when (statusCode) {
                401, 403 -> Unauthorized
                404 -> NotFound(detail)
                429 -> RateLimited()
                in 400..499 -> BadRequest(detail)
                else -> ServerError(detail)
            }
        }

        /** First 240 chars of a non-empty body — never a 50KB trace in a toast. */
        internal fun bodyPreview(body: String): String? {
            val text = body.trim()
            if (text.isEmpty()) return null
            return if (text.length > 240) text.take(240) + "…" else text
        }
    }
}
