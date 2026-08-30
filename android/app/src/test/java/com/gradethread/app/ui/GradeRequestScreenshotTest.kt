package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.grading.GradeReportDto
import com.gradethread.app.grading.GradeRequestActions
import com.gradethread.app.grading.GradeRequestContent
import com.gradethread.app.grading.GradeRequestMachine
import com.gradethread.app.grading.GradeRequestViewModel
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
 * US-2902 AC3: goldens over asking for one grade.
 *
 * ⚠ FOUR ENDINGS MEAN FOUR DIFFERENT THINGS AND LOOK ALIKE. Every one leaves
 * the seller on a screen with a sentence and a button:
 *
 *   PendingReview    graded, but a human is checking it - NOT a failure
 *   StillProcessing  we stopped waiting; the grade is still coming
 *   NeedsPhotos      we cannot start, and there is something to fix
 *   Failed           it broke, and retrying is worth a try
 *
 * Telling a seller "couldn't grade this item" when the truth is "a human is
 * looking at it" produces a support ticket and a refund request. The words and
 * the buttons are the entire difference, and only a capture sees them.
 *
 * ⚠ AND THE SPEND CONFIRMATION IS SKIPPED WHEN NOTHING IS SPENT. The first
 * Standard grade of the month can be included in the plan, and a confirmation
 * dialog for a free action is what trains people to tap through the one that
 * costs money. The paid case is captured; the free one is the ordinary Ready
 * screen above it.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class GradeRequestScreenshotTest {

    private val readyItem = GradingValidatedItem(
        inventoryItemId = "i1",
        tier = GradeTier.STANDARD.wire,
        cost = 2.0,
        ready = true,
        title = "Patagonia Better Sweater",
        garmentType = "sweater",
    )

    private val validation = GradingValidateResponse(
        user = GradingUserInfo(
            plan = "pro",
            gradesUsedThisMonth = 12,
            planLimit = 200,
            gradesRemaining = 188,
            includedRemaining = 188,
            creditBalance = 14,
        ),
        items = listOf(readyItem),
        totalCost = 2.0,
        creditsRequired = 2,
        canSubmit = true,
    )

    private val ready = GradeRequestViewModel.State(
        itemId = "i1",
        phase = GradeRequestMachine.Phase.Ready,
        tier = GradeTier.STANDARD,
        validation = validation,
    )

    private val report = GradeReportDto(
        id = "r1",
        overallScore = 8.5,
        gradeTier = "Excellent",
        fabricConditionScore = 8.5,
        structuralIntegrityScore = 9.0,
        cosmeticAppearanceScore = 8.0,
        functionalElementsScore = 8.5,
        odorCleanlinessScore = 9.0,
        aiSummary = "Light pilling at the cuffs, no holes, zip runs cleanly.",
        confidenceScore = 0.88,
        certificateId = "GT-NOT-REAL-0001",
        createdAt = "2026-08-30T09:00:00Z",
    )

    @Test
    fun ready_light() = capture("screen-graderequest-light") {
        GradeRequestContent(ready, GradeRequestActions(), creditPackSheet = { CreditStandIn() })
    }

    @Test
    fun ready_dark() = capture("screen-graderequest-dark", dark = true) {
        GradeRequestContent(ready, GradeRequestActions(), creditPackSheet = { CreditStandIn() })
    }

    /** Not ready: the item is missing photos, and the reasons are listed. */
    @Test
    fun blockedItem_light() = capture("screen-graderequest-blocked-light") {
        GradeRequestContent(
            ready.copy(
                validation = validation.copy(
                    items = listOf(readyItem.copy(ready = false, blockers = listOf("No label photo", "No back photo"))),
                    canSubmit = false,
                ),
            ),
            GradeRequestActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** The spend confirmation, on a tier that actually costs credits. */
    @Test
    fun confirmSpend_light() = capture("screen-graderequest-confirm-light") {
        GradeRequestContent(
            ready.copy(pendingConfirmTier = GradeTier.PREMIUM),
            GradeRequestActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** Working. The grade is being produced. */
    @Test
    fun processing_light() = capture("screen-graderequest-processing-light") {
        GradeRequestContent(
            ready.copy(phase = GradeRequestMachine.Phase.Processing),
            GradeRequestActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** It worked. The number this whole product exists to produce. */
    @Test
    fun completed_light() = capture("screen-graderequest-completed-light") {
        GradeRequestContent(
            ready.copy(
                phase = GradeRequestMachine.Phase.Completed(report, "https://example.invalid/cert"),
            ),
            GradeRequestActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /**
     * A human is checking it. NOT a failure, and it must not read as one -
     * compare with the Failed capture below.
     */
    @Test
    fun pendingReview_dark() = capture("screen-graderequest-review-dark", dark = true) {
        GradeRequestContent(
            ready.copy(phase = GradeRequestMachine.Phase.PendingReview(report)),
            GradeRequestActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** We stopped waiting. The grade is still coming, and nothing was charged. */
    @Test
    fun stillProcessing_dark() = capture("screen-graderequest-still-dark", dark = true) {
        GradeRequestContent(
            ready.copy(phase = GradeRequestMachine.Phase.StillProcessing),
            GradeRequestActions(),
            creditPackSheet = { CreditStandIn() },
        )
    }

    /** It broke. This is the only one of the four that offers a retry. */
    @Test
    fun failed_dark() = capture("screen-graderequest-failed-dark", dark = true) {
        GradeRequestContent(
            ready.copy(phase = GradeRequestMachine.Phase.Failed("Could not reach the grader.")),
            GradeRequestActions(),
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
 * ComposeUnstableReceiver fails the build for it.
 */
@Composable
private fun CreditStandIn() {
    Text("Top up credits")
}
