package com.gradethread.app.platform.applock

import android.view.Window
import android.view.WindowManager

/**
 * US-1315: the app-switcher privacy cover (iOS PrivacyCover). Android's
 * native mechanism is FLAG_SECURE: the Recents thumbnail renders blank the
 * INSTANT the app goes inactive (no fade — the iOS requirement), and
 * screenshots are blocked as a bonus. Applied whenever the app lock is
 * enabled; a future standalone privacy setting can toggle it independently.
 */
object PrivacyCover {

    fun apply(window: Window, enabled: Boolean) {
        if (enabled) {
            window.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE,
            )
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
}
