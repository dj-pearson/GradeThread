package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.grading.GradesListActions
import com.gradethread.app.grading.GradesListContent
import com.gradethread.app.grading.GradesListUiState
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over the grades list, and the only capture that shows
 * the WHOLE grade-colour ladder at once.
 *
 * ⚠ WHY ALL FOUR BANDS IN ONE LIST. gradeColor has four: Emerald >= 9.5, Steel
 * Navy 7.0-9.4, Amber 5.0-6.9, and the failing band below 5.0. Until tonight
 * only two of them appeared in any capture in this repo - 8.5 and 7.0 are both
 * NAVY, and 6.0 is amber - so emerald and the failing red had never been
 * rendered anywhere. That is precisely how US-3004 survived: the navy band was
 * caught because a dark golden happened to show it, and the bands with no
 * golden showed nothing.
 *
 * ⚠ AND THE DARK CAPTURE IS THE ONE THAT MATTERS. US-3010 moved the failing
 * band off a hardcoded `Color(0xFFE94560)` onto `MaterialTheme.colorScheme.error`,
 * which resolves to #CC1F3D in light and #FB5E78 in dark. A single-theme golden
 * would pin half of that and let the other half drift back to a literal without
 * anything going red.
 *
 * The fixture is deliberately ordered worst-first so the failing row is not the
 * one that scrolls off.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class GradesListScreenshotTest {

    private val aug = 1_756_000_000_000L

    /** One row per band, so a colour that stops resolving is visible as a row. */
    private val items = listOf(
        item("g1", "Patagonia Better Sweater", 3.5, "Poor", "Patagonia"),
        item("g2", "Uniqlo Oxford Shirt", 6.0, "Fair", "Uniqlo"),
        item("g3", "Levi's 501 Straight Jean", 8.5, "Excellent", "Levi's"),
        item("g4", "Barbour Bedale Wax Jacket", 9.7, "Pristine", "Barbour"),
    )

    @Test
    fun allBands_light() = capture("screen-grades-bands-light") {
        GradesListContent(GradesListUiState(items = items), GradesListActions())
    }

    /** The capture that pins colorScheme.error's DARK value (US-3010). */
    @Test
    fun allBands_dark() = capture("screen-grades-bands-dark", dark = true) {
        GradesListContent(GradesListUiState(items = items), GradesListActions())
    }

    /**
     * Nothing graded yet. The empty state is what a new seller meets first, and
     * it is one boolean away from the list above.
     */
    @Test
    fun empty_light() = capture("screen-grades-empty-light") {
        GradesListContent(GradesListUiState(), GradesListActions())
    }

    /**
     * A refresh that failed. The message is the only thing telling the seller
     * the list they are looking at is stale.
     */
    @Test
    fun refreshError_dark() = capture("screen-grades-refresherror-dark", dark = true) {
        GradesListContent(
            GradesListUiState(items = items, refreshError = "Could not reach the server."),
            GradesListActions(),
        )
    }

    private fun item(id: String, title: String, grade: Double?, gradeLabel: String?, brand: String?) =
        InventoryItemEntity(
            id = id, userId = "u", title = title, brand = brand, sku = null, size = null,
            color = null, material = null, status = "graded", itemCategory = null,
            garmentType = null, garmentCategory = null, itemDescription = null, style = null,
            sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
            sourceId = null, locationBin = null, consignorId = null,
            consignmentSplitPct = null, acquiredPrice = null, targetPrice = null,
            listingPrice = null, gradeValue = grade, gradeLabel = gradeLabel,
            certificateUrl = null, gradeReportId = null, disputeStatus = null,
            conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
            createdAt = aug, updatedAt = aug,
        )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
