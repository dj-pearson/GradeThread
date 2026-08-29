package com.gradethread.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.ui.components.DataRow
import com.gradethread.app.ui.components.ErrorStateView
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.components.StatusBadge
import com.gradethread.app.ui.theme.BrandDestructiveButton
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2502: the shared UI components, rendered and diffed.
 *
 * Nothing else in this project has ever looked at what a Composable actually
 * draws. Unit tests exercise the logic behind a screen, the instrumented tests
 * assert that a node exists, and Android Studio's preview pane is a human
 * squinting at a panel that nobody opens on a change to a shared component.
 * So a padding change that clips a status badge, a tone that goes unreadable in
 * dark mode, or a button that loses its label all ship green today.
 *
 * These render on the JVM through Robolectric's native graphics -- no emulator,
 * no device -- and compare against the PNGs in src/test/screenshots. Re-record
 * after a deliberate change with `npm run android:screenshots:record`, in the
 * SAME commit as the change.
 *
 * Scope is the shared component library on purpose. Screens are composed of
 * these plus a ViewModel; screenshotting a screen means faking its whole state
 * graph, and the result asserts mostly on the fake. Components have no state to
 * fake, so what fails is always a real visual change.
 *
 * US-2902 AC3 QUALIFIED THAT, and ScreenScreenshotTest is the other half. The
 * paragraph above holds for the 49 screens that take
 * `viewModel: X = hiltViewModel()`. It does not hold for a screen whose entire
 * input is lambdas — there is no graph to fake — so those live in that file.
 * Covering the six screens AC3 actually names needs a stateless
 * `XScreenContent(state, callbacks)` extracted from each first.
 *
 * Pixel5 qualifiers rather than the default: an unpinned density and width make
 * the golden depend on Robolectric's defaults, which move between versions.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ComponentScreenshotTest {

    @Test
    fun statusBadges_light() = capture("status-badges-light") {
        Column(Modifier.padding(16.dp)) {
            for (status in STATUSES) StatusBadge(status)
        }
    }

    @Test
    fun statusBadges_dark() = capture("status-badges-dark", dark = true) {
        Column(Modifier.padding(16.dp)) {
            for (status in STATUSES) StatusBadge(status)
        }
    }

    @Test
    fun buttons_light() = capture("buttons-light") {
        Column(Modifier.padding(16.dp)) {
            BrandPrimaryButton(text = "Submit for grading", onClick = {})
            BrandSecondaryButton(text = "Save draft", onClick = {})
            BrandDestructiveButton(text = "Delete item", onClick = {})
        }
    }

    @Test
    fun buttons_dark() = capture("buttons-dark", dark = true) {
        Column(Modifier.padding(16.dp)) {
            BrandPrimaryButton(text = "Submit for grading", onClick = {})
            BrandSecondaryButton(text = "Save draft", onClick = {})
            BrandDestructiveButton(text = "Delete item", onClick = {})
        }
    }

    @Test
    fun infoCards_allTones() = capture("info-cards") {
        Column(Modifier.padding(16.dp)) {
            for (tone in InfoTone.entries) {
                InfoCard(
                    title = tone.name,
                    body = "A line of body copy long enough to wrap onto a second line " +
                        "so the layout is exercised rather than just the colour.",
                    tone = tone,
                )
            }
        }
    }

    @Test
    fun dataRows_longValueWraps() = capture("data-rows") {
        Column(Modifier.padding(16.dp)) {
            DataRow(label = "Brand", value = "Patagonia")
            DataRow(label = "Style", value = "Synchilla Snap-T Pullover")
            // The case that clips: a value with no break opportunity.
            DataRow(label = "SKU", value = "GT-2026-000000000000000000042")
        }
    }

    @Test
    fun errorState() = capture("error-state") {
        ErrorStateView(
            message = "We couldn't reach the grading service. Check your connection.",
            modifier = Modifier.fillMaxWidth(),
            // `retry` has no default and is not optional. A golden of the
            // resting state is what this asserts on, so the lambda is empty --
            // the retrying state swaps the button for a progress spinner, which
            // is an animation and would not be stable to diff anyway.
            retry = {},
        )
    }

    /**
     * One place that decides how a golden is produced: theme, surface, path.
     *
     * `Surface` matters -- without it a Composable renders onto a transparent
     * background and the PNG differs from what the app shows, which makes every
     * golden a picture of something no user sees.
     */
    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }

    private companion object {
        /** The item_status enum, which is what StatusBadge is fed everywhere. */
        val STATUSES = listOf(
            "sourced", "cataloged", "measured", "photographed",
            "comped", "drafted", "listed", "sold", "archived",
        )
    }
}
