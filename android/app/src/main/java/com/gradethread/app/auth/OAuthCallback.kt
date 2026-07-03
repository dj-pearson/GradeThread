package com.gradethread.app.auth

import android.net.Uri
import java.util.Collections

/**
 * US-1311: OAuth callback validation + the double-completion guard. The
 * consent flow returns through one of two allowlisted shapes:
 *
 *   • the App Link   `https://gradethread.com/app/auth-callback?code=…`
 *     (bound to our domain via assetlinks.json — no other app can claim it);
 *   • the custom scheme `com.gradethread.app://auth-callback?code=…`
 *     (the pre-App-Link fallback; a scheme is claimable by any app, which is
 *     why the HOST allowlist below is strict and the code is single-use).
 *
 * Anything else — a different host, path, or a missing code — parses to null
 * and the callback activity finishes without touching auth (AC2).
 */
object OAuthCallback {

    /** Extract the PKCE code from an allowlisted callback URI, else null. */
    fun parseCode(uri: Uri?): String? {
        if (uri == null) return null
        val allowlisted = when (uri.scheme) {
            "https" ->
                uri.host == "gradethread.com" && uri.path == "/app/auth-callback"
            "com.gradethread.app" ->
                uri.host == "auth-callback"
            else -> false
        }
        if (!allowlisted) return null
        return uri.getQueryParameter("code")?.takeIf { it.isNotBlank() }
    }

    /**
     * AC4: a callback can arrive more than once mid-flow (browser re-delivery,
     * onNewIntent + onCreate races). Each code exchanges exactly once; a
     * repeat reads as already-consumed and the activity just finishes.
     * Bounded so the set can't grow unbounded across a long session.
     */
    class CompletionGuard(private val maxRemembered: Int = 16) {
        private val consumed: MutableSet<String> =
            Collections.synchronizedSet(LinkedHashSet())

        /** True exactly once per code. */
        fun tryConsume(code: String): Boolean {
            synchronized(consumed) {
                if (code in consumed) return false
                consumed.add(code)
                while (consumed.size > maxRemembered) {
                    val eldest = consumed.first()
                    consumed.remove(eldest)
                }
                return true
            }
        }
    }
}
