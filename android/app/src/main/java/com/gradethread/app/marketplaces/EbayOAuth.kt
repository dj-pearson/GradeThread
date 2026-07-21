package com.gradethread.app.marketplaces

import android.net.Uri
import java.security.SecureRandom

/**
 * US-1350: the eBay consent round trip.
 *
 * The app opens the consent URL in a Custom Tab, eBay redirects to the edge
 * callback, and the edge bounces back to an App Link under
 * `https://gradethread.com/app/oauth/ebay` carrying `?ebay=<status>`.
 *
 * Two things make that return trustworthy, and both live here:
 *  - the HOST ALLOWLIST. The App Link is bound to our domain by
 *    assetlinks.json so no other app can claim it, but the URI still arrives
 *    as an Intent and is checked rather than assumed;
 *  - the CLIENT NONCE. The edge's own `state` protects the exchange; this
 *    second nonce protects the RETURN, so a stale or replayed bounce-back
 *    can't complete a flow this session never started.
 */
object EbayOAuth {

    const val CALLBACK_HOST = "gradethread.com"
    const val CALLBACK_PATH = "/app/oauth/ebay"
    const val NONCE_PARAM = "client_state"
    const val STATUS_PARAM = "ebay"

    /**
     * What came back.
     *
     * The statuses mirror the edge's own vocabulary exactly (`connected`,
     * `cancelled`, `invalid_state`, `state_expired`, `exchange_failed`) —
     * inventing a client-side spelling would mean two places to keep in step.
     */
    sealed class Outcome {
        object Connected : Outcome()

        /** The seller backed out. A decision, not a failure. */
        object Cancelled : Outcome()

        /** The state row was missing or already used — a replay or a stale tab. */
        object InvalidState : Outcome()

        /** The 10-minute window elapsed before consent finished. */
        object StateExpired : Outcome()

        /** eBay accepted consent but the token exchange failed. */
        object ExchangeFailed : Outcome()

        /** Not our callback, or not the flow this session started. */
        object NotOurs : Outcome()

        val isSuccess: Boolean get() = this == Connected
    }

    private val random = SecureRandom()

    /** A per-attempt nonce. 128 bits, URL-safe. */
    fun newNonce(): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * The `redirect_to` handed to `/oauth/start`.
     *
     * RELATIVE on purpose: the edge runs it through `sanitizeRelativePath`,
     * so an absolute URL or a custom scheme is rejected and the flow would
     * silently bounce to the web dashboard instead of back into the app.
     */
    fun redirectPath(nonce: String): String = "$CALLBACK_PATH?$NONCE_PARAM=$nonce"

    /**
     * Classify a callback URI.
     *
     * @param expectedNonce the nonce this session generated, or null when no
     *   flow is in progress — in which case nothing can legitimately complete.
     */
    fun parseCallback(uri: Uri?, expectedNonce: String?): Outcome {
        if (uri == null) return Outcome.NotOurs
        val allowlisted = uri.scheme == "https" &&
            uri.host == CALLBACK_HOST &&
            uri.path == CALLBACK_PATH
        if (!allowlisted) return Outcome.NotOurs

        // A bounce-back with no matching nonce is not ours to act on, whatever
        // status it claims — that is the whole point of carrying one.
        val nonce = uri.getQueryParameter(NONCE_PARAM)
        if (expectedNonce.isNullOrBlank() || nonce != expectedNonce) return Outcome.NotOurs

        return when (uri.getQueryParameter(STATUS_PARAM)) {
            "connected" -> Outcome.Connected
            "cancelled" -> Outcome.Cancelled
            "invalid_state" -> Outcome.InvalidState
            "state_expired" -> Outcome.StateExpired
            "exchange_failed" -> Outcome.ExchangeFailed
            // A status this build doesn't know is a failure, not a success:
            // the edge can add one before the client learns it, and guessing
            // in the optimistic direction would report a connection that
            // isn't there.
            else -> Outcome.ExchangeFailed
        }
    }

    /** What to tell the seller. */
    fun message(outcome: Outcome): String? = when (outcome) {
        Outcome.Connected -> null // the connection list says it better
        Outcome.Cancelled -> "eBay sign-in was cancelled — nothing changed."
        Outcome.InvalidState ->
            "That sign-in link had already been used. Start the connection again."
        Outcome.StateExpired ->
            "The sign-in took too long and expired. Start the connection again."
        Outcome.ExchangeFailed ->
            "eBay approved the connection but we couldn't finish it. Try again in a moment."
        Outcome.NotOurs -> null
    }
}
