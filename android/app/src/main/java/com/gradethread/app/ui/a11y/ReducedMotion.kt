package com.gradethread.app.ui.a11y

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * US-1304: reduced-motion support (iOS ReducedMotion / `accessibleAnimation`).
 * Android's "Remove animations" accessibility setting sets
 * ANIMATOR_DURATION_SCALE to 0. The read is LIVE — a ContentObserver updates
 * the state if the user toggles the setting mid-session, so the next
 * animation snaps without an app restart (matching the iOS live read).
 *
 * Pattern for animations:
 *   val reduced by rememberReducedMotionState()
 *   animateFloatAsState(target, animationSpec = accessibleSpec(reduced, tween(300)))
 */
@Composable
fun rememberReducedMotionState(): State<Boolean> {
    val context = LocalContext.current
    val resolver = context.contentResolver

    fun read(): Boolean = Settings.Global.getFloat(
        resolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    ) == 0f

    val state = remember { mutableStateOf(read()) }

    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                state.value = read()
            }
        }
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            observer,
        )
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return state
}

/** Convenience one-shot read where a State subscription is overkill. */
@Composable
fun rememberReducedMotion(): Boolean = rememberReducedMotionState().value

/**
 * The `accessibleAnimation` analog: the supplied spec normally, an
 * interpolation-free snap when reduced motion is on.
 */
fun <T> accessibleSpec(reduced: Boolean, spec: AnimationSpec<T>): AnimationSpec<T> =
    if (reduced) snap() else spec
