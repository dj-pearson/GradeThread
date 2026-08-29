package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.inventory.InventoryActions
import com.gradethread.app.inventory.InventoryFilterCriteria
import com.gradethread.app.inventory.InventoryListContent
import com.gradethread.app.inventory.InventoryStage
import com.gradethread.app.inventory.InventoryUiState
import com.gradethread.app.inventory.InventoryViewMode
import com.gradethread.app.inventory.SortOption
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2905 AC5, the BEFORE half: what a tablet actually gets today.
 *
 * The story asserts that on a tablet the app is "the same single stretched
 * column of inventory with the navigation moved to the left edge", and nothing
 * in the repo showed it. This is the capture. It exists so the two-pane layout
 * AC1 asks for has something to be compared against, and so the claim in the
 * story is evidence rather than assertion.
 *
 * ⚠ WHAT THIS CAPTURES AND WHAT IT DOES NOT. InventoryListContent is the
 * CONTENT, not the shell: the navigation rail lives in AppShell, which is
 * ViewModel-bound and not extracted. So this shows the half of the complaint
 * that is about the content - one column stretched to tablet width, with body
 * text running the full span - and not the rail. That is the half AC1 and AC4
 * are actually about.
 *
 * The qualifier is a 1280x800 tablet in landscape, which is the Expanded width
 * class and the shape the Play listing wants shots of.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "sw800dp-w1280dp-h800dp-land-xhdpi")
class TabletLayoutScreenshotTest {

    private val fixedCreatedAt = 1_785_628_800_000L // 2026-08-01 UTC

    @Suppress("LongParameterList")
    private fun item(
        id: String,
        title: String,
        brand: String,
        size: String,
        grade: Double?,
        gradeLabel: String?,
        listing: Double,
    ) = InventoryItemEntity(
        id = id, userId = "u", title = title, brand = brand, sku = null, size = size,
        color = null, material = null, status = "photographed", itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = null, targetPrice = null,
        listingPrice = listing, gradeValue = grade, gradeLabel = gradeLabel,
        certificateUrl = null, gradeReportId = null, disputeStatus = null,
        conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
        createdAt = fixedCreatedAt, updatedAt = fixedCreatedAt,
    )

    private val items = listOf(
        item("i1", "Levi's 501 Straight Jean", "Levi's", "W30 L32", 8.5, "Excellent", 62.00),
        item("i2", "Patagonia Synchilla Snap-T", "Patagonia", "M", null, null, 88.00),
        item("i3", "Carhartt Detroit Jacket", "Carhartt", "L", 7.0, "Good", 145.00),
    )

    @Test
    fun inventoryOnATabletWidth_light() = capture("screen-inventory-tablet-light") {
        InventoryListContent(
            ui = InventoryUiState(
                items = items,
                stage = InventoryStage.ALL,
                sort = SortOption.NEWEST,
                criteria = InventoryFilterCriteria(),
                viewMode = InventoryViewMode.LIST,
                query = "",
                debouncedQuery = "",
                photoItemIds = setOf("i1", "i2", "i3"),
                serverSearchIds = null,
                refreshing = false,
                refreshError = null,
                bulkBusy = false,
                bulkResult = null,
                bulkUndo = null,
            ),
            actions = InventoryActions(),
            onGrade = {},
            onOpenReport = {},
            onBulkGrade = {},
            onOpenItem = {},
        )
    }

    private fun capture(name: String, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme { Surface { content() } }
        }
    }
}
