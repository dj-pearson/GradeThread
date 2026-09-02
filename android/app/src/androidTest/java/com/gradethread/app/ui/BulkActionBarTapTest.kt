package com.gradethread.app.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.inventory.BulkAction
import com.gradethread.app.inventory.BulkActionBar
import com.gradethread.app.inventory.InventoryStage
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-3001, the isolating experiment: does a REAL TAP reach a bulk action chip
 * when the bar is composed on its own?
 *
 * WHY THIS EXISTS. InventoryBulkSelectFlowTest found that performClick on these
 * chips fires nothing while performSemanticsAction on the same node fires the
 * handler, and that a tap on a LIST ROW in the same screen works. That narrows
 * the fault to the bar, but not to a cause: the bar sits inside a
 * PullToRefreshBox (added by US-2910 AC3), and a pull gesture that claims the
 * down event would produce exactly this.
 *
 * This composes BulkActionBar with nothing around it. The result is a fork:
 *
 *   PASSES  -> a real tap works on the bar alone, so the chip and AssistChip are
 *              fine and the container is implicated. PullToRefreshBox is the
 *              first suspect and the fix belongs there.
 *   FAILS   -> the bar itself does not take taps, wherever it is, and the
 *              PullToRefreshBox theory is wrong. Look at the chips.
 *
 * Either answer is worth having; this test is written to be kept whichever way
 * it lands, because "a tap on the bulk bar runs the action" is a thing that
 * should never stop being true.
 */
@RunWith(AndroidJUnit4::class)
class BulkActionBarTapTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun aRealTapOnTheBarAloneRunsTheAction() {
        var fired: BulkAction? = null

        rule.setContent {
            GradeThreadTheme {
                BulkActionBar(
                    selectedCount = 2,
                    stage = InventoryStage.UNLISTED,
                    busy = false,
                    onClear = {},
                    onAction = { fired = it },
                )
            }
        }
        rule.waitForIdle()

        // Create draft: the ordinary route, and not destructive, so a tap runs
        // it rather than opening a confirmation.
        rule.onNodeWithTag(TestTags.Inventory.bulkAction(BulkAction.CreateDraft.id))
            .performClick()
        rule.waitForIdle()

        assertEquals(
            "a real tap on the bar, composed alone, did not run the action",
            BulkAction.CreateDraft,
            fired,
        )
    }

    /**
     * THE SAME BAR, INSIDE THE CONTAINER THE SCREEN PUTS IT IN.
     *
     * The case above passes, so the chip is fine. This is the other half of the
     * fork: if a tap fails here and passes there, PullToRefreshBox is claiming
     * the gesture and the fix belongs at the container, not the chip.
     */
    @OptIn(ExperimentalMaterial3Api::class)
    @Test
    fun theSameTapInsideAPullToRefreshBox() {
        var fired: BulkAction? = null

        rule.setContent {
            GradeThreadTheme {
                PullToRefreshBox(isRefreshing = false, onRefresh = {}) {
                    Column {
                        BulkActionBar(
                            selectedCount = 2,
                            stage = InventoryStage.UNLISTED,
                            busy = false,
                            onClear = {},
                            onAction = { fired = it },
                        )
                    }
                }
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag(TestTags.Inventory.bulkAction(BulkAction.CreateDraft.id))
            .performClick()
        rule.waitForIdle()

        assertEquals(
            "a real tap inside PullToRefreshBox did not run the action - " +
                "the container is eating the gesture",
            BulkAction.CreateDraft,
            fired,
        )
    }
}
