package com.gradethread.app.ui.a11y

import android.content.Context
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView

/**
 * US-1304: announcements for async outcomes (iOS A11yAnnounce, US-701 —
 * WCAG 4.1.3 Status Messages). Grade complete, sync done, form saved: results
 * that swap content silently are inaudible to TalkBack users. Call
 * [A11yAnnouncer.announce] from result handlers; it's a no-op when no
 * accessibility service is running, so call it unconditionally.
 *
 * For text that lives IN the composition (inline status lines), prefer
 * `Modifier.semantics { liveRegion = LiveRegionMode.Polite }` — this
 * imperative path is for transient outcomes with no persistent node.
 */
class A11yAnnouncer(private val view: View) {

    private val manager: AccessibilityManager? =
        view.context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager

    private val enabled: Boolean get() = manager?.isEnabled == true

    /**
     * Speak [message] through the active accessibility service. Deferred a
     * beat so it lands after Compose commits the content change (the same
     * drop-avoidance delay the iOS helper uses).
     */
    fun announce(message: String) {
        if (!enabled || message.isEmpty()) return
        view.postDelayed({
            @Suppress("DEPRECATION") // the View API remains the reliable
            // route for transient, node-less announcements; the deprecation
            // steers persistent text toward liveRegion semantics (which the
            // in-composition surfaces here already use).
            view.announceForAccessibility(message)
        }, ANNOUNCE_DELAY_MS)
    }

    /**
     * Signal a substantial content change so focus moves to the new content
     * (iOS `screenChanged`).
     */
    fun screenChanged() {
        if (!enabled) return
        view.postDelayed({
            view.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
        }, ANNOUNCE_DELAY_MS)
    }

    private companion object {
        const val ANNOUNCE_DELAY_MS = 100L
    }
}

/** The composable entry point: `val a11y = rememberA11yAnnouncer()`. */
@Composable
fun rememberA11yAnnouncer(): A11yAnnouncer {
    val view = LocalView.current
    return remember(view) { A11yAnnouncer(view) }
}
