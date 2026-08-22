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

    /**
     * US-2407: a 403 the server EXPLAINED — a permission answer, not an
     * expired session.
     *
     * The workspace routes refuse in sentences a person can act on ("You
     * cannot assign a role higher than your own", "The workspace owner's role
     * can't be changed"). Folded into [Unauthorized] those became "your
     * session expired, sign in again", which is wrong and points the seller at
     * a sign-out that cannot help. A refresh cannot grant a role either, so
     * this case also stops the pointless forced retry [EdgeApi] does on
     * Unauthorized.
     *
     * A 403 with no message still maps to [Unauthorized] — an empty body is
     * exactly the shape a dead token produces, and guessing "permission" there
     * would break the sign-in prompt that case needs.
     */
    data class Forbidden(val detail: String?) : EdgeApiError()

    /**
     * US-2685: this workspace requires two-factor for your role, and this
     * session has not reached aal2.
     *
     * A 403 carrying `error_code: "workspace_mfa_required"` (edge
     * lib/workspace-roles.ts:174). DISTINCT FROM [Forbidden] on purpose, and
     * the distinction is the whole point: an ordinary permission refusal is
     * something the member cannot fix, and this one they can fix in about
     * fifteen seconds from Settings. Collapsed into Forbidden it rendered as
     * "you do not have permission", which sends a member who simply has not
     * entered a code to ask their owner for access they already have.
     *
     * Mirrors ios/GradeThread/Networking/EdgeAPIError.swift:170, which keys on
     * the same discriminator.
     */
    object WorkspaceMfaRequired : EdgeApiError()

    /**
     * US-2411: the month's AI actions are gone.
     *
     * A 429, but nothing like a rate limit: waiting a moment cannot help,
     * because the allowance resets at the start of next month. Folded into
     * [RateLimited] it read as "you're going a little too fast", which sends
     * the seller back to press the same button again — and the FlipDesk AI
     * routes return this without an `action: "upgrade"` marker, so the plan
     * gate never fired for it either. [actionsRemaining] is what the server
     * reports, and its presence in the body is the discriminator.
     */
    data class AiActionsExhausted(
        val detail: String?,
        val actionsRemaining: Int,
    ) : EdgeApiError()

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

    /** Where an existing subscription is billed. */
    enum class SubscriptionSource { STRIPE, APPSTORE }

    /**
     * US-1366: 409 `ACTIVE_STRIPE_SUBSCRIPTION` / `ACTIVE_APPSTORE_SUBSCRIPTION`
     * — this account already pays somewhere else, so a Play purchase would be a
     * second bill for the same thing. The route out is the other store, not a
     * retry here.
     */
    data class SubscriptionConflict(val source: SubscriptionSource) : EdgeApiError()

    /**
     * US-1366: 403 `PURCHASE_NOT_OWNED_BY_ACCOUNT` — the Play purchase belongs
     * to a different GradeThread account.
     *
     * Typed separately because a bare 403 maps to [Unauthorized], whose copy
     * ("your session expired, sign in again") is actively wrong here: the
     * session is fine, and re-authenticating as the same person changes nothing.
     */
    object PurchaseNotOwned : EdgeApiError()

    /**
     * US-1374: HTTP 402 with a decodable plan-gate body.
     *
     * Typed so a caller can tell "the shell is already showing an upgrade
     * dialog for this" from a transient failure. The difference matters for one
     * concrete reason: a Try-again button on a plan wall does nothing but hit
     * the same wall, and offering it reads as the app being broken rather than
     * the plan being the limit.
     */
    data class PlanGated(val gate: PlanGateError) : EdgeApiError()

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

    /**
     * US-1385: a suspended account.
     *
     * Its own case because the edge sends it as a 403, which mapped to
     * [Unauthorized] — so a suspended seller was told their session had expired
     * and sent off to sign in again, which fixes nothing and hides the truth.
     */
    data class AccountSuspended(val detail: String?) : EdgeApiError()

    /** User-facing copy, mirroring the iOS errorDescription strings. */
    fun userMessage(): String = when (this) {
        Unauthorized -> "Your session expired. Sign in again to continue."
        // The server names the rule that was broken and who can break it; the
        // fallback only runs for a 403 whose message decoded to nothing.
        // US-2685: names the fix rather than the refusal. The member is not
        // missing permission, they are missing a code.
        WorkspaceMfaRequired ->
            "This workspace needs two-factor authentication for your role. " +
                "Turn it on in Settings, then try again."
        is Forbidden -> detail ?: "You don't have permission to do that."
        EmailUnverified ->
            "Please confirm your email to use this feature. Check your inbox for the verification link we sent when you signed up."
        // The server names the allowance and when it resets; nothing here
        // could improve on that.
        is AiActionsExhausted -> detail
            ?: "You've used this month's AI actions. The allowance resets next month."
        is RateLimited -> retryAfterSeconds?.takeIf { it >= 1 }
            ?.let { "You're going a little too fast. Try again in ${it}s." }
            ?: "You're going a little too fast. Try again in a moment."
        is NotFound -> detail ?: "We couldn't find that."
        is BadRequest -> detail ?: "Something about that request wasn't right."
        is ServerError -> detail ?: "Something went wrong on our end. Please try again."
        is Decoding -> "Unexpected response from server: $reason"
        // [reason] is deliberately NOT rendered. It is OkHttp's IOException
        // text, which for a connect or DNS failure literally names the host —
        // "Failed to connect to functions.gradethread.com/..." — so the toast
        // handed the seller our internal edge hostname, which is both
        // meaningless to them and a free piece of infrastructure mapping. The
        // reason stays on the case for logs and Sentry. Mirrors iOS
        // EdgeAPIError.network.
        is Network -> "We couldn't reach GradeThread. Check your connection and try again."
        WorkspaceAccessRevoked ->
            "You no longer have access to that workspace — switched to your own account."
        is FeatureUnavailable -> detail ?: "This feature isn't available yet."
        OfferNotOpen ->
            "This offer is no longer available — it may have expired or already been answered."
        is SubscriptionConflict -> when (source) {
            SubscriptionSource.STRIPE ->
                "You already have a subscription billed on the web. Manage or cancel it there " +
                    "first, then you can subscribe through Google Play."
            SubscriptionSource.APPSTORE ->
                "You already have a subscription billed through the App Store. Manage it on " +
                    "your iPhone or iPad."
        }
        PurchaseNotOwned ->
            "That Google Play purchase belongs to a different GradeThread account. Sign in " +
                "with that account to use it."
        // The server's copy names the actual limit and what lifts it, so it
        // beats anything generic we could write here.
        is UpgradeRequired -> detail ?: "You've reached a limit on your plan. Upgrade to keep going."
        is PlanGated -> "${gate.title}. ${gate.recommendation}"
        is AccountSuspended -> detail ?: "This account is suspended. Contact support to sort it out."
    }

    /** Whether the UI should offer an upgrade route rather than a retry. */
    val isUpgradePrompt: Boolean
        get() = this is UpgradeRequired || this is PlanGated || this is AiActionsExhausted

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
            /** US-2411: present only on the AI-actions 429. */
            @kotlinx.serialization.SerialName("actions_remaining")
            val actionsRemaining: Int? = null,
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
            // US-1385: keyed on the discriminator, not the status — a 403 here
            // would otherwise read as "your session expired", which is both
            // wrong and actionable in the wrong direction.
            if (payload?.discriminator == "account_suspended") {
                return AccountSuspended(detail)
            }
            // Keyed on the discriminator, not the status, so the mapping
            // survives a status tweak on the edge (US-1510/US-1421).
            if (payload?.discriminator == "feature_unavailable" ||
                payload?.discriminator == "reconnect_required"
            ) {
                return FeatureUnavailable(detail)
            }
            if (payload?.discriminator == "offer_not_open") return OfferNotOpen
            // US-1366: the billing conflicts put their marker in `error`, not in
            // a discriminator field, and both statuses they use already map to
            // something whose copy misleads. Matched before the status switch
            // for the same reason the plan wall is.
            when (payload?.error) {
                "ACTIVE_STRIPE_SUBSCRIPTION" ->
                    return SubscriptionConflict(SubscriptionSource.STRIPE)
                "ACTIVE_APPSTORE_SUBSCRIPTION" ->
                    return SubscriptionConflict(SubscriptionSource.APPSTORE)
                "PURCHASE_NOT_OWNED_BY_ACCOUNT" -> return PurchaseNotOwned
            }
            // Checked BEFORE the status switch, which is the whole point: the
            // statuses the edge uses for a plan wall (429, 403) already map to
            // errors whose copy actively misleads here.
            if (payload?.action == "upgrade") {
                return UpgradeRequired(detail, payload.discriminator)
            }

            // US-1374: a 402 carrying a plan-gate body. The shell has already
            // been handed the same gate by EdgeApi and is showing the dialog;
            // this only tells the CALLER not to offer a retry that can't work.
            if (statusCode == 402) {
                PlanGateError.decode(body)?.let { return PlanGated(it) }
            }

            // US-2411: a 429 carrying actions_remaining is a monthly AI
            // allowance, not a rate limit. Keyed on the field rather than the
            // status, because the status is the same one a real rate limiter
            // uses and the remedies are opposites: wait a moment, versus wait
            // a month or upgrade.
            if (statusCode == 429 && payload?.actionsRemaining != null) {
                return AiActionsExhausted(detail, payload.actionsRemaining)
            }

            // US-2407: a 403 that came with a message is a permission answer.
            // Keyed on `error` specifically — that is the key every workspace
            // refusal uses, and it is absent from the empty body a dead token
            // produces, which must keep reading as a session problem.
            // US-2685: BEFORE the generic 403 branch, because that branch
            // would swallow it. A workspace-MFA refusal is the one 403 the
            // member can act on themselves, and telling them it is a
            // permissions problem sends them to their owner for access they
            // already have.
            if (statusCode == 403 && payload?.discriminator == "workspace_mfa_required") {
                return WorkspaceMfaRequired
            }

            if (statusCode == 403 && !payload?.error.isNullOrBlank()) {
                return Forbidden(detail)
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
