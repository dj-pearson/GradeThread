package com.gradethread.app.marketplaces

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri
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
        val uri = runCatching { url.toUri() }.getOrNull() ?: return
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

    /**
     * Opens a link in the marketplace's OWN app when the seller has it
     * installed, and in a Custom Tab when they don't.
     *
     * This exists because [open] can never do it. A Custom Tab is a browser by
     * definition, so it swallows the link and renders the mobile web page even
     * on a phone with the eBay app sitting on the home screen. That is the wrong
     * answer for the Scout sold-comps link: a seller standing in a thrift aisle
     * wants eBay's own sold search, signed in, with their saved filters, not a
     * logged-out web view asking them to sign in with a thumb.
     *
     * [Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER] is what makes the choice
     * automatic and silent: it asks the system for a non-browser handler and
     * throws [ActivityNotFoundException] if there isn't one, so the seller never
     * sees a "complete action using" chooser either way. It landed in API 30, so
     * on 26-29 we go straight to the Custom Tab rather than risk a chooser.
     */
    fun openInMarketplaceApp(context: Context, url: String) {
        val uri = runCatching { url.toUri() }.getOrNull() ?: return
        val appOnly = marketplaceAppIntent(uri)
        if (appOnly != null) {
            try {
                context.startActivity(appOnly)
                return
            } catch (e: ActivityNotFoundException) {
                // Expected on most devices — it just means the marketplace app
                // isn't installed, or isn't verified for this domain. Not an
                // error, so it is a breadcrumb and not an exception report.
                Telemetry.breadcrumb("no marketplace app for link: ${e.message}", "links")
            }
        }
        open(context, url)
    }

    /**
     * The app-only half of [openInMarketplaceApp], split out so the flags can be
     * asserted without a device. Null means "this OS version cannot ask for a
     * non-browser handler without risking a chooser", and the caller goes
     * straight to the Custom Tab.
     */
    fun marketplaceAppIntent(uri: Uri): Intent? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return Intent(Intent.ACTION_VIEW, uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .addFlags(Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER)
    }
}
