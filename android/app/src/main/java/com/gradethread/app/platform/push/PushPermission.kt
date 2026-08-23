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

    // US-2792: there WAS a Moment enum here — three written rationales for
    // asking again at first sale, first grade and eBay connected — and no
    // function ever took one. Deleted rather than wired, owner's call.
    //
    // The argument for it was the one in this file's header: asking on the
    // launch screen is a stranger asking for a favour. But the app never did
    // that. OnboardingHost asks through an ACTIVATION CHECKLIST ROW the person
    // taps deliberately, which is already the good version — so a second,
    // opportunistic prompt would only re-ask someone who had already declined.
    //
    // If contextual asking is ever wanted, the rationales are in this commit's
    // parent. Do not re-add them without a caller.

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
