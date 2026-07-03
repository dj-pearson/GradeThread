package com.gradethread.app.auth

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1311: the callback allowlist + the double-completion guard. Uri is an
 * Android framework class, so this runs under Robolectric.
 */
@RunWith(RobolectricTestRunner::class)
class OAuthCallbackTest {

    @Test
    fun appLink_parses() {
        assertEquals(
            "abc123",
            OAuthCallback.parseCode(
                Uri.parse("https://gradethread.com/app/auth-callback?code=abc123"),
            ),
        )
    }

    @Test
    fun customScheme_parses() {
        assertEquals(
            "xyz",
            OAuthCallback.parseCode(
                Uri.parse("com.gradethread.app://auth-callback?code=xyz"),
            ),
        )
    }

    @Test
    fun nonAllowlistedShapes_reject() {
        assertNull(OAuthCallback.parseCode(null))
        // Wrong host.
        assertNull(OAuthCallback.parseCode(Uri.parse("https://evil.com/app/auth-callback?code=x")))
        // Wrong path.
        assertNull(OAuthCallback.parseCode(Uri.parse("https://gradethread.com/other?code=x")))
        // Wrong scheme entirely.
        assertNull(OAuthCallback.parseCode(Uri.parse("http://gradethread.com/app/auth-callback?code=x")))
        // Wrong custom-scheme host.
        assertNull(OAuthCallback.parseCode(Uri.parse("com.gradethread.app://other?code=x")))
        // Missing / blank code.
        assertNull(OAuthCallback.parseCode(Uri.parse("https://gradethread.com/app/auth-callback")))
        assertNull(OAuthCallback.parseCode(Uri.parse("https://gradethread.com/app/auth-callback?code=")))
    }

    @Test
    fun guard_consumesEachCodeExactlyOnce() {
        val guard = OAuthCallback.CompletionGuard()
        assertTrue(guard.tryConsume("code-1"))
        assertFalse(guard.tryConsume("code-1"))
        assertTrue(guard.tryConsume("code-2"))
    }

    @Test
    fun guard_isBounded() {
        val guard = OAuthCallback.CompletionGuard(maxRemembered = 2)
        assertTrue(guard.tryConsume("a"))
        assertTrue(guard.tryConsume("b"))
        assertTrue(guard.tryConsume("c")) // evicts "a"
        // "a" fell out of memory — acceptable: PKCE codes are single-use
        // server-side anyway; the guard is a UX nicety, not the security line.
        assertTrue(guard.tryConsume("a"))
        assertFalse(guard.tryConsume("c"))
    }
}
