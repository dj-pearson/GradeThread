package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.radar.MyStore
import com.gradethread.app.radar.MyStores
import com.gradethread.app.radar.RadarBoundingBox
import com.gradethread.app.radar.RadarNearbyActions
import com.gradethread.app.radar.RadarNearbyContent
import com.gradethread.app.radar.RadarNearbyViewModel
import com.gradethread.app.radar.RadarNetworkStats
import com.gradethread.app.radar.RadarPoint
import com.gradethread.app.radar.RadarVenue
import com.gradethread.app.radar.RadarWindow
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over where to go sourcing next.
 *
 * ⚠ THREE THINGS FAIL SEPARATELY AND READ ALIKE. The seller's own store history
 * (`personalError`), the shared network view (`networkError`), and location.
 * Each has its own retry, and one failing must not blank the others - a seller
 * whose location was refused still has a usable list, which is why that case
 * explains itself instead of disabling the row.
 *
 * ⚠ AND `networkLocked` IS NOT AN ERROR. It is a Free plan meeting a paid
 * surface, sticky for the session so the upgrade is offered once rather than on
 * every window change. Rendering it as a failure tells a seller something is
 * broken when the answer is a price. It is captured beside a real failure for
 * that reason.
 *
 * ⚠ THE ROWS ARE DERIVED, not a field. `rows` is RadarScoring.rows(venues,
 * personal, centre, area), so the fixture sets those four and lets the ranking
 * compute - which also means a scoring change shows up here rather than hiding
 * behind a hand-built list.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class RadarNearbyScreenshotTest {

    private val centre = RadarPoint(lat = 47.6062, lng = -122.3321)
    private val area = RadarBoundingBox(minLat = 47.4, minLng = -122.5, maxLat = 47.8, maxLng = -122.1)

    @Suppress("LongParameterList")
    private fun venue(id: String, name: String, lat: Double, lng: Double, scans: Int, people: Int, daysSince: Int) =
        RadarVenue(
            id = id,
            displayName = name,
            chain = if (name.startsWith("Goodwill")) "Goodwill" else null,
            lat = lat,
            lng = lng,
            status = "active",
            network = RadarNetworkStats(
                venueId = id,
                window = RadarWindow.THIRTY_DAYS.wire,
                scanCount = scans,
                contributorCount = people,
                avgGrade = 7.4,
                buyRate = 0.31,
                // ⚠ SET, BECAUSE THE DEFAULT IS null AND null READS AS "No recent
                // activity". The first recording left it out and every row said so
                // beside its own scan count - 184 scans in thirty days described as
                // nothing happening. A golden that contradicts itself teaches the
                // reader to distrust it.
                daysSinceActivity = daysSince,
            ),
        )

    private val venues = listOf(
        venue("v1", "Goodwill — Capitol Hill", 47.6205, -122.3212, scans = 184, people = 12, daysSince = 1),
        venue("v2", "Salvation Army — Northgate", 47.7080, -122.3255, scans = 96, people = 7, daysSince = 6),
        venue("v3", "St. Vincent de Paul", 47.5480, -122.3300, scans = 21, people = 4, daysSince = 24),
    )

    /** The seller's own history, including one shop with no place on the map. */
    private val personal = MyStores(
        stores = listOf(
            MyStore(
                key = "s1",
                venueId = "v1",
                name = "Goodwill — Capitol Hill",
                lat = 47.6205,
                lng = -122.3212,
                linked = true,
                itemsSourced = 31,
                itemsSold = 24,
                spendCents = 42_000,
                realizedProfitCents = 96_000,
                roiPct = 128.6,
            ),
            // No coordinates. It has history and cannot be placed, which is its
            // own row rather than a silent omission.
            MyStore(
                key = "s2",
                name = "Estate sale — Maple Ave",
                linked = false,
                itemsSourced = 6,
                itemsSold = 6,
                spendCents = 4_500,
                realizedProfitCents = 21_000,
                roiPct = 366.7,
            ),
        ),
    )

    private val loaded = RadarNearbyViewModel.State(
        window = RadarWindow.THIRTY_DAYS,
        personal = personal,
        venues = venues,
        kFloor = 3,
        area = area,
        centre = centre,
    )

    @Test
    fun nearby_light() = capture("screen-radar-light") {
        RadarNearbyContent(loaded, RadarNearbyActions())
    }

    @Test
    fun nearby_dark() = capture("screen-radar-dark", dark = true) {
        RadarNearbyContent(loaded, RadarNearbyActions())
    }

    /** Nothing loaded yet. */
    @Test
    fun loading_light() = capture("screen-radar-loading-light") {
        RadarNearbyContent(
            RadarNearbyViewModel.State(loadingPersonal = true, loadingNetwork = true),
            RadarNearbyActions(),
        )
    }

    /**
     * A Free seller meeting a paid surface. NOT a failure, and it must not look
     * like one - the list above it still works.
     */
    @Test
    fun networkLocked_light() = capture("screen-radar-locked-light") {
        RadarNearbyContent(
            loaded.copy(venues = emptyList(), networkLocked = true),
            RadarNearbyActions(),
        )
    }

    /** A real network failure, with its own retry. Compare with the capture above. */
    @Test
    fun networkFailed_dark() = capture("screen-radar-network-error-dark", dark = true) {
        RadarNearbyContent(
            loaded.copy(venues = emptyList(), networkError = "Could not reach the server."),
            RadarNearbyActions(),
        )
    }

    /**
     * Location refused. After two refusals Android stops showing the dialog at
     * all, so this explains the route back rather than disabling the button -
     * and the list is still usable without it.
     */
    @Test
    fun locationDenied_light() = capture("screen-radar-location-denied-light") {
        RadarNearbyContent(
            loaded.copy(centre = null, locationDenied = true),
            RadarNearbyActions(),
        )
    }

    /** The seller's own history failed while the network view is fine. */
    @Test
    fun personalFailed_dark() = capture("screen-radar-personal-error-dark", dark = true) {
        RadarNearbyContent(
            loaded.copy(personal = null, personalError = "Could not load your stores."),
            RadarNearbyActions(),
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
