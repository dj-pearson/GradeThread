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
    /**
     * Any unhandled 4xx. [body] is the UNTRUNCATED response body, kept because
     * some 4xx bodies are structured payloads a caller must read in full — the
     * publish pre-flight's 422 `{ blockers: [...] }` (US-1352) is the case that
     * forced it: [detail] falls back to a 240-char preview, which would silently
     * drop blockers off the end of a long list.
     */
    data class BadRequest(val detail: String?, val body: String? = null) : EdgeApiError()
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

    /**
     * US-1335: any status carrying `action: "upgrade"` — a plan or quota wall,
     * not a transport failure.
     *
     * This exists because the two statuses the edge uses for it are already
     * spoken for and BOTH said the wrong thing. The monthly free-Snap cap
     * returns 429, which mapped to [RateLimited] — telling a seller who used
     * their whole month's allowance to "slow down and try again in a moment",
     * when no amount of waiting helps. AI enrichment being off returns 403,
     * which mapped to [Unauthorized] — "your session expired", prompting a
     * pointless re-sign-in. The server already writes the correct sentence in
     * both cases; keying on the discriminator lets it through.
     */
    data class UpgradeRequired(val detail: String?, val code: String?) : EdgeApiError()

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
        // The server's copy names the actual limit and what lifts it, so it
        // beats anything generic we could write here.
        is UpgradeRequired -> detail ?: "You've reached a limit on your plan. Upgrade to keep going."
    }

    /** Whether the UI should offer an upgrade route rather than a retry. */
    val isUpgradePrompt: Boolean get() = this is UpgradeRequired

    companion object {

        /** Edge error body: `{ error, detail, error_code }` — the auth
         *  middleware uses the shorter `code` key; both are honored. */
        @Serializable
        internal data class WirePayload(
            val error: String? = null,
            val detail: String? = null,
            val error_code: String? = null,
            val code: String? = null,
            /** US-1335: the edge's "this is a plan wall" marker. */
            val action: String? = null,
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
            // Checked BEFORE the status switch, which is the whole point: the
            // statuses the edge uses for a plan wall (429, 403) already map to
            // errors whose copy actively misleads here.
            if (payload?.action == "upgrade") {
                return UpgradeRequired(detail, payload.discriminator)
            }

            return when (statusCode) {
                401, 403 -> Unauthorized
                404 -> NotFound(detail)
                429 -> RateLimited()
                in 400..499 -> BadRequest(detail, body)
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
