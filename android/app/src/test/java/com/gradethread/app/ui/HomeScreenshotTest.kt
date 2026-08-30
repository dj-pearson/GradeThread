package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.grading.GradesList
import com.gradethread.app.home.ActivationState
import com.gradethread.app.home.HomeActions
import com.gradethread.app.home.HomeContent
import com.gradethread.app.home.HomeViewModel
import com.gradethread.app.money.DashboardMetrics
import com.gradethread.app.money.TrendPoint
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the first screen a seller opens.
 *
 * ⚠ HomeContent WAS EXTRACTED AND NEVER CAPTURED. The split landed earlier in
 * this sweep - HomeActions bundles twelve callbacks precisely so a golden could
 * be written - and then no golden was. An extraction without a capture buys
 * nothing: the point of the split is that this file can exist.
 *
 * ⚠ THE ACTIVATION CHECKLIST IS THE NEW-SELLER PATH, and it disappears in two
 * different ways that must not be confused: completed (all three done) and
 * DISMISSED (waved away with work outstanding). A checklist that vanished on
 * dismissal but reappeared on the next launch would be indistinguishable from
 * one that never saved, so both states are captured.
 *
 * ⚠ AND AN EMPTY ACCOUNT IS NOT A BROKEN ONE. `hasAnyItems` is false for
 * everyone on day one; a page of zeroes with no explanation is the worst
 * possible first impression, so that state is captured too.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class HomeScreenshotTest {

    private val aug = 1_756_000_000_000L
    private val day = 24L * 60 * 60 * 1000

    private val metrics = DashboardMetrics(
        inventoryValue = 4_820.00,
        onHandCount = 63,
        listedCount = 41,
        soldThisWeekCount = 9,
        revenueThisWeek = 1_140.00,
        netProfitThisWeek = 612.40,
        // Items sitting untouched. The number this screen exists to surface.
        agingCount = 7,
    )

    private val trend = List(14) { i ->
        TrendPoint(
            dayStartMs = aug - (13L - i) * day,
            revenue = 40.0 + i * 12.0,
            profit = 15.0 + i * 6.0,
        )
    }

    private val aging = listOf(
        item("i1", "Patagonia Better Sweater", "Patagonia"),
        item("i2", "Barbour Bedale Wax Jacket", "Barbour"),
    )

    private val loaded = HomeViewModel.State(
        metrics = metrics,
        trend = trend,
        agingItems = aging,
        grades = GradesList.Summary(total = 24, certified = 21, average = 7.8),
        hasAnyItems = true,
    )

    /** Two of three done. The checklist is still earning its space. */
    private val partway = ActivationState(
        hasItem = true,
        ebayConnected = true,
        notificationsEnabled = false,
        dismissed = false,
    )

    @Test
    fun home_light() = capture("screen-home-light") {
        HomeContent(loaded, partway, refreshing = false, refreshError = null, actions = HomeActions())
    }

    @Test
    fun home_dark() = capture("screen-home-dark", dark = true) {
        HomeContent(loaded, partway, refreshing = false, refreshError = null, actions = HomeActions())
    }

    /** Day one: nothing sourced, nothing sold, and the checklist at zero. */
    @Test
    fun brandNewAccount_light() = capture("screen-home-new-light") {
        HomeContent(
            HomeViewModel.State(),
            ActivationState(),
            refreshing = false,
            refreshError = null,
            actions = HomeActions(),
        )
    }

    /** All three done. The checklist has earned its way off the screen. */
    @Test
    fun activationComplete_light() = capture("screen-home-activated-light") {
        HomeContent(
            loaded,
            ActivationState(hasItem = true, ebayConnected = true, notificationsEnabled = true),
            refreshing = false,
            refreshError = null,
            actions = HomeActions(),
        )
    }

    /**
     * Waved away with work outstanding. Distinct from completed above: the
     * checklist is gone for a different reason, and it must stay gone.
     */
    @Test
    fun activationDismissed_light() = capture("screen-home-dismissed-light") {
        HomeContent(
            loaded,
            partway.copy(dismissed = true),
            refreshing = false,
            refreshError = null,
            actions = HomeActions(),
        )
    }

    /** A refresh failed while the cached numbers stayed usable. */
    @Test
    fun refreshFailed_dark() = capture("screen-home-refresh-error-dark", dark = true) {
        HomeContent(
            loaded,
            partway,
            refreshing = false,
            refreshError = "Could not reach the server. Showing what is on this device.",
            actions = HomeActions(),
        )
    }

    private fun item(id: String, title: String, brand: String) = InventoryItemEntity(
        id = id, userId = "u1", title = title, brand = brand, sku = null, size = null,
        color = null, material = null, status = "listed", itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = 24.0, targetPrice = 78.0,
        listingPrice = 78.0, gradeValue = 8.5, gradeLabel = "Excellent",
        certificateUrl = null, gradeReportId = null, disputeStatus = null,
        conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
        createdAt = aug - 60 * day, updatedAt = aug - 45 * day,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
