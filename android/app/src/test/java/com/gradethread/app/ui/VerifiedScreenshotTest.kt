package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.verified.VerifiedActions
import com.gradethread.app.verified.VerifiedContent
import com.gradethread.app.verified.VerifiedProfile
import com.gradethread.app.verified.VerifiedStats
import com.gradethread.app.verified.VerifiedViewModel
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the seller's public badge.
 *
 * ⚠ A HANDLE HAS THREE ANSWERS, NOT TWO. Not checked yet, available, and taken.
 * `handleAvailable` is a nullable Boolean precisely because "we have not asked"
 * is not "no", and a form that painted null as taken would refuse a name that
 * nobody holds. All three are captured.
 *
 * ⚠ AND `stale` IS NOT AN ERROR. It means the numbers came off the device
 * rather than off the server. The screen says so instead of blanking, because a
 * seller checking their own badge would rather read yesterday's figure than
 * nothing at all.
 *
 * ⚠ THE FOUR STATUSES ARE FOUR DIFFERENT ASKS. Locked, handle-needed, hidden
 * and live each put a different next step in front of the seller, and they turn
 * on two booleans between them - so a capture is the only thing that proves the
 * right one came out.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class VerifiedScreenshotTest {

    private val stats = VerifiedStats(totalGraded = 34, averageGrade = 8.2)

    private val live = VerifiedProfile(
        handle = "northside-thrift",
        displayName = "Northside Thrift",
        bio = "Denim and outerwear, graded before it ships.",
        enabled = true,
        verifiedSince = "2026-02-14T00:00:00Z",
        showListings = true,
        embedInListings = true,
    )

    private fun state(profile: VerifiedProfile? = live, stats: VerifiedStats = this.stats) =
        VerifiedViewModel.State(profile = profile, stats = stats, loaded = true)

    /** Badge live, everything switched on. */
    @Test
    fun live_light() = capture("screen-verified-light") {
        VerifiedContent(state(), VerifiedActions())
    }

    @Test
    fun live_dark() = capture("screen-verified-dark", dark = true) {
        VerifiedContent(state(), VerifiedActions())
    }

    /** Nothing claimed and nothing public. The starting point. */
    @Test
    fun locked_light() = capture("screen-verified-locked-light") {
        VerifiedContent(
            state(profile = VerifiedProfile(), stats = VerifiedStats()),
            VerifiedActions(),
        )
    }

    /**
     * A handle claimed, the profile still switched off. Ready and invisible,
     * which is a different next step from having no handle.
     */
    @Test
    fun hidden_light() = capture("screen-verified-hidden-light") {
        VerifiedContent(
            state(profile = live.copy(enabled = false, embedInListings = false)),
            VerifiedActions(),
        )
    }

    /** Switched on with no handle. The profile has no address to live at. */
    @Test
    fun handleNeeded_light() = capture("screen-verified-handle-needed-light") {
        VerifiedContent(
            state(profile = VerifiedProfile(enabled = true), stats = VerifiedStats()),
            VerifiedActions(),
        )
    }

    /** First open, nothing back yet. */
    @Test
    fun loading_light() = capture("screen-verified-loading-light") {
        VerifiedContent(
            VerifiedViewModel.State(loading = true),
            VerifiedActions(),
        )
    }

    /**
     * Off the device, not off the server. Real numbers, flagged as possibly
     * old - blanking them would be worse.
     */
    @Test
    fun stale_light() = capture("screen-verified-stale-light") {
        VerifiedContent(
            state().copy(
                stale = true,
                errorMessage = "Showing what we last knew. Couldn't reach the server just now.",
            ),
            VerifiedActions(),
        )
    }

    /** The editor open, nothing typed yet. */
    @Test
    fun editorUntouched_light() = capture("screen-verified-editing-light") {
        VerifiedContent(
            state().copy(
                editor = VerifiedViewModel.Editor(
                    handle = "northside-thrift",
                    displayName = "Northside Thrift",
                    bio = "Denim and outerwear, graded before it ships.",
                ),
            ),
            VerifiedActions(),
        )
    }

    /** Checked and free. */
    @Test
    fun handleAvailable_light() = capture("screen-verified-handle-free-light") {
        VerifiedContent(
            state().copy(
                editor = VerifiedViewModel.Editor(
                    handle = "eastside-denim",
                    displayName = "Eastside Denim",
                    handleAvailable = true,
                ),
            ),
            VerifiedActions(),
        )
    }

    /**
     * Checked and gone. The reason is the server's sentence, because only the
     * server knows who holds it.
     */
    @Test
    fun handleTaken_light() = capture("screen-verified-handle-taken-light") {
        VerifiedContent(
            state().copy(
                editor = VerifiedViewModel.Editor(
                    handle = "denim",
                    displayName = "Eastside Denim",
                    handleAvailable = false,
                    handleTakenReason = "That handle is already in use.",
                ),
            ),
            VerifiedActions(),
        )
    }

    /** The shape is wrong before anyone asks the server. */
    @Test
    fun handleShapeError_light() = capture("screen-verified-handle-bad-light") {
        VerifiedContent(
            state().copy(
                editor = VerifiedViewModel.Editor(
                    handle = "AB",
                    handleError = R.string.verified_handle_length,
                ),
            ),
            VerifiedActions(),
        )
    }

    /** Mid-check. Neither answer yet. */
    @Test
    fun checkingHandle_light() = capture("screen-verified-handle-checking-light") {
        VerifiedContent(
            state().copy(
                editor = VerifiedViewModel.Editor(
                    handle = "eastside-denim",
                    checkingHandle = true,
                ),
            ),
            VerifiedActions(),
        )
    }

    /** The failure, with nothing cached behind it. */
    @Test
    fun error_dark() = capture("screen-verified-error-dark", dark = true) {
        VerifiedContent(
            VerifiedViewModel.State(errorMessage = "Could not reach the server."),
            VerifiedActions(),
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
