package com.gradethread.app.auth

/**
 * US-1312: the HTML document that renders the Cloudflare Turnstile widget
 * inside the bridge WebView (iOS TurnstileView.html). Pure + deterministic so
 * it unit-tests without a WebView. The site key is attribute-escaped
 * defensively even though it comes from our own build config.
 *
 * The document is loaded with [BASE_URL] as its origin: Turnstile validates
 * the rendering hostname against the site key's allowed-domains list, so the
 * same key the web app uses accepts the Android challenge too.
 */
object TurnstileHtml {

    const val BASE_URL = "https://gradethread.com"

    /** The name the JS side reaches the native bridge under. */
    const val BRIDGE_NAME = "GradeThreadTurnstile"

    /**
     * The only hosts this WebView is allowed to navigate to: the document's own
     * origin and the one Cloudflare serves the challenge from.
     *
     * Matched on the PARSED host, never on a prefix of the string. A prefix
     * test passes `https://gradethread.com.example.invalid/`, which is a
     * different site that happens to start the same way - the exact mistake
     * that makes an allowlist read as if it were doing something.
     */
    private val ALLOWED_HOSTS = setOf("gradethread.com", "challenges.cloudflare.com")

    /**
     * May the WebView follow [url]?
     *
     * https only, and only to [ALLOWED_HOSTS] or a subdomain of one. Anything
     * unparseable is refused: a URL we cannot read the host of is not a URL we
     * can vouch for.
     *
     * Pure, so it is tested without a WebView - which is the point, since the
     * WebView half of this cannot be tested on the JVM at all.
     */
    fun isAllowedNavigation(url: String): Boolean {
        // `scheme` is a platform type and IS null for a bare path, so the
        // null-safe call matters. `it.scheme.equals(...)` raises NPE on "",
        // and it raises it inside takeIf, which the runCatching does not cover
        // - so the guard against an unparseable URL would itself throw.
        val host = runCatching { java.net.URI(url) }.getOrNull()
            ?.takeIf { it.scheme?.equals("https", ignoreCase = true) == true }
            ?.host
            ?.lowercase()
            ?: return false
        return ALLOWED_HOSTS.any { host == it || host.endsWith(".$it") }
    }

    fun escapeAttr(value: String): String = value
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")

    fun page(siteKey: String): String {
        val escaped = escapeAttr(siteKey)
        return """
            <!DOCTYPE html>
            <html>
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
            <style>
              html, body { margin: 0; padding: 0; background: transparent; }
              .wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
            </style>
            </head>
            <body>
              <div class="wrap">
                <div class="cf-turnstile"
                     data-sitekey="$escaped"
                     data-callback="gtOnToken"
                     data-error-callback="gtOnError"
                     data-expired-callback="gtOnExpired"
                     data-timeout-callback="gtOnExpired"></div>
              </div>
              <script>
                function gtOnToken(token) { $BRIDGE_NAME.postToken(token); }
                function gtOnError(code) { $BRIDGE_NAME.postError(String(code)); }
                function gtOnExpired() { $BRIDGE_NAME.postExpired(); }
              </script>
            </body>
            </html>
        """.trimIndent()
    }
}
