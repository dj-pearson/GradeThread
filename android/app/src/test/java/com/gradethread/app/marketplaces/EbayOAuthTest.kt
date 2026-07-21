package com.gradethread.app.marketplaces

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1350: what the consent bounce-back is allowed to complete.
 *
 * Robolectric because `Uri.parse` is an Android API — the parsing IS the
 * security boundary here, so testing against a hand-rolled stand-in would test
 * the wrong thing.
 */
@RunWith(RobolectricTestRunner::class)
class EbayOAuthTest {

    private val nonce = "abc123"

    private fun callback(
        status: String = "connected",
        clientState: String? = nonce,
        host: String = EbayOAuth.CALLBACK_HOST,
        path: String = EbayOAuth.CALLBACK_PATH,
        scheme: String = "https",
    ): Uri {
        val query = listOfNotNull(
            clientState?.let { "${EbayOAuth.NONCE_PARAM}=$it" },
            "${EbayOAuth.STATUS_PARAM}=$status",
        ).joinToString("&")
        return Uri.parse("$scheme://$host$path?$query")
    }

    // ── the host allowlist ───────────────────────────────────────────────

    @Test
    fun `only our domain and path can complete a connection`() {
        assertEquals(
            EbayOAuth.Outcome.NotOurs,
            EbayOAuth.parseCallback(callback(host = "evil.example"), nonce),
        )
        assertEquals(
            EbayOAuth.Outcome.NotOurs,
            EbayOAuth.parseCallback(callback(path = "/app/inventory"), nonce),
        )
        // A custom scheme is claimable by any installed app; the App Link is
        // not, so only https counts here.
        assertEquals(
            EbayOAuth.Outcome.NotOurs,
            EbayOAuth.parseCallback(callback(scheme = "com.gradethread.app"), nonce),
        )
        assertEquals(EbayOAuth.Outcome.NotOurs, EbayOAuth.parseCallback(null, nonce))
    }

    // ── the client nonce ─────────────────────────────────────────────────

    @Test
    fun `a bounce-back with the wrong nonce completes nothing`() {
        assertEquals(
            EbayOAuth.Outcome.NotOurs,
            EbayOAuth.parseCallback(callback(clientState = "someone-elses"), nonce),
        )
        assertEquals(
            EbayOAuth.Outcome.NotOurs,
            EbayOAuth.parseCallback(callback(clientState = null), nonce),
        )
    }

    @Test
    fun `nothing completes when no flow is in progress`() {
        // A replayed link opened from history must not report a connection the
        // seller never asked for this session.
        assertEquals(EbayOAuth.Outcome.NotOurs, EbayOAuth.parseCallback(callback(), null))
        assertEquals(EbayOAuth.Outcome.NotOurs, EbayOAuth.parseCallback(callback(), ""))
    }

    @Test
    fun `nonces are unique and long enough to be unguessable`() {
        val a = EbayOAuth.newNonce()
        val b = EbayOAuth.newNonce()
        assertNotEquals(a, b)
        assertEquals(32, a.length) // 128 bits, hex
    }

    // ── the status vocabulary ────────────────────────────────────────────

    @Test
    fun `each edge status maps to its own outcome`() {
        // Mirrors flipdesk-ebay.ts finish() exactly; a client-side spelling
        // would mean two places to keep in step.
        assertEquals(EbayOAuth.Outcome.Connected, EbayOAuth.parseCallback(callback("connected"), nonce))
        assertEquals(EbayOAuth.Outcome.Cancelled, EbayOAuth.parseCallback(callback("cancelled"), nonce))
        assertEquals(
            EbayOAuth.Outcome.InvalidState,
            EbayOAuth.parseCallback(callback("invalid_state"), nonce),
        )
        assertEquals(
            EbayOAuth.Outcome.StateExpired,
            EbayOAuth.parseCallback(callback("state_expired"), nonce),
        )
        assertEquals(
            EbayOAuth.Outcome.ExchangeFailed,
            EbayOAuth.parseCallback(callback("exchange_failed"), nonce),
        )
    }

    @Test
    fun `an unknown status fails rather than optimistically succeeding`() {
        // The edge can add a status before this build knows it. Guessing
        // upward would report a connection that isn't there.
        val outcome = EbayOAuth.parseCallback(callback("some_new_state"), nonce)
        assertEquals(EbayOAuth.Outcome.ExchangeFailed, outcome)
        assertFalse(outcome.isSuccess)
    }

    @Test
    fun `only connected counts as success`() {
        assertTrue(EbayOAuth.Outcome.Connected.isSuccess)
        listOf(
            EbayOAuth.Outcome.Cancelled,
            EbayOAuth.Outcome.InvalidState,
            EbayOAuth.Outcome.StateExpired,
            EbayOAuth.Outcome.ExchangeFailed,
            EbayOAuth.Outcome.NotOurs,
        ).forEach { assertFalse(it.toString(), it.isSuccess) }
    }

    // ── the redirect path ────────────────────────────────────────────────

    @Test
    fun `the redirect is RELATIVE so the edge sanitizer accepts it`() {
        // sanitizeRelativePath rejects an absolute URL or a custom scheme, and
        // the flow would silently bounce to the web dashboard instead of back
        // into the app.
        val path = EbayOAuth.redirectPath(nonce)
        assertTrue(path.startsWith("/"))
        assertFalse(path.contains("://"))
        assertTrue(path.contains("${EbayOAuth.NONCE_PARAM}=$nonce"))
    }

    @Test
    fun `a round trip through the redirect path validates`() {
        val path = EbayOAuth.redirectPath(nonce)
        val returned = Uri.parse("https://${EbayOAuth.CALLBACK_HOST}$path&ebay=connected")
        assertEquals(EbayOAuth.Outcome.Connected, EbayOAuth.parseCallback(returned, nonce))
    }

    // ── copy ─────────────────────────────────────────────────────────────

    @Test
    fun `cancel reads as a decision, not a failure`() {
        val copy = EbayOAuth.message(EbayOAuth.Outcome.Cancelled)!!
        assertTrue(copy.contains("nothing changed"))
    }

    @Test
    fun `success and not-ours say nothing`() {
        // The connection list is the better confirmation, and a stray link
        // deserves no message at all.
        assertNull(EbayOAuth.message(EbayOAuth.Outcome.Connected))
        assertNull(EbayOAuth.message(EbayOAuth.Outcome.NotOurs))
    }

    @Test
    fun `both expiry cases tell the seller to start again`() {
        assertTrue(EbayOAuth.message(EbayOAuth.Outcome.StateExpired)!!.contains("again"))
        assertTrue(EbayOAuth.message(EbayOAuth.Outcome.InvalidState)!!.contains("again"))
    }
}
