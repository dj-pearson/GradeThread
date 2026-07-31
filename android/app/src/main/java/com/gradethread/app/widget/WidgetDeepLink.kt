package com.gradethread.app.widget

/**
 * US-1380 (iOS `WidgetDeepLink`): where a widget tap lands.
 *
 * The custom `com.gradethread.app://widget/…` scheme rather than the https app
 * link, for two reasons. It is the grammar US-1314 built for exactly this, and
 * it cannot be intercepted: an unverified app link falls back to a browser
 * chooser, and a seller tapping their own sales figure should never be asked
 * which app to open.
 *
 * The `widget` host is deliberately not `auth-callback`, so a widget tap can
 * never be mistaken for an OAuth redirect.
 */
enum class WidgetDeepLink(val path: String) {
    /** The active-listings metric. */
    MARKETPLACES("marketplaces"),

    /** Sold-today and pending-payout. */
    MONEY("money");

    val uri: String get() = "$SCHEME://$HOST/$path"

    companion object {
        const val SCHEME = "com.gradethread.app"
        const val HOST = "widget"
    }
}
