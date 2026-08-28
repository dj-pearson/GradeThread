package com.gradethread.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** US-1312: the Turnstile page builder (pure — mirrors iOS TurnstileView.html). */
class TurnstileHtmlTest {

    @Test
    fun page_embedsTheSiteKeyAndBridgeCallbacks() {
        val html = TurnstileHtml.page("0xKEY_abc")
        assertTrue(html.contains("""data-sitekey="0xKEY_abc""""))
        assertTrue(html.contains("challenges.cloudflare.com/turnstile/v0/api.js"))
        // All three lifecycle callbacks route through the named bridge.
        assertTrue(html.contains("${TurnstileHtml.BRIDGE_NAME}.postToken(token)"))
        assertTrue(html.contains("${TurnstileHtml.BRIDGE_NAME}.postError(String(code))"))
        assertTrue(html.contains("${TurnstileHtml.BRIDGE_NAME}.postExpired()"))
        assertTrue(html.contains("""data-expired-callback="gtOnExpired""""))
        assertTrue(html.contains("""data-timeout-callback="gtOnExpired""""))
    }

    @Test
    fun siteKey_isAttributeEscaped() {
        val html = TurnstileHtml.page("""k"><script>alert(1)</script>""")
        assertFalse(html.contains("<script>alert(1)</script>"))
        assertTrue(html.contains("&quot;&gt;&lt;script&gt;"))
    }

    @Test
    fun escapeAttr_handlesEachMetaChar() {
        assertEquals("a&amp;b", TurnstileHtml.escapeAttr("a&b"))
        assertEquals("&quot;", TurnstileHtml.escapeAttr("\""))
        assertEquals("&lt;x&gt;", TurnstileHtml.escapeAttr("<x>"))
    }

    @Test
    fun baseUrl_isTheRegisteredDomain() {
        // Turnstile validates the rendering hostname against the key's
        // allowed-domains — this constant IS the compatibility contract with
        // the web app's site key.
        assertEquals("https://gradethread.com", TurnstileHtml.BASE_URL)
    }

    // ── Navigation allowlist ─────────────────────────────────────────────────

    @Test
    fun navigation_allowsTheDocumentOriginAndCloudflare() {
        assertTrue(TurnstileHtml.isAllowedNavigation("https://gradethread.com/app/auth-callback"))
        assertTrue(
            TurnstileHtml.isAllowedNavigation(
                "https://challenges.cloudflare.com/turnstile/v0/api.js",
            ),
        )
        // Subdomains of an allowed host, which Cloudflare does use.
        assertTrue(TurnstileHtml.isAllowedNavigation("https://cdn.challenges.cloudflare.com/x"))
    }

    @Test
    fun navigation_refusesEverythingElse() {
        assertFalse(TurnstileHtml.isAllowedNavigation("https://example.invalid/"))
        // The prefix trap: a different site that starts with an allowed one.
        assertFalse(TurnstileHtml.isAllowedNavigation("https://gradethread.com.example.invalid/"))
        // A suffix without the dot boundary is a different host too.
        assertFalse(TurnstileHtml.isAllowedNavigation("https://notgradethread.com/"))
        // https only - the whole point of the WebView is an authenticated origin.
        assertFalse(TurnstileHtml.isAllowedNavigation("http://gradethread.com/"))
        // The schemes that reach the app's own sandbox.
        assertFalse(TurnstileHtml.isAllowedNavigation("file:///data/data/com.gradethread.app/x"))
        assertFalse(TurnstileHtml.isAllowedNavigation("content://com.gradethread.app.fileprovider/x"))
        assertFalse(TurnstileHtml.isAllowedNavigation("javascript:alert(1)"))
        // Unparseable is refused rather than allowed.
        assertFalse(TurnstileHtml.isAllowedNavigation("not a url at all"))
        assertFalse(TurnstileHtml.isAllowedNavigation(""))
    }
}
