package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.analytics.ListingPerformanceActions
import com.gradethread.app.analytics.ListingPerformanceContent
import com.gradethread.app.analytics.ListingPerformanceRow
import com.gradethread.app.analytics.ListingPerformanceViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over which listings are being seen.
 *
 * ⚠ `analyticsDenied` IS THE REASON THIS SCREEN WAS WORTH CAPTURING. It is a
 * tri-state `Boolean?` on purpose:
 *
 *   null   nobody has asked the marketplace yet
 *   false  it answered, and these are the real numbers
 *   true   it refused
 *
 * All three can render an empty or zeroed table, and they mean completely
 * different things. Collapsing "we were not allowed to look" into "you have no
 * views" tells a seller their listings are dead when the truth is that we never
 * saw the data - and that is a decision they would act on by dropping prices.
 *
 * Two of the three are captured here. The third, `false` with real rows, is the
 * happy path above.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ListingPerformanceScreenshotTest {

    private val aug = 1_756_000_000_000L

    private val rows = listOf(
        row("p1", "Levi's 501 Straight Jean", views = 412, watchers = 9, impressions = 2_100, ctr = 0.196),
        row("p2", "Barbour Bedale Wax Jacket", views = 88, watchers = 2, impressions = 1_450, ctr = 0.061),
        // Nobody has looked at this one. The point of the whole screen.
        row("p3", "Uniqlo Oxford Shirt", views = 0, watchers = 0, impressions = 12, ctr = 0.0),
    )

    private val loaded = ListingPerformanceViewModel.State(
        rows = rows,
        loaded = true,
        analyticsDenied = false,
        nowMs = aug,
    )

    @Test
    fun performance_light() = capture("screen-listingperf-light") {
        ListingPerformanceContent(loaded, ListingPerformanceActions())
    }

    @Test
    fun performance_dark() = capture("screen-listingperf-dark", dark = true) {
        ListingPerformanceContent(loaded, ListingPerformanceActions())
    }

    /**
     * The marketplace refused us. This must NOT read as "you have no views" -
     * the seller has done nothing wrong and dropping prices would be the wrong
     * response.
     */
    @Test
    fun analyticsDenied_dark() = capture("screen-listingperf-denied-dark", dark = true) {
        ListingPerformanceContent(
            ListingPerformanceViewModel.State(loaded = true, analyticsDenied = true, nowMs = aug),
            ListingPerformanceActions(),
        )
    }

    /** Loaded, permitted, and genuinely nothing listed yet. */
    @Test
    fun empty_light() = capture("screen-listingperf-empty-light") {
        ListingPerformanceContent(
            ListingPerformanceViewModel.State(loaded = true, analyticsDenied = false, nowMs = aug),
            ListingPerformanceActions(),
        )
    }

    /** A failure, with the retry the wrapper's load() doubles as. */
    @Test
    fun error_dark() = capture("screen-listingperf-error-dark", dark = true) {
        ListingPerformanceContent(
            ListingPerformanceViewModel.State(
                loaded = true,
                errorMessage = "Could not reach eBay.",
                nowMs = aug,
            ),
            ListingPerformanceActions(),
        )
    }

    @Suppress("LongParameterList")
    private fun row(id: String, title: String, views: Int, watchers: Int, impressions: Int, ctr: Double) =
        ListingPerformanceRow(
            id = id,
            inventoryItemId = "i-$id",
            title = title,
            listingUrl = null,
            listingPrice = 78.0,
            listedAtMs = aug - 30L * 24 * 60 * 60 * 1000,
            viewsTotal = views,
            watchersCount = watchers,
            impressions7d = impressions,
            clickThroughRate = ctr,
            lastMetricsSyncedAtMs = aug,
        )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
