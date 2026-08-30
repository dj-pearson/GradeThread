package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.inventory.GlobalSearch
import com.gradethread.app.inventory.GlobalSearchActions
import com.gradethread.app.inventory.GlobalSearchContent
import com.gradethread.app.inventory.GlobalSearchViewModel
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over search.
 *
 * ⚠ THREE EMPTY-LOOKING STATES MEAN DIFFERENT THINGS, and that is the whole
 * reason this screen was worth capturing:
 *
 *   tooShort            the query is not long enough to run yet
 *   hasSearched = false nothing has been asked
 *   hasSearched = true  we looked, and there is nothing
 *
 * All three render a screen with no rows on it. Telling a seller "no matches"
 * when the truth is "type another letter" sends them off to look for an item
 * they own, and no unit test on the state machine can see which words appeared.
 *
 * Each is captured, so a branch that collapses into its neighbour shows up as
 * two identical images rather than as nothing at all.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class GlobalSearchScreenshotTest {

    private val aug = 1_756_000_000_000L

    private val hits = GlobalSearch.Results(
        items = listOf(
            item("i1", "Patagonia Better Sweater", "Patagonia"),
            item("i2", "Patagonia Nano Puff", "Patagonia"),
        ),
    )

    @Test
    fun results_light() = capture("screen-search-results-light") {
        GlobalSearchContent(
            GlobalSearchViewModel.State(query = "patagonia", results = hits, hasSearched = true),
            GlobalSearchActions(),
        )
    }

    @Test
    fun results_dark() = capture("screen-search-results-dark", dark = true) {
        GlobalSearchContent(
            GlobalSearchViewModel.State(query = "patagonia", results = hits, hasSearched = true),
            GlobalSearchActions(),
        )
    }

    /** Typed, but not enough to search on. NOT "no matches". */
    @Test
    fun tooShort_light() = capture("screen-search-tooshort-light") {
        GlobalSearchContent(
            // tooShort is DERIVED, not a constructor flag: it is
            // query.trim().length in 1 until MIN_QUERY_LENGTH. So the fixture
            // sets a two-character query and lets the state compute it, which
            // also proves the threshold rather than asserting around it.
            GlobalSearchViewModel.State(query = "pa"),
            GlobalSearchActions(),
        )
    }

    /** Nothing asked yet. The resting state. */
    @Test
    fun notSearchedYet_light() = capture("screen-search-idle-light") {
        GlobalSearchContent(GlobalSearchViewModel.State(), GlobalSearchActions())
    }

    /** We looked, and there is genuinely nothing. The only one that may say so. */
    @Test
    fun noMatches_dark() = capture("screen-search-nomatches-dark", dark = true) {
        GlobalSearchContent(
            GlobalSearchViewModel.State(query = "barbour", hasSearched = true),
            GlobalSearchActions(),
        )
    }

    private fun item(id: String, title: String, brand: String?) = InventoryItemEntity(
        id = id, userId = "u1", title = title, brand = brand, sku = null, size = null,
        color = null, material = null, status = "cataloged", itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = null, targetPrice = null,
        listingPrice = null, gradeValue = null, gradeLabel = null,
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
