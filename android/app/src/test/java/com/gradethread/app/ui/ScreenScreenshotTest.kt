package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.platform.applock.LockScreen
import com.gradethread.app.ui.shell.ToolsScreen
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: whole SCREENS, rendered and diffed.
 *
 * WHY THIS IS A SECOND FILE AND NOT MORE CASES IN ComponentScreenshotTest.
 * That file's header scopes itself to the shared component library on purpose,
 * and its argument is right as far as it goes: "screenshotting a screen means
 * faking its whole state graph, and the result asserts mostly on the fake."
 *
 * It is right about a screen that takes `viewModel: XViewModel = hiltViewModel()`
 * — 49 of this app's 52 do, and faking one means standing up a Hilt graph to
 * assert on a fixture. It is NOT right about a screen whose whole input is
 * lambdas: there is no state graph to fake, the golden asserts on layout given
 * no data at all, and what fails is a real visual change.
 *
 * Three screens qualify and two are captured. The third, BarcodeScanScreen, is
 * an AndroidView wrapping a CameraX PreviewView; under Robolectric it can only
 * ever be a picture of the permission-denied fallback, which is a golden of the
 * harness rather than of the screen.
 *
 * SO THIS FILE IS DELIBERATELY SMALL, AND THAT IS THE FINDING RATHER THAN A
 * SHORTFALL. AC3 names capture, the AI draft review, the grade report, publish,
 * inventory and money. Every one of them is ViewModel-bound, so covering them
 * needs a stateless `XScreenContent(state, callbacks)` extracted from each
 * — a refactor of production UI, worth doing and worth doing on its own. This
 * establishes that screen goldens work in this harness before that starts,
 * which is the cheaper order.
 *
 * The two screens here are not filler. LockScreen is what a locked launch shows
 * first and owns its own insets (US-2891/US-2899), and ToolsScreen is the
 * densest list of entries in the app — the surface where one more row silently
 * pushes the last one under the navigation bar.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ScreenScreenshotTest {

    @Test
    fun lockScreen_light() = capture("screen-lock-light") { LockScreen(onUnlock = {}) }

    @Test
    fun lockScreen_dark() = capture("screen-lock-dark", dark = true) { LockScreen(onUnlock = {}) }

    @Test
    fun toolsScreen_light() = capture("screen-tools-light") { ToolsScreen(onSnap = {}) }

    @Test
    fun toolsScreen_dark() = capture("screen-tools-dark", dark = true) { ToolsScreen(onSnap = {}) }

    /**
     * Same shape as ComponentScreenshotTest.capture, deliberately: one place per
     * file decides theme, surface and path, and the two files must not disagree
     * about what a golden is a picture of.
     *
     * `Surface` matters here for the same reason it does there — without it a
     * Composable renders onto a transparent background and the PNG shows
     * something no user sees.
     */
    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
