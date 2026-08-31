package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.onboarding.ActivationChecklist
import com.gradethread.app.onboarding.Onboarding
import com.gradethread.app.onboarding.OnboardingActions
import com.gradethread.app.onboarding.OnboardingContent
import com.gradethread.app.onboarding.OnboardingUseCase
import com.gradethread.app.onboarding.OnboardingViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2976: the first screen a seller sees, which had no golden until now.
 *
 * ⚠ WHY THIS FILE EXISTS AT ALL. US-2902 AC3 put a screenshot test on 46
 * screens and this was not one of them - it is reachable only on a first run,
 * which is presumably how it was missed. Every string extraction in US-2976 was
 * verified as "the words move and the pixels do not", and the onboarding pass
 * was the one that could not be.
 *
 * ⚠ THE PRIMARY BUTTON IS DISABLED ON EXACTLY ONE STEP. The use-case step is
 * the single place a choice is required, because "Continue" with nothing picked
 * would silently mean "skip". Both halves of that are captured: nothing picked
 * and one picked.
 *
 * ⚠ AND A BLOCKED PERMISSION IS NOT A FAILED ONE. `actionable = false` means
 * Android will not put the dialog up again, so the row says so in words rather
 * than offering a button that does nothing. That row is captured, because it is
 * the one a seller can be stuck on.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class OnboardingScreenshotTest {

    private fun state(
        step: Onboarding.Step,
        pageIndex: Int = 0,
        useCase: OnboardingUseCase? = null,
        checklist: List<ActivationChecklist.Row> = emptyList(),
    ) = OnboardingViewModel.State(
        visible = true,
        step = step,
        pageIndex = pageIndex,
        useCase = useCase,
        checklist = checklist,
    )

    @Test
    fun carouselFirstSlide_light() = capture("screen-onboarding-light") {
        OnboardingContent(state(Onboarding.Step.CAROUSEL), OnboardingActions())
    }

    @Test
    fun carouselFirstSlide_dark() = capture("screen-onboarding-dark", dark = true) {
        OnboardingContent(state(Onboarding.Step.CAROUSEL), OnboardingActions())
    }

    /** The last slide, where the button stops saying Next. */
    @Test
    fun carouselLastSlide_light() = capture("screen-onboarding-last-slide-light") {
        OnboardingContent(
            state(Onboarding.Step.CAROUSEL, pageIndex = Onboarding.pages.lastIndex),
            OnboardingActions(),
        )
    }

    /** Nothing picked. The primary button is dead, and that is correct. */
    @Test
    fun useCaseUnpicked_light() = capture("screen-onboarding-usecase-light") {
        OnboardingContent(state(Onboarding.Step.USE_CASE), OnboardingActions())
    }

    /** One picked. Compare with the capture above - the button is live. */
    @Test
    fun useCasePicked_light() = capture("screen-onboarding-usecase-picked-light") {
        OnboardingContent(
            state(Onboarding.Step.USE_CASE, useCase = OnboardingUseCase.RESELLER),
            OnboardingActions(),
        )
    }

    /** Both things still to do. */
    @Test
    fun activationFresh_light() = capture("screen-onboarding-activation-light") {
        OnboardingContent(
            state(
                Onboarding.Step.ACTIVATION,
                checklist = listOf(
                    ActivationChecklist.Row(
                        ActivationChecklist.Item.NOTIFICATIONS,
                        done = false,
                        actionable = true,
                    ),
                    ActivationChecklist.Row(
                        ActivationChecklist.Item.EBAY,
                        done = false,
                        actionable = true,
                    ),
                ),
            ),
            OnboardingActions(),
        )
    }

    /**
     * Alerts refused and un-askable. Android will not show the dialog again, so
     * the row explains rather than offering a button that does nothing.
     */
    @Test
    fun activationBlocked_light() = capture("screen-onboarding-activation-blocked-light") {
        OnboardingContent(
            state(
                Onboarding.Step.ACTIVATION,
                checklist = listOf(
                    ActivationChecklist.Row(
                        ActivationChecklist.Item.NOTIFICATIONS,
                        done = false,
                        actionable = false,
                    ),
                    ActivationChecklist.Row(
                        ActivationChecklist.Item.EBAY,
                        done = true,
                        actionable = false,
                    ),
                ),
            ),
            OnboardingActions(),
        )
    }

    /** Everything ticked. */
    @Test
    fun activationDone_dark() = capture("screen-onboarding-activation-done-dark", dark = true) {
        OnboardingContent(
            state(
                Onboarding.Step.ACTIVATION,
                checklist = ActivationChecklist.Item.entries.map {
                    ActivationChecklist.Row(it, done = true, actionable = false)
                },
            ),
            OnboardingActions(),
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
