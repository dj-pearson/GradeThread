package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.grading.BulkGradeActions
import com.gradethread.app.grading.BulkGradeContent
import com.gradethread.app.grading.BulkGradeMachine
import com.gradethread.app.grading.BulkGradeViewModel
import com.gradethread.app.grading.GradeTier
import com.gradethread.app.grading.GradingUserInfo
import com.gradethread.app.grading.GradingValidateResponse
import com.gradethread.app.grading.GradingValidatedItem
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over grading twenty garments in one press.
 *
 * ⚠ THE CONFIRMATION IS WHERE THE CREDITS GET SPENT. A seller pressing Grade on
 * a selection commits the whole cost in one tap, and the dialog is the only
 * place the arithmetic appears - what the tier costs, and what is left. It is
 * captured for that reason.
 *
 * ⚠ BLOCKED ITEMS ARE LISTED WITH THEIR REASONS, not counted. "18 of 20 ready"
 * on its own leaves a seller hunting for the two, so the fixture blocks one
 * item on missing photos and shows the blocker text beside it.
 *
 * ⚠ AND `Empty` IS TERMINAL WHILE `Failed` IS NOT. An empty selection can never
 * validate, so that phase offers no Try again - a retry that re-fails forever
 * reads as the app being broken. The two are captured side by side because
 * they are otherwise the same screen with a message on it.
 *
 * ⚠ THE CREDIT SHEET IS A SLOT. CreditPackSheet resolves its own ViewModel
 * through Hilt, and it REPLACES the submit button rather than sitting beside
 * it: with too few credits there is nothing to press.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class BulkGradeScreenshotTest {

    private fun item(id: String, title: String, ready: Boolean, blockers: List<String> = emptyList()) =
        GradingValidatedItem(
            inventoryItemId = id,
            tier = GradeTier.STANDARD.wire,
            cost = 2.0,
            ready = ready,
            blockers = blockers,
            title = title,
            garmentType = "sweater",
        )

    private val validation = GradingValidateResponse(
        user = GradingUserInfo(
            plan = "pro",
            gradesUsedThisMonth = 42,
            planLimit = 200,
            gradesRemaining = 158,
            includedRemaining = 158,
            creditBalance = 24,
        ),
        items = listOf(
            item("i1", "Patagonia Better Sweater", ready = true),
            item("i2", "Barbour Bedale Wax Jacket", ready = true),
            // Cannot be graded, and the reason has to be on screen.
            item("i3", "Uniqlo Oxford Shirt", ready = false, blockers = listOf("No label photo")),
        ),
        totalCost = 4.0,
        creditsRequired = 4,
        canSubmit = true,
    )

    private val ready = BulkGradeViewModel.State(
        itemIds = listOf("i1", "i2", "i3"),
        phase = BulkGradeMachine.Phase.Ready,
        tier = GradeTier.STANDARD,
        validation = validation,
    )

    @Test
    fun ready_light() = capture("screen-bulkgrade-light") {
        BulkGradeContent(ready, BulkGradeActions(), creditPackSheet = { CreditStandIn() })
    }

    @Test
    fun ready_dark() = capture("screen-bulkgrade-dark", dark = true) {
        BulkGradeContent(ready, BulkGradeActions(), creditPackSheet = { CreditStandIn() })
    }

    /** The confirmation, with both numbers on it. */
    @Test
    fun confirmSpend_light() = capture("screen-bulkgrade-confirm-light") {
        BulkGradeContent(
            ready.copy(pendingConfirmTier = GradeTier.PREMIUM),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /**
     * Not enough credits. The submit button is GONE and the top-up takes its
     * place, because there is nothing to press.
     */
    @Test
    fun blockedOnCredits_light() = capture("screen-bulkgrade-credits-light") {
        BulkGradeContent(
            ready.copy(
                validation = validation.copy(
                    limitExceeded = true,
                    creditsRequired = 40,
                    user = validation.user.copy(creditBalance = 2),
                ),
            ),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** Still validating. */
    @Test
    fun loading_light() = capture("screen-bulkgrade-loading-light") {
        BulkGradeContent(
            BulkGradeViewModel.State(itemIds = listOf("i1", "i2", "i3")),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** Submitting. Nothing may be pressed twice. */
    @Test
    fun submitting_light() = capture("screen-bulkgrade-submitting-light") {
        BulkGradeContent(
            ready.copy(phase = BulkGradeMachine.Phase.Submitting),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** Finished, with what did not go through still counted. */
    @Test
    fun done_light() = capture("screen-bulkgrade-done-light") {
        BulkGradeContent(
            ready.copy(
                phase = BulkGradeMachine.Phase.Done(
                    BulkGradeMachine.Summary(submitted = 2, failedAtSubmit = 0, blockedBeforeSubmit = 1),
                ),
            ),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** A retryable failure. Try again is there. */
    @Test
    fun failed_dark() = capture("screen-bulkgrade-failed-dark", dark = true) {
        BulkGradeContent(
            ready.copy(phase = BulkGradeMachine.Phase.Failed("Could not reach the server.")),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /**
     * Terminal. An empty selection can never validate, so there must be no Try
     * again here - the difference from the capture above is the whole point.
     */
    @Test
    fun emptySelection_dark() = capture("screen-bulkgrade-empty-dark", dark = true) {
        BulkGradeContent(
            BulkGradeViewModel.State(
                phase = BulkGradeMachine.Phase.Empty(BulkGradeMachine.NOTHING_SELECTED),
            ),
            BulkGradeActions(),
            creditPackSheet = { CreditStandIn() },
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
 * ⚠ TOP LEVEL, NOT A METHOD ON THE TEST CLASS. A composable declared as an
 * instance function has the class as its receiver, and Android lint's
 * ComposeUnstableReceiver fails the build for it: an unstable receiver means
 * the function recomposes every time. The other screenshot files already put
 * their helpers here for the same reason.
 */
@Composable
private fun CreditStandIn() {
    Text("Top up credits")
}
