package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.analytics.AnalyticsActions
import com.gradethread.app.analytics.AnalyticsContent
import com.gradethread.app.analytics.AnalyticsNarrative
import com.gradethread.app.analytics.AnalyticsRange
import com.gradethread.app.analytics.AnalyticsUiState
import com.gradethread.app.analytics.AnalyticsViewModel
import com.gradethread.app.analytics.BrandProfit
import com.gradethread.app.analytics.GradeBucket
import com.gradethread.app.analytics.PeriodPnL
import com.gradethread.app.analytics.RoiBucket
import com.gradethread.app.analytics.SellThroughRow
import com.gradethread.app.analytics.StatusValue
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the numbers a seller judges their year by.
 *
 * ⚠ EVERY FIGURE IS SCOPED TO THE RANGE PICKER. "$4,120 profit" means nothing
 * without the window it covers, and the window is one row of chips at the top.
 * A seller who cannot see which one is selected reads the number as all-time.
 * The chips and the figures are captured together for that reason, and the
 * fixture uses a NON-default range so a picker that stopped reflecting the
 * selection would be visible.
 *
 * ⚠ THE NARRATIVE IS A SEPARATE FLOW AND FAILS ON ITS OWN. It is generated on
 * demand, so the charts must stay correct when the write-up cannot be produced.
 * Generating, generated, and failed are three captures, because a merged state
 * would let one failure blank the other half of the screen.
 *
 * ⚠ AND AN EMPTY ACCOUNT IS NOT A BROKEN ONE. That is the ordinary state for
 * anyone in their first week, and it gets a card explaining there is nothing to
 * measure yet rather than a page of zeroes.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class AnalyticsScreenshotTest {

    private val loaded = AnalyticsViewModel.State(
        // NOT the 90-day default: a picker that stopped showing the selection
        // would look right in a fixture that used it.
        range = AnalyticsRange.Days(30),
        gradedCount = 62,
        averageGrade = 7.8,
        gradeDistribution = listOf(
            GradeBucket("Pristine", 4),
            GradeBucket("Excellent", 27),
            GradeBucket("Good", 21),
            GradeBucket("Fair", 8),
            GradeBucket("Poor", 2),
        ),
        topBrands = listOf(
            BrandProfit("Patagonia", 1_240.50, 14),
            BrandProfit("Barbour", 880.00, 6),
            BrandProfit("Levi's", 412.25, 19),
        ),
        sellThrough = listOf(
            SellThroughRow("Patagonia", listed = 18, sold = 14),
            SellThroughRow("Barbour", listed = 11, sold = 6),
            // Listed plenty, sold nothing. The row worth seeing.
            SellThroughRow("Uniqlo", listed = 9, sold = 0),
        ),
        inventoryValue = listOf(
            StatusValue("listed", 3_420.00, 41),
            StatusValue("cataloged", 1_180.00, 22),
        ),
        roiBuckets = listOf(
            roi("Under $25", graded = 12, ungraded = 30, gradedNet = 18.40, ungradedNet = 11.10),
            roi("$25 to $75", graded = 24, ungraded = 19, gradedNet = 41.90, ungradedNet = 33.20),
            // No ungraded comparison to make. The lift is unknown, not zero.
            roi("Over $75", graded = 6, ungraded = 0, gradedNet = 96.00, ungradedNet = null),
        ),
        pnl = PeriodPnL(grossRevenue = 6_180.00, fees = 890.40, cogs = 1_170.00, unitsSold = 39),
        overallSellThrough = 0.61,
        itemCount = 63,
    )

    private val narrative = AnalyticsViewModel.NarrativeState(
        narrative = AnalyticsNarrative(
            summary = "You sold 39 items for $4,119.60 net, and Patagonia carried most of it.",
            highlights = listOf(
                "Patagonia returned $1,240.50 on 14 sales.",
                "Uniqlo has 9 listed and none sold in this window.",
            ),
            actions = listOf(
                "Reprice the Uniqlo shirts or move them out.",
                "Source more Patagonia fleece while it keeps turning.",
            ),
            model = "claude-sonnet-5",
            actionsRemaining = 3,
        ),
    )

    @Test
    fun analytics_light() = capture("screen-analytics-light") {
        AnalyticsContent(AnalyticsUiState(loaded, narrative), AnalyticsActions())
    }

    @Test
    fun analytics_dark() = capture("screen-analytics-dark", dark = true) {
        AnalyticsContent(AnalyticsUiState(loaded, narrative), AnalyticsActions())
    }

    /** Nothing to measure yet. The first week, not a failure. */
    @Test
    fun emptyAccount_light() = capture("screen-analytics-empty-light") {
        AnalyticsContent(AnalyticsUiState(), AnalyticsActions())
    }

    /** The write-up is being generated while the charts stay usable. */
    @Test
    fun narrativeGenerating_light() = capture("screen-analytics-narrative-generating-light") {
        AnalyticsContent(
            AnalyticsUiState(loaded, AnalyticsViewModel.NarrativeState(generating = true)),
            AnalyticsActions(),
        )
    }

    /**
     * The write-up failed and the charts did not. This is the state that would
     * be lost if the two flows were merged.
     */
    @Test
    fun narrativeFailed_dark() = capture("screen-analytics-narrative-error-dark", dark = true) {
        AnalyticsContent(
            AnalyticsUiState(
                loaded,
                AnalyticsViewModel.NarrativeState(errorMessage = "Could not write the summary."),
            ),
            AnalyticsActions(),
        )
    }

    /** The custom-range dialog. */
    @Test
    fun customRangeDialog_light() = capture("screen-analytics-customrange-light") {
        AnalyticsContent(
            AnalyticsUiState(loaded, narrative),
            AnalyticsActions(),
            customOpen = true,
        )
    }

    private fun roi(band: String, graded: Int, ungraded: Int, gradedNet: Double, ungradedNet: Double?) = RoiBucket(
        band = band,
        gradedCount = graded,
        ungradedCount = ungraded,
        gradedAvgNet = gradedNet,
        ungradedAvgNet = ungradedNet,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
