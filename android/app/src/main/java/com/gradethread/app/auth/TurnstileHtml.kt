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
