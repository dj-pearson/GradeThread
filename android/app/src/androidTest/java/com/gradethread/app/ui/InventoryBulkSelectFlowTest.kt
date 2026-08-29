package com.gradethread.app.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.inventory.BulkAction
import com.gradethread.app.inventory.InventoryActions
import com.gradethread.app.inventory.InventoryFilterCriteria
import com.gradethread.app.inventory.InventoryListContent
import com.gradethread.app.inventory.InventoryStage
import com.gradethread.app.inventory.InventoryUiState
import com.gradethread.app.inventory.InventoryViewMode
import com.gradethread.app.inventory.SortOption
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-2902 AC5: a real seller flow, driven on a real device, end to end within
 * the boundary this host can actually reach.
 *
 * WHY THIS FLOW. Bulk actions are how a seller acts on a day's sourcing in one
 * go, and the flow is a state machine that no unit test touches: a LONG PRESS
 * starts a selection, a plain TAP extends it once one is running, the action bar
 * replaces the normal chrome while it is live, and the action fires with the
 * accumulated set. Every step of that lives in Compose state inside the screen,
 * so it is invisible to the ViewModel tests and to the goldens, which capture
 * one frame and never touch anything.
 *
 * ⚠ ON "END TO END". This does not reach a server, and it cannot: the app lands
 * on sign-in with no session, and signup cannot complete on a host with no
 * readable inbox. That is why AC5 offers a second branch, which android-ci.yml
 * already satisfies with a checkable condition for removing continue-on-error.
 * What this adds is the part that WAS reachable and was not covered - a real
 * multi-step interaction on a real device, asserting on what the seller's taps
 * produce rather than on what a ViewModel was asked to do.
 *
 * The extraction from US-2902 AC3 is what makes it possible. InventoryListContent
 * takes state and callbacks, so the flow runs with no Hilt graph, no Room and no
 * network, and the bulk callback can simply be captured and inspected.
 *
 * Handles are TAGS, not copy, for the reason TestTags documents: the app ships
 * Spanish and the localization work is actively moving these strings.
 */
@RunWith(AndroidJUnit4::class)
class InventoryBulkSelectFlowTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val fixedCreatedAt = 1_785_628_800_000L // 2026-08-01 UTC

    @Suppress("LongParameterList")
    private fun item(id: String, title: String, status: String) = InventoryItemEntity(
        id = id, userId = "u", title = title, brand = "Levi's", sku = null, size = "M",
        color = null, material = null, status = status, itemCategory = null,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = null, locationBin = null, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = null, targetPrice = null,
        listingPrice = null, gradeValue = null, gradeLabel = null,
        certificateUrl = null, gradeReportId = null, disputeStatus = null,
        conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
        createdAt = fixedCreatedAt, updatedAt = fixedCreatedAt,
    )

    private val items = listOf(
        item("i1", "Levi's 501 Straight Jean", "photographed"),
        item("i2", "Patagonia Synchilla Snap-T", "photographed"),
        item("i3", "Carhartt Detroit Jacket", "photographed"),
    )

    /**
     * ⚠ THE FIRST CHIP IS NOT THE ORDINARY PATH, which is what this test found.
     *
     * For TO_LIST the bar offers Grade, Create draft, Delete - and Grade is
     * INTERCEPTED: it routes to onBulkGrade rather than the bulk executor,
     * because grading needs a tier, a readiness check and credits, which is the
     * grade sheet's whole job. The first version of this test clicked index 0,
     * asserted onRunBulk had fired, and failed. The app was right.
     *
     * So both routes are pinned here. The interception is the interesting one:
     * it is a special case in a loop over a list, exactly the kind of thing a
     * later edit flattens back into "call the executor for everything", which
     * would bill a seller for a grade with no tier chosen.
     */
    @Test
    fun longPressThenTapSelectsTwoAndEachActionTakesItsOwnRoute() {
        var ranAction: BulkAction? = null
        var ranIds: List<String>? = null
        var gradedIds: List<String>? = null

        rule.setContent {
            GradeThreadTheme {
                InventoryListContent(
                    ui = InventoryUiState(
                        items = items,
                        // TO_LIST rather than ALL: BulkAction.forStage is
                        // stage-dependent, and a mixed stage offers a different
                        // set. Pinning the stage pins what the bar can contain.
                        stage = InventoryStage.TO_LIST,
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
                    actions = InventoryActions(
                        onRunBulk = { action, ids, _ ->
                            ranAction = action
                            ranIds = ids
                        },
                    ),
                    onGrade = {},
                    onOpenReport = {},
                    onBulkGrade = { gradedIds = it },
                    onOpenItem = {},
                )
            }
        }

        // Nothing selected yet, so no bar.
        rule.onAllNodesWithTag(TestTags.Inventory.BULK_BAR).assertCountEquals(0)

        // A long press starts the selection.
        rule.onNodeWithTag(TestTags.Inventory.row("i1")).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.onNodeWithTag(TestTags.Inventory.BULK_BAR).assertExists()

        // With one running, a PLAIN TAP extends it. This is the half a seller
        // discovers by accident and the half most likely to regress into
        // "opened the item" - which is what the same tap does when no selection
        // is live.
        rule.onNodeWithTag(TestTags.Inventory.row("i2")).performClick()
        rule.waitForIdle()

        // DIAGNOSTIC: what does the bar itself say is selected?
        rule.onNodeWithText("2 selected", substring = true).assertExists()

        // Chips are addressed BY NAME. See TestTags.Inventory.bulkAction: an
        // earlier draft took index 0 and got Delete, because onAllNodesWithTag
        // does not promise visual order.
        rule.onNodeWithTag(TestTags.Inventory.bulkAction(BulkAction.Grade.id)).performClick()
        rule.waitForIdle()

        assertNotNull("onBulkGrade never fired at all", gradedIds)
        assertEquals(
            "Grade should reach the grade sheet with the whole selection",
            listOf("i1", "i2").sorted(),
            gradedIds.orEmpty().sorted(),
        )
        assertEquals(
            "Grade must NOT go through the bulk executor - it has no tier yet",
            null,
            ranAction,
        )

        // Create draft is the ordinary route. The selection survives Grade, so
        // both ids are still live here.
        rule.onNodeWithTag(TestTags.Inventory.bulkAction(BulkAction.CreateDraft.id)).performClick()
        rule.waitForIdle()

        assertNotNull("the bulk action never fired", ranAction)
        assertEquals(
            "the action fired with the wrong selection",
            listOf("i1", "i2").sorted(),
            ranIds.orEmpty().sorted(),
        )
    }

    /**
     * The other half of the same rule, and the one that would silently break a
     * seller's day: with NO selection running, a tap must open the item rather
     * than select it.
     */
    @Test
    fun aPlainTapWithNoSelectionOpensTheItemInstead() {
        var opened: String? = null
        var selectedAnything = false

        rule.setContent {
            GradeThreadTheme {
                InventoryListContent(
                    ui = InventoryUiState(
                        items = items,
                        stage = InventoryStage.TO_LIST,
                        sort = SortOption.NEWEST,
                        criteria = InventoryFilterCriteria(),
                        viewMode = InventoryViewMode.LIST,
                        query = "",
                        debouncedQuery = "",
                        photoItemIds = setOf("i1"),
                        serverSearchIds = null,
                        refreshing = false,
                        refreshError = null,
                        bulkBusy = false,
                        bulkResult = null,
                        bulkUndo = null,
                    ),
                    actions = InventoryActions(onRunBulk = { _, _, _ -> selectedAnything = true }),
                    onGrade = {},
                    onOpenReport = {},
                    onBulkGrade = {},
                    onOpenItem = { opened = it },
                )
            }
        }

        rule.onNodeWithTag(TestTags.Inventory.row("i3")).performClick()
        rule.waitForIdle()

        assertEquals("a plain tap should open the item", "i3", opened)
        rule.onAllNodesWithTag(TestTags.Inventory.BULK_BAR).assertCountEquals(0)
        assertEquals("no bulk action should have run", false, selectedAnything)
    }
}
