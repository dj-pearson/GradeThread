package com.gradethread.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.gradethread.app.ui.components.LocalProgressAnimation
import com.gradethread.app.ui.theme.GradeThreadTheme

/**
 * The theme every golden is captured under (US-3311).
 *
 * ⚠ IT EXISTS FOR ONE LINE: `LocalProgressAnimation provides false`. An
 * indeterminate Material 3 progress indicator holds a `rememberInfiniteTransition`
 * that asks for another frame forever, and `captureRoboImage` drains the
 * Robolectric looper until the composition is idle - so a capture containing one
 * never returns. Thirteen goldens across twelve classes each burned 820 to 1202
 * seconds of a Gradle fork on 2026-09-10 and then failed anyway, because what
 * they photographed was the spinner at whatever angle the fork happened to die
 * on. `BusySpinner` and `BusyBar` read this local and draw a determinate
 * stand-in instead, which runs no animation and settles instantly. The full
 * reasoning, and what a frozen golden does and does not prove, is in
 * `ui/components/BusyIndicator.kt`.
 *
 * ⚠ EVERY SCREENSHOT TEST GOES THROUGH HERE, AND THAT IS ENFORCED.
 * `BusyIndicatorUsageTest` fails if a `*ScreenshotTest.kt` calls
 * `GradeThreadTheme` directly, because a single file opting out is enough to
 * hand a CI shard a twenty-minute hang, and the hang looks like a slow runner
 * rather than like a mistake.
 *
 * It provides nothing else. Anything that changes pixels belongs in the test
 * that wants it, not in a wrapper shared by four hundred goldens.
 */
@Composable
internal fun ScreenshotTheme(darkTheme: Boolean = false, content: @Composable () -> Unit) {
    GradeThreadTheme(darkTheme = darkTheme) {
        CompositionLocalProvider(LocalProgressAnimation provides false) {
            content()
        }
    }
}
