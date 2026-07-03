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
}
