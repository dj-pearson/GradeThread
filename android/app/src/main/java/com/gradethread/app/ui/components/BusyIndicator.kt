package com.gradethread.app.ui.components

import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier

/**
 * The app's two indeterminate progress indicators, and the one switch that can
 * stop them turning (US-3311).
 *
 * ⚠ AN INDETERMINATE MATERIAL 3 INDICATOR CANNOT BE SCREENSHOT. Both
 * `CircularProgressIndicator()` and `LinearProgressIndicator()` hold a
 * `rememberInfiniteTransition`, which asks the frame clock for another frame
 * forever. Roborazzi's `captureRoboImage` drains the Robolectric looper until
 * the composition is idle, and a composition with an infinite transition in it
 * is never idle. Measured on 2026-09-10: thirteen goldens across twelve classes
 * each burned 820-1202 seconds of one Gradle fork and then photographed the
 * spinner at whatever angle the timeout happened to stop it on, which can never
 * match a committed PNG. Those thirteen were 93 percent of a 246-test-minute
 * suite and every one of them failed.
 *
 * ⚠ THE FIX IS A DETERMINATE STAND-IN, NOT A LONGER TIMEOUT. When
 * [LocalProgressAnimation] is false these draw the SAME Material 3 component in
 * its determinate form, pinned at [FROZEN_PROGRESS_FRACTION]. A determinate
 * indicator runs no animation at all, so the composition goes idle, the capture
 * returns in well under a second, and the pixels are identical on every machine
 * and every run.
 *
 * ⚠ WHAT A FROZEN GOLDEN PROVES, AND WHAT IT DOES NOT. It proves the busy state
 * lays out: that the indicator is present, at its size, in its slot, in the
 * theme's colour, with whatever the screen does to the surrounding controls
 * while it waits (a submit button gone, an action row disabled, a message
 * beside it). It does NOT prove the animation - nothing about sweep, period or
 * easing is captured, and nothing here should be read as a check on those. The
 * old goldens did not prove them either; they only appeared to.
 *
 * ⚠ DETERMINATE CALL SITES DO NOT COME THROUGH HERE. A
 * `LinearProgressIndicator(progress = { ... })` showing a real fraction has no
 * infinite transition and already captures fine, so it keeps calling Material 3
 * directly. `BusyIndicatorUsageTest` knows the difference and only objects to
 * the indeterminate overloads.
 *
 * Production never flips the switch: [LocalProgressAnimation] defaults to true
 * and only the screenshot harness provides false.
 *
 * ⚠ THE SUPPRESSION IS DELIBERATE AND NARROW. compose-lints objects to new
 * CompositionLocals on the grounds that they are implicit dependencies, and
 * that is the right default: `LocalIsDarkTheme` and `LocalHighContrast` are
 * the only other two in this app. A parameter is not available here, because
 * the indicators sit dozens of composables below the capture and every one of
 * them would have to thread a flag it does not otherwise care about. It is
 * read in exactly two places, both in this file.
 */
@Suppress("ComposeCompositionLocalUsage")
val LocalProgressAnimation = staticCompositionLocalOf { true }

/**
 * The fraction a frozen indicator is drawn at.
 *
 * Deliberately not 0 and not 1: an empty ring and a full ring both read as a
 * finished or broken indicator in a golden, and the point of the capture is
 * that the screen is mid-flight.
 */
const val FROZEN_PROGRESS_FRACTION = 0.35f

/** The app's indeterminate circular spinner. Frozen under [LocalProgressAnimation]. */
@Composable
fun BusySpinner(modifier: Modifier = Modifier) {
    if (LocalProgressAnimation.current) {
        CircularProgressIndicator(modifier = modifier)
    } else {
        CircularProgressIndicator(progress = { FROZEN_PROGRESS_FRACTION }, modifier = modifier)
    }
}

/** The app's indeterminate linear bar. Frozen under [LocalProgressAnimation]. */
@Composable
fun BusyBar(modifier: Modifier = Modifier) {
    if (LocalProgressAnimation.current) {
        LinearProgressIndicator(modifier = modifier)
    } else {
        LinearProgressIndicator(progress = { FROZEN_PROGRESS_FRACTION }, modifier = modifier)
    }
}
