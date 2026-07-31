package com.gradethread.app.platform.push

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * US-1378: asking for notification permission, at the right moment.
 *
 * Android 13+ requires POST_NOTIFICATIONS at runtime, and the system gives an
 * app exactly one good shot at it — a denial is close to permanent, since the
 * second refusal blocks the dialog for good.
 *
 * So this is deliberately NOT asked at launch. It is asked at a MONEY MOMENT:
 * the first time something sells, or a grade lands. At that point "tell me when
 * this happens" is an obvious yes; on the launch screen, before the app has
 * done anything, it is a stranger asking for a favour.
 */
object PushPermission {

    /** The moments worth asking on, in the order they usually happen. */
    enum class Moment(val rationale: String) {
        FIRST_SALE("Want a heads-up the moment something sells? We'll tell you here."),
        FIRST_GRADE("We'll let you know as soon as a grade is ready."),
        EBAY_CONNECTED("We'll warn you before your eBay connection expires, so sync never stops."),
    }

    /** Below API 33 notifications need no runtime grant. */
    val required: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    fun granted(context: Context): Boolean {
        if (!required) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Whether to put the prompt up now.
     *
     * Three gates, and each one prevents a specific waste:
     *  - not already granted, obviously;
     *  - push must actually be configured in this build, or the grant buys
     *    nothing and burns the one ask;
     *  - asked at most once ever from within the app, because a second system
     *    dialog is silently auto-denied and would leave the seller thinking
     *    they'd said yes.
     */
    fun shouldAsk(
        granted: Boolean,
        pushConfigured: Boolean,
        alreadyAsked: Boolean,
    ): Boolean = required && !granted && pushConfigured && !alreadyAsked
}
