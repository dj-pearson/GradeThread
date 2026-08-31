package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.ui.components.StatusStyle
import com.gradethread.app.inventory.BulkAction
import com.gradethread.app.inventory.BulkActionResult
import com.gradethread.app.inventory.BulkUndo
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
 * US-2902 AC3: the inventory list, which is the screen a seller opens most and
 * the one with the most state on it.
 *
 * WHAT THESE GUARD. Four things on this screen are conditional and stack on top
 * of each other: the stage chips, the refresh-error banner, the bulk action bar
 * that replaces the normal chrome while a selection is live, and the undo bar
 * that appears after a bulk action completes. Each is a few lines apart in the
 * source, each pushes the list down, and a regression that shows two at once or
 * none at all is a layout fault no assertion on text would notice.
 *
 * The empty capture is not filler either. An inventory with nothing in it is
 * every seller's first screen, and it is the state most likely to be broken by
 * a change made while looking at a full list.
 *
 * ⚠ Timestamps are fixed constants. The rows render relative dates, so a
 * fixture built from now() produces a golden that rots.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class InventoryListScreenshotTest {

    // 2026-08-01 UTC and a few days either side. Fixed, per the note above.
    private val aug = 1_785_628_800_000L

    /**
     * Same shape as InventoryDerivationTest's builder, deliberately: the entity
     * has forty columns and almost no defaults, so every fixture in this repo
     * that needs one wraps it, and two different wrappers would drift.
     */
    @Suppress("LongParameterList")
    private fun item(
        id: String,
        title: String,
        status: String,
        brand: String? = null,
        size: String? = null,
        color: String? = null,
        sku: String? = null,
        grade: Double? = null,
        gradeLabel: String? = null,
        acquired: Double? = null,
        listing: Double? = null,
        createdAt: Long = aug,
    ) = InventoryItemEntity(
        id = id, userId = "u", title = title, brand = brand, sku = sku, size = size,
        color = color, material = null, status = status, itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = acquired, targetPrice = null,
        listingPrice = listing, gradeValue = grade, gradeLabel = gradeLabel,
        certificateUrl = null, gradeReportId = null, disputeStatus = null,
        conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
        createdAt = createdAt, updatedAt = createdAt,
    )

    private val items = listOf(
        item(
            id = "i1",
            title = "Levi's 501 Straight Jean",
            status = "photographed",
            brand = "Levi's",
            size = "W30 L32",
            color = "Dark wash",
            sku = "GT-0001",
            grade = 8.5,
            gradeLabel = "Excellent",
            acquired = 6.00,
            listing = 62.00,
        ),
        item(
            id = "i2",
            title = "Patagonia Synchilla Snap-T",
            status = "drafted",
            brand = "Patagonia",
            size = "M",
            color = "Forest green",
            sku = "GT-0002",
            acquired = 12.00,
            listing = 88.00,
            createdAt = aug - 86_400_000L,
        ),
        item(
            id = "i3",
            title = "Carhartt Detroit Jacket",
            status = "listed",
            brand = "Carhartt",
            size = "L",
            color = "Brown",
            sku = "GT-0003",
            grade = 7.0,
            gradeLabel = "Good",
            acquired = 18.00,
            listing = 145.00,
            createdAt = aug - 172_800_000L,
        ),
    )

    private fun ui(
        items: List<InventoryItemEntity> = this.items,
        stage: InventoryStage = InventoryStage.ALL,
        viewMode: InventoryViewMode = InventoryViewMode.LIST,
        refreshError: String? = null,
        bulkResult: BulkActionResult? = null,
        bulkUndo: BulkUndo? = null,
    ) = InventoryUiState(
        items = items,
        stage = stage,
        sort = SortOption.NEWEST,
        criteria = InventoryFilterCriteria(),
        viewMode = viewMode,
        query = "",
        debouncedQuery = "",
        photoItemIds = setOf("i1"),
        serverSearchIds = null,
        refreshing = false,
        refreshError = refreshError,
        bulkBusy = false,
        bulkResult = bulkResult,
        bulkUndo = bulkUndo,
    )

    @Test
    fun list_light() = capture("screen-inventory-list-light") { Content(ui()) }

    @Test
    fun list_dark() = capture("screen-inventory-list-dark", dark = true) { Content(ui()) }

    /** Day one, and the state most easily broken while looking at a full list. */
    @Test
    fun empty_light() = capture("screen-inventory-empty-light") {
        Content(ui(items = emptyList()))
    }

    /** The board groups by stage and ignores the stage chips. */
    @Test
    fun board_light() = capture("screen-inventory-board-light") {
        Content(ui(viewMode = InventoryViewMode.BOARD))
    }

    /** Offline. The list still renders from Room, with the banner above it. */
    @Test
    fun refreshError_light() = capture("screen-inventory-refresherror-light") {
        Content(ui(refreshError = "We couldn't reach the server. Showing what's on this device."))
    }

    /**
     * A bulk action that half-worked. "Updated 2 of 3" is stated explicitly
     * because a batch reporting "Done" is how a seller finds an unshipped order
     * a week later.
     */
    @Test
    fun bulkPartialResult_light() = capture("screen-inventory-bulkresult-light") {
        Content(
            ui(
                bulkResult = BulkActionResult(
                    action = BulkAction.MarkShipped,
                    succeeded = 2,
                    failures = listOf(
                        // US-2976: a failure the executor can actually produce.
                        // The fixture used to say "No tracking number on this
                        // listing.", which no code path generates.
                        BulkActionResult.Failure(
                            "i3",
                            UiMessage(
                                R.string.bulk_error_illegal_move,
                                args = listOf(
                                    StatusStyle.message("drafted"),
                                    StatusStyle.message("shipped"),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
    }

    /** The six-second undo window. */
    @Test
    fun bulkUndo_light() = capture("screen-inventory-bulkundo-light") {
        Content(
            ui(
                bulkUndo = BulkUndo(
                    // The real shape: the action's own label, then the count.
                    label = UiMessage(
                        R.plurals.bulk_undo_label,
                        args = listOf(BulkAction.MarkShipped.label, 3),
                        quantity = 3,
                    ),
                    statuses = mapOf("i1" to "listed", "i2" to "listed", "i3" to "listed"),
                ),
            ),
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

/**
 * Top level for the same reason the other screenshot files' helpers are: an
 * instance composable on a test class trips ComposeUnstableReceiver.
 */
@Composable
private fun Content(ui: InventoryUiState) {
    InventoryListContent(
        ui = ui,
        actions = InventoryActions(),
        onGrade = {},
        onOpenReport = {},
        onBulkGrade = {},
        onOpenItem = {},
    )
}
