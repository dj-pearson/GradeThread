package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.ai.AiExtractActions
import com.gradethread.app.ai.AiExtractContent
import com.gradethread.app.ai.AiExtractPhase
import com.gradethread.app.ai.AiFillReviewViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the AI-extraction SCREEN.
 *
 * ⚠ DELIBERATELY NOT A DUPLICATE OF AiFillReviewScreenshotTest. That one covers
 * AiFillReviewSheet - the card of suggested fields, which was already stateless
 * and already captured in four images. What had no coverage is the screen
 * AROUND it: the phases a seller waits through before the sheet appears, and
 * the failure where it never does.
 *
 * ⚠ THE WAITING STATES ARE THE POINT. Extraction runs against photos that have
 * already been uploaded, so a seller sits on this screen while it happens. If
 * Progress stops rendering its phase they are looking at a blank screen during
 * the slowest thing the app does, with no way to tell "working" from "stuck".
 *
 * The Failed branch is captured too, and its primary action is LEAVING rather
 * than retrying - the code comment explains why: the item and its photos
 * already exist, so re-running extraction belongs to the item canvas, and
 * offering "try again" here would be a button that does not do what it says.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class AiExtractScreenshotTest {

    private fun state(phase: AiExtractPhase?) = AiFillReviewViewModel.State(itemId = "i1", phase = phase)

    @Test
    fun uploading_light() = capture("screen-aiextract-uploading-light") {
        AiExtractContent(state(AiExtractPhase.Uploading(done = 2, total = 5)), AiExtractActions())
    }

    @Test
    fun uploading_dark() = capture("screen-aiextract-uploading-dark", dark = true) {
        AiExtractContent(state(AiExtractPhase.Uploading(done = 2, total = 5)), AiExtractActions())
    }

    /** Photos are up; the model is working. No progress figure to show. */
    @Test
    fun running_light() = capture("screen-aiextract-running-light") {
        AiExtractContent(state(AiExtractPhase.Running), AiExtractActions())
    }

    /**
     * It failed. The primary action is to leave, not to retry - re-running
     * extraction belongs to the item canvas, and a retry button here would not
     * do what it says.
     */
    @Test
    fun failed_dark() = capture("screen-aiextract-failed-dark", dark = true) {
        AiExtractContent(
            state(AiExtractPhase.Failed("The label photo was too blurry to read.")),
            AiExtractActions(),
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
