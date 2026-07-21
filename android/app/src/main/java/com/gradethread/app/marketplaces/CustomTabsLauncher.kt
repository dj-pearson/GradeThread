package com.gradethread.app.marketplaces

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import com.gradethread.app.platform.telemetry.Telemetry

/**
 * US-1350: opens the consent URL in a Custom Tab.
 *
 * A Custom Tab rather than a WebView, deliberately: it shares the device
 * browser's cookie jar, so a seller already signed in to eBay isn't asked
 * again — and, more importantly, it shows the real URL bar, which is the only
 * way someone can confirm they are typing their eBay password into eBay.
 */
object CustomTabsLauncher {

    fun open(context: Context, url: String) {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()
        try {
            intent.launchUrl(context, uri)
        } catch (e: ActivityNotFoundException) {
            // No browser that supports Custom Tabs. Fall back to whatever will
            // open a URL at all — a plain browser still completes the flow,
            // since the return trip is an App Link rather than anything the
            // tab itself has to hand back.
            Telemetry.breadcrumb("custom tab unavailable: ${e.message}", "oauth")
            runCatching {
                context.startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }
}
