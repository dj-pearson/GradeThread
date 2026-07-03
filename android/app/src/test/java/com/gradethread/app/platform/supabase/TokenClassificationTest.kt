package com.gradethread.app.platform.supabase

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * US-1307 (the US-1523 contract): a network-shaped session failure is
 * transient — never "signed out". IOExceptions anywhere in the cause chain
 * classify transient; everything else leans no-session (EdgeApi's server-401
 * path stays the authoritative expiry signal).
 */
class TokenClassificationTest {

    @Test
    fun ioExceptions_classifyTransient() {
        assertTrue(classifyTokenError(SocketTimeoutException("timed out")) is AccessTokenResult.Transient)
        assertTrue(classifyTokenError(UnknownHostException("dns")) is AccessTokenResult.Transient)
        assertTrue(classifyTokenError(IOException("connection reset")) is AccessTokenResult.Transient)
    }

    @Test
    fun wrappedIoExceptions_areFoundThroughTheCauseChain() {
        val wrapped = RuntimeException(
            "ktor wrapper",
            IllegalStateException("mid", SocketTimeoutException("deep")),
        )
        val result = classifyTokenError(wrapped)
        assertTrue(result is AccessTokenResult.Transient)
        assertEquals("deep", (result as AccessTokenResult.Transient).reason)
    }

    @Test
    fun nonNetworkErrors_classifyNoSession() {
        assertEquals(AccessTokenResult.NoSession, classifyTokenError(IllegalStateException("no session")))
        assertEquals(AccessTokenResult.NoSession, classifyTokenError(RuntimeException("gotrue 400")))
    }

    @Test
    fun deepCauseChains_terminate() {
        var t: Throwable = IllegalArgumentException("leaf")
        repeat(20) { t = RuntimeException("wrap$it", t) }
        assertEquals(AccessTokenResult.NoSession, classifyTokenError(t))
    }
}
