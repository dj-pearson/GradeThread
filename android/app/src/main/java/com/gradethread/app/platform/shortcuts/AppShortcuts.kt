package com.gradethread.app.platform.shortcuts

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.gradethread.app.MainActivity
import com.gradethread.app.R
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ui.text
import com.gradethread.app.widget.WidgetSnapshot

/**
 * US-1381 (iOS `GradeThreadAppShortcuts`): long-press-the-icon shortcuts.
 *
 * Two are STATIC, declared in `res/xml/shortcuts.xml`: Snap to Value and Add an
 * item. Static because they are always the right answer — they need no state to
 * decide, so making them dynamic would mean a fresh install has an empty
 * long-press menu until the first sync.
 *
 * One is DYNAMIC: "what sold today", whose label carries the answer. That is
 * this platform's version of the iOS intent that speaks a result without
 * opening the app — Android has no equivalent spoken return, but a label read
 * straight off the long-press menu needs no auth, no network, and no launch.
 *
 * Every shortcut routes through the deep-link pipeline rather than a bespoke
 * extra, so there is one routing table.
 */
object AppShortcuts {

    /** Must match the ids in `res/xml/shortcuts.xml`. */
    const val ID_SNAP = "snap-to-value"
    const val ID_ADD = "add-item"
    const val ID_SOLD_TODAY = "sold-today"

    /** Must match the manifest's shortcut intent-filter and `shortcuts.xml`. */
    const val SCHEME = "com.gradethread.app"
    const val HOST = "shortcut"

    /**
     * What a shortcut is, decided without touching Android.
     *
     * US-2976: the labels are UiMessage, not String. The decision of WHICH
     * sentence is still made here, with no Context; only the rendering needs
     * one, and that happens in [build], which has one.
     */
    data class Spec(val id: String, val shortLabel: UiMessage, val longLabel: UiMessage, val uri: String)

    /**
     * The dynamic shortcut for the current snapshot.
     *
     * Deliberately still offered when signed out: the label becomes the sign-in
     * prompt, so a seller who long-presses gets an explanation rather than a
     * menu item that silently vanished.
     */
    fun soldTodaySpec(snapshot: WidgetSnapshot?): Spec = Spec(
        id = ID_SOLD_TODAY,
        shortLabel = SoldTodaySummary.shortLabel(snapshot),
        longLabel = SoldTodaySummary.dialog(snapshot),
        // The same custom scheme the static shortcuts use, for the same reason:
        // an https App Link is unverified on a debug build and would open a
        // browser.
        uri = "$SCHEME://$HOST/money",
    )

    /** The two static shortcuts' Uris, so the tests can parse what ships. */
    val STATIC_URIS: List<String> = listOf(
        "$SCHEME://$HOST/capture",
        "$SCHEME://$HOST/add",
    )

    /**
     * Publish the dynamic shortcut.
     *
     * `setDynamicShortcuts` with a single-item list, not `push`: this is the
     * only dynamic shortcut the app owns, and replacing the whole set means a
     * shortcut left behind by an older build can't linger with stale numbers on
     * someone's home screen.
     */
    fun refresh(context: Context, snapshot: WidgetSnapshot?) {
        val spec = soldTodaySpec(snapshot)
        // Wrapped: the launcher is another app, and a rate limit or a device
        // with no shortcut support must never take down the sync that called us.
        runCatching {
            ShortcutManagerCompat.setDynamicShortcuts(context, listOf(build(context, spec)))
        }.onFailure {
            Telemetry.breadcrumb("shortcut refresh failed: ${it.message}", "shortcuts")
        }
    }

    private fun build(context: Context, spec: Spec): ShortcutInfoCompat = ShortcutInfoCompat.Builder(context, spec.id)
        .setShortLabel(spec.shortLabel.text(context))
        .setLongLabel(spec.longLabel.text(context))
        .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_sales))
        .setIntent(
            // ACTION_VIEW with an explicit component: a shortcut intent must
            // carry an action, and naming the component means no other app
            // can be offered the tap.
            Intent(Intent.ACTION_VIEW, Uri.parse(spec.uri))
                .setClass(context, MainActivity::class.java),
        )
        .build()
}
