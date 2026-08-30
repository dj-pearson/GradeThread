package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.snap.SnapActions
import com.gradethread.app.snap.SnapContent
import com.gradethread.app.snap.SnapGarment
import com.gradethread.app.snap.SnapGrade
import com.gradethread.app.snap.SnapResponse
import com.gradethread.app.snap.SnapValue
import com.gradethread.app.snap.SnapViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * US-2902 AC3: goldens over a valuation from one photo.
 *
 * ⚠ A PLAN WALL CHANGES THE BUTTON, NOT JUST THE WORDS. `isUpgradePrompt` turns
 * the error card's action from "try again" into the upgrade path, because
 * retrying a plan wall hits the same wall. Both render the same card with the
 * same message slot, so only a capture shows which button came out - and a
 * retry that can never work reads as the app being broken.
 *
 * ⚠ AND `sufficient` IS THE HEDGE. A value worked out from four comps is a
 * different claim from one worked out from forty, and a seller prices against
 * whichever they are shown. The thin case is captured beside the confident one.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class SnapScreenshotTest {

    private val photo = File("snap_0001.jpg")

    private val confident = SnapResponse(
        grade = SnapGrade(overallScore = 8.5, gradeTier = "Excellent", confidence = 0.88),
        value = SnapValue(
            lowCents = 5_400,
            medianCents = 8_200,
            highCents = 11_000,
            sampleSize = 41,
            confidence = 0.84,
            sufficient = true,
        ),
        garment = SnapGarment(type = "Fleece jacket", category = "Sweaters"),
        disclaimer = "Grades are estimated from your photo and are not certified.",
    )

    private val answered = SnapViewModel.State(
        photo = photo,
        brand = "Patagonia",
        keyword = "better sweater",
        result = confident,
    )

    @Test
    fun result_light() = capture("screen-snap-light") {
        SnapContent(answered, SnapActions())
    }

    @Test
    fun result_dark() = capture("screen-snap-dark", dark = true) {
        SnapContent(answered, SnapActions())
    }

    /** Nothing photographed yet. The resting state. */
    @Test
    fun idle_light() = capture("screen-snap-idle-light") {
        SnapContent(SnapViewModel.State(), SnapActions())
    }

    /** A photo, no hints typed. The answer is broader without them. */
    @Test
    fun photoNoHints_light() = capture("screen-snap-photo-light") {
        SnapContent(SnapViewModel.State(photo = photo), SnapActions())
    }

    /** Working. */
    @Test
    fun evaluating_light() = capture("screen-snap-loading-light") {
        SnapContent(
            SnapViewModel.State(photo = photo, brand = "Patagonia", loading = true),
            SnapActions(),
        )
    }

    /**
     * Four comps, not forty. `sufficient` is false and the card has to say so -
     * a seller prices against whichever number they are shown.
     */
    @Test
    fun thinComps_light() = capture("screen-snap-thin-light") {
        SnapContent(
            answered.copy(
                result = confident.copy(
                    value = SnapValue(
                        lowCents = 1_800,
                        medianCents = 2_600,
                        highCents = 4_100,
                        sampleSize = 4,
                        confidence = 0.31,
                        sufficient = false,
                    ),
                ),
            ),
            SnapActions(),
        )
    }

    /** A real failure. Retry is the useful action. */
    @Test
    fun retryableError_dark() = capture("screen-snap-error-dark", dark = true) {
        SnapContent(
            SnapViewModel.State(photo = photo, errorMessage = "Could not reach the server."),
            SnapActions(),
        )
    }

    /**
     * A plan wall. Same card, and the button is the upgrade rather than a
     * retry - compare with the capture above.
     */
    @Test
    fun planWall_dark() = capture("screen-snap-planwall-dark", dark = true) {
        SnapContent(
            SnapViewModel.State(
                photo = photo,
                errorMessage = "Snap to Value is on Pro and above.",
                isUpgradePrompt = true,
            ),
            SnapActions(),
        )
    }

    /** Camera permission refused. The route back is Settings. */
    @Test
    fun cameraDenied_light() = capture("screen-snap-camera-denied-light") {
        SnapContent(SnapViewModel.State(), SnapActions(), cameraDenied = true)
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
