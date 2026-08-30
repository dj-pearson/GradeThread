package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.radar.RadarGradeMix
import com.gradethread.app.radar.RadarNetworkStats
import com.gradethread.app.radar.RadarVenueDetail
import com.gradethread.app.radar.RadarVenueDetailActions
import com.gradethread.app.radar.RadarVenueDetailContent
import com.gradethread.app.radar.RadarVenueDetailViewModel
import com.gradethread.app.radar.RadarVenueSummary
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over one shop's shared history.
 *
 * ⚠ THREE REASONS FOR AN EMPTY SCREEN AND ONLY ONE IS A FAULT. All three render
 * a card with a sentence on it:
 *
 *   NOTHING_TO_SAY  too few people have scanned here to report anything
 *                   without identifying them - the k-floor working
 *   PLAN_GATED      a Free seller meeting a paid surface, which is a price
 *   FAILED          it actually broke
 *
 * Telling a seller something is broken when the truth is "nobody has been here
 * yet" sends them to support over a working feature, and only FAILED should
 * offer a retry. All three are captured.
 *
 * ⚠ AND THE GRADE MIX IS FOUR NUMBERS THAT MUST ADD UP. high, mid, low and
 * ungraded are drawn as rows against a total; a row rendering against the wrong
 * denominator is a bar that looks like a different shop. The fixture uses four
 * distinct counts so no two rows can be confused.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class RadarVenueDetailScreenshotTest {

    private val detail = RadarVenueDetail(
        window = "30d",
        kFloor = 3,
        venue = RadarVenueSummary(
            id = "v1",
            displayName = "Goodwill — Capitol Hill",
            chain = "Goodwill",
            lat = 47.6205,
            lng = -122.3212,
            status = "active",
        ),
        network = RadarNetworkStats(
            venueId = "v1",
            window = "30d",
            scanCount = 184,
            contributorCount = 12,
            avgGrade = 7.4,
            buyRate = 0.31,
            // Four distinct counts: a row drawn against the wrong denominator
            // would otherwise be invisible.
            gradeMix = RadarGradeMix(high = 41, mid = 88, low = 27, ungraded = 28),
            daysSinceActivity = 1,
        ),
        brands = listOf(
            RadarNetworkStats(
                venueId = "v1",
                brand = "Patagonia",
                scanCount = 34,
                contributorCount = 8,
                avgGrade = 8.1,
            ),
            RadarNetworkStats(
                venueId = "v1",
                brand = "Levi's",
                scanCount = 22,
                contributorCount = 6,
                avgGrade = 7.0,
            ),
        ),
    )

    @Test
    fun ready_light() = capture("screen-venue-light") {
        RadarVenueDetailContent(
            RadarVenueDetailViewModel.Phase.Ready(detail),
            RadarVenueDetailActions(),
        )
    }

    @Test
    fun ready_dark() = capture("screen-venue-dark", dark = true) {
        RadarVenueDetailContent(
            RadarVenueDetailViewModel.Phase.Ready(detail),
            RadarVenueDetailActions(),
        )
    }

    /** Still fetching. */
    @Test
    fun loading_light() = capture("screen-venue-loading-light") {
        RadarVenueDetailContent(RadarVenueDetailViewModel.Phase.Loading, RadarVenueDetailActions())
    }

    /**
     * Too few contributors to say anything without identifying them. The
     * k-floor working, NOT a failure.
     */
    @Test
    fun nothingToSay_light() = capture("screen-venue-quiet-light") {
        RadarVenueDetailContent(
            RadarVenueDetailViewModel.Phase.Withheld(
                RadarVenueDetailViewModel.WithheldReason.NOTHING_TO_SAY,
            ),
            RadarVenueDetailActions(),
        )
    }

    /** A Free seller meeting a paid surface. The answer is a price. */
    @Test
    fun planGated_light() = capture("screen-venue-locked-light") {
        RadarVenueDetailContent(
            RadarVenueDetailViewModel.Phase.Withheld(
                RadarVenueDetailViewModel.WithheldReason.PLAN_GATED,
            ),
            RadarVenueDetailActions(),
        )
    }

    /** It actually broke. The only one of the three that should retry. */
    @Test
    fun failed_dark() = capture("screen-venue-failed-dark", dark = true) {
        RadarVenueDetailContent(
            RadarVenueDetailViewModel.Phase.Withheld(
                RadarVenueDetailViewModel.WithheldReason.FAILED,
                "Could not reach the server.",
            ),
            RadarVenueDetailActions(),
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
