package com.gradethread.app.auth

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.gradethread.app.platform.AppConfig

/** The bridge outcomes the auth screens act on. */
sealed class TurnstileResult {
    /** A solved challenge — attach [token] as gotrue's captcha_token. */
    data class Token(val token: String) : TurnstileResult()

    /** No site key configured (dev/CI) — proceed WITHOUT a token; the
     *  server has captcha disabled in that environment too. */
    object NotConfigured : TurnstileResult()

    /** Widget error/expiry — the caller re-presents or falls back. */
    data class Failed(val reason: String) : TurnstileResult()
}

/**
 * US-1312: the Turnstile challenge (iOS TurnstileSheet). Hosts the widget in
 * a WebView whose document origin is the registered domain (the key's
 * allowed-hostnames list validates it) and bridges the token back through a
 * [JavascriptInterface]. Gated on [AppConfig.turnstileSiteKey]: absent →
 * [TurnstileResult.NotConfigured] immediately, no WebView at all.
 *
 * Lifecycle-clean: the WebView is created in the AndroidView factory and torn
 * down in onRelease (loadUrl about:blank + destroy) so a dismissed sheet
 * can't leak the page or keep JS running.
 */
@SuppressLint("SetJavaScriptEnabled") // Turnstile is a JS widget; the page is
// OUR generated document with a strict bridge — no arbitrary navigation.
@Composable
fun TurnstileChallenge(
    onResult: (TurnstileResult) -> Unit,
    modifier: Modifier = Modifier,
) {
    // US-2978: onResult is not among the effect keys below, so the block
    // carries whichever closure existed at first composition. Read it through
    // rememberUpdatedState rather than keying on it - this effect is meant to
    // fire exactly once, and keying on a lambda would re-fire it.
    val currentOnResult by rememberUpdatedState(onResult)
    val siteKey = AppConfig.turnstileSiteKey
    if (siteKey == null) {
        LaunchedEffect(Unit) { currentOnResult(TurnstileResult.NotConfigured) }
        return
    }

    AndroidView(
        modifier = modifier
            .fillMaxWidth()
            .height(140.dp),
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                // The challenge page needs no storage; keep the surface minimal.
                settings.domStorageEnabled = false
                // Both default to TRUE below API 30, and minSdk is 26 - so on
                // Android 8, 9 and 10 this WebView could follow a file:// or
                // content:// URL into the app's own sandbox. Nothing in the
                // Turnstile document wants either scheme; turning them off
                // costs nothing and closes the reachable half of the risk that
                // comes with running someone else's script.
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.setGeolocationEnabled(false)
                webViewClient = object : WebViewClient() {
                    /**
                     * The default WebViewClient follows ANY navigation, and
                     * this WebView carries a @JavascriptInterface. A page that
                     * navigated somewhere else would still be able to call
                     * `postToken`, which is how a forged token reaches sign-in.
                     *
                     * So: the document itself (loaded from BASE_URL) and
                     * Cloudflare's challenge origin, nothing else. Anything
                     * further goes nowhere rather than to the system browser -
                     * a captcha widget has no legitimate reason to send the
                     * seller anywhere mid-challenge.
                     */
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        !TurnstileHtml.isAllowedNavigation(request.url.toString())
                }
                addJavascriptInterface(
                    object {
                        @JavascriptInterface
                        fun postToken(token: String) {
                            post { onResult(TurnstileResult.Token(token)) }
                        }

                        @JavascriptInterface
                        fun postError(code: String) {
                            post { onResult(TurnstileResult.Failed(code)) }
                        }

                        @JavascriptInterface
                        fun postExpired() {
                            post { onResult(TurnstileResult.Failed("expired")) }
                        }
                    },
                    TurnstileHtml.BRIDGE_NAME,
                )
                loadDataWithBaseURL(
                    TurnstileHtml.BASE_URL,
                    TurnstileHtml.page(siteKey),
                    "text/html",
                    "utf-8",
                    null,
                )
            }
        },
        onRelease = { webView ->
            webView.loadUrl("about:blank")
            webView.destroy()
        },
    )
}
