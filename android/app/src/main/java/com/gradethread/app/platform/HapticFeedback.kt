package com.gradethread.app.platform

import android.media.MediaActionSound
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView

/**
 * US-1305: typed haptic + sound feedback (iOS HapticFeedback) — every
 * feedback site goes through this one wrapper so audit + per-action tuning
 * happens in one place, not spread across screens.
 *
 * The View haptic route (`performHapticFeedback`) is used instead of raw
 * Vibrator: it respects the system "touch feedback" setting automatically,
 * needs no VIBRATE permission, and stays on the UI thread by construction.
 *
 * CONFIRM/REJECT are API 30+ constants; on 26-29 performHapticFeedback
 * returns false and the tap is silent - acceptable degradation (no crash),
 * matching how iOS drops haptics on devices without a Taptic Engine.
 *
 * Semantics (mirroring the iOS mapping):
 *  - [light]   — tab changes, chip taps, inconsequential confirmations
 *  - [medium]  — photo capture, sheet dismiss with a real action, commits
 *  - [success] — publish push, save success, background sync landed sales
 *  - [warning] — non-blocking issues ("token expiring soon")
 *  - [error]   — sync failures, publish rejected: flow-stopping failures
 */
class HapticFeedback(private val view: View) {

    fun light() {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    fun medium() {
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }

    fun success() {
        view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    }

    fun warning() {
        // No distinct system warning constant — a doubled light tick reads as
        // "attention" without the severity of REJECT.
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        view.postDelayed(
            { view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) },
            90L,
        )
    }

    fun error() {
        view.performHapticFeedback(HapticFeedbackConstants.REJECT)
    }
}

/** Composable entry: `val haptics = rememberHapticFeedback()`. */
@Composable
fun rememberHapticFeedback(): HapticFeedback {
    val view = LocalView.current
    return remember(view) { HapticFeedback(view) }
}

/**
 * US-1305: the camera shutter sound. MediaActionSound plays the SYSTEM
 * shutter effect — the compliant route in shutter-mandatory locales (JP/KR),
 * mirroring the iOS system-sound-id requirement. Load once per capture
 * screen; release on dispose (the underlying SoundPool holds resources).
 */
class ShutterSound {
    private val sound = MediaActionSound().apply { load(MediaActionSound.SHUTTER_CLICK) }

    fun play() = sound.play(MediaActionSound.SHUTTER_CLICK)

    fun release() = sound.release()
}

/** Lifecycle-managed shutter sound for capture screens. */
@Composable
fun rememberShutterSound(): ShutterSound {
    val shutter = remember { ShutterSound() }
    DisposableEffect(Unit) {
        onDispose { shutter.release() }
    }
    return shutter
}
