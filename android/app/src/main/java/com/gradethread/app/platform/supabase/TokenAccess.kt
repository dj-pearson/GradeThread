package com.gradethread.app.platform.supabase

import com.gradethread.app.platform.net.EdgeApiError
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import java.io.IOException

/**
 * US-1307 + the US-1523 contract carried from iOS: the three distinguishable
 * outcomes of asking for an access token. Collapsing "signed out" and "the
 * refresh failed on a flaky network" into one null sent requests
 * UNAUTHENTICATED at the 1h boundary and showed a spurious "session expired"
 * — the exact incident class this type exists to prevent.
 */
sealed class AccessTokenResult {
    data class Token(val value: String) : AccessTokenResult()
    object NoSession : AccessTokenResult()
    data class Transient(val reason: String) : AccessTokenResult()
}

/**
 * Pure classification of a session-fetch failure: an [IOException] anywhere
 * in the cause chain (timeouts, DNS, offline — Ktor wraps transport errors)
 * is transient; anything else reads as no-session. Unknowns lean no-session
 * deliberately — EdgeApi's server-401 + forced-refresh path remains the
 * authoritative expiry signal. Hop-bounded like the iOS NSError walk.
 */
fun classifyTokenError(error: Throwable): AccessTokenResult {
    var current: Throwable? = error
    var hops = 0
    while (current != null && hops < 8) {
        if (current is IOException) {
            return AccessTokenResult.Transient(current.message ?: current.javaClass.simpleName)
        }
        current = current.cause
        hops += 1
    }
    return AccessTokenResult.NoSession
}

/** Typed access-token fetch (iOS currentAccessTokenResult). */
suspend fun SupabaseClient.currentAccessTokenResult(): AccessTokenResult =
    try {
        val session = auth.currentSessionOrNull()
        if (session != null) AccessTokenResult.Token(session.accessToken)
        else AccessTokenResult.NoSession
    } catch (t: Throwable) {
        classifyTokenError(t)
    }

/** Typed forced refresh (iOS refreshAccessTokenResult, US-1146). */
suspend fun SupabaseClient.refreshAccessTokenResult(): AccessTokenResult =
    try {
        auth.refreshCurrentSession()
        auth.currentSessionOrNull()?.let { AccessTokenResult.Token(it.accessToken) }
            ?: AccessTokenResult.NoSession
    } catch (t: Throwable) {
        classifyTokenError(t)
    }

/**
 * EdgeApi-shaped providers: `.Token` attaches, `.NoSession` returns null
 * (public endpoints proceed unauthenticated), `.Transient` THROWS the
 * retryable network error — a blip can never send a request unauthenticated
 * and never reads as "session expired".
 */
fun SupabaseClient.edgeTokenProvider(): suspend () -> String? = {
    when (val result = currentAccessTokenResult()) {
        is AccessTokenResult.Token -> result.value
        AccessTokenResult.NoSession -> null
        is AccessTokenResult.Transient ->
            throw EdgeApiError.Network("Session fetch failed: ${result.reason}")
    }
}

fun SupabaseClient.edgeTokenRefresher(): suspend () -> String? = {
    when (val result = refreshAccessTokenResult()) {
        is AccessTokenResult.Token -> result.value
        AccessTokenResult.NoSession -> null
        is AccessTokenResult.Transient ->
            throw EdgeApiError.Network("Session refresh failed: ${result.reason}")
    }
}
