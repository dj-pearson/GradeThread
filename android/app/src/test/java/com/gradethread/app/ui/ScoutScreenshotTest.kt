package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.inventory.CategorySuggestion
import com.gradethread.app.scout.ScoutActions
import com.gradethread.app.scout.ScoutCandidate
import com.gradethread.app.scout.ScoutContent
import com.gradethread.app.scout.ScoutError
import com.gradethread.app.scout.ScoutScanResponse
import com.gradethread.app.scout.ScoutSort
import com.gradethread.app.scout.ScoutViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the screen a seller reads standing in a shop.
 *
 * ⚠ A PLAN WALL IS NOT AN ERROR, and telling them apart is the reason this
 * screen was worth capturing. Both are a failed scan with a message on it. The
 * difference is the Try-again button: a plan wall re-hits the same wall every
 * time, so this screen hides the retry and lets the shell's upgrade dialog do
 * the talking. A retry that never works reads as the app being broken rather
 * than the plan being the limit, and no unit test on the state machine can see
 * which buttons ended up on screen.
 *
 * ⚠ AND `actionable` IS A BUY SIGNAL, not a highlight. One fixture candidate
 * carries it and one does not, on purpose: this is the flag that says "enough
 * comps, a confident grade, positive margin", and a seller is about to hand
 * over money on the strength of how it renders.
 *
 * ⚠ THE TRIP LOGGER IS A SLOT. TripQuickLogButton resolves its own ViewModel
 * through Hilt and RoborazziActivity is not a Hilt component, so composing the
 * real one here dies on "does not implement GeneratedComponentManager". It sits
 * ABOVE the fold, so it would have taken every capture in this file rather than
 * the two it took in MoneyScreenshotTest.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ScoutScreenshotTest {

    /** Enough comps, confident grade, real margin. The one worth buying. */
    private val buy = ScoutCandidate(
        itemId = "c1",
        title = "Patagonia Better Sweater, men's medium",
        itemWebUrl = "https://example.invalid/1",
        askingCents = 2_400,
        shadowGrade = 8.5,
        gradeConfidence = 0.88,
        valueLowCents = 6_500,
        valueMedianCents = 8_200,
        valueHighCents = 9_900,
        estMarginCents = 4_100,
        estMarginPct = 1.71,
        underpriced = true,
        actionable = true,
        reason = "14 comps, median $82.00, asking $24.00",
    )

    /** Cheap, but the grade is a guess. NOT a buy signal. */
    private val maybe = ScoutCandidate(
        itemId = "c2",
        title = "Unbranded flannel shirt, large",
        itemWebUrl = "https://example.invalid/2",
        askingCents = 900,
        shadowGrade = 6.0,
        gradeConfidence = 0.41,
        valueLowCents = 1_200,
        valueMedianCents = 1_800,
        valueHighCents = 2_600,
        estMarginCents = 400,
        estMarginPct = 0.44,
        underpriced = false,
        actionable = false,
        reason = "3 comps, grade confidence below the bar",
    )

    private val scanned = ScoutViewModel.State(
        keyword = "patagonia",
        brand = "Patagonia",
        sort = ScoutSort.MARGIN,
        response = ScoutScanResponse(
            scanned = 60,
            candidates = listOf(buy, maybe),
            disclaimer = "Grades are estimated from listing photos and are not certified.",
        ),
        resolvedCategory = CategorySuggestion(
            categoryId = "57988",
            categoryName = "Men's Sweaters",
            categoryTreePath = "Clothing > Men > Sweaters",
        ),
    )

    @Test
    fun scanned_light() = capture("screen-scout-light") {
        ScoutContent(scanned, ScoutActions(), tripQuickLog = { TripLogStandIn() })
    }

    @Test
    fun scanned_dark() = capture("screen-scout-dark", dark = true) {
        ScoutContent(scanned, ScoutActions(), tripQuickLog = { TripLogStandIn() })
    }

    /** Nothing scanned yet. The resting state, and it must not look broken. */
    @Test
    fun idle_light() = capture("screen-scout-idle-light") {
        ScoutContent(ScoutViewModel.State(), ScoutActions(), tripQuickLog = { TripLogStandIn() })
    }

    /** Mid-scan. Every input is disabled so a second scan cannot be started. */
    @Test
    fun scanning_light() = capture("screen-scout-scanning-light") {
        ScoutContent(
            scanned.copy(scanning = true, response = null),
            ScoutActions(),
            tripQuickLog = { TripLogStandIn() },
        )
    }

    /** A real failure. This one CAN be retried, and the button is there. */
    @Test
    fun retryableError_dark() = capture("screen-scout-error-dark", dark = true) {
        ScoutContent(
            scanned.copy(
                response = null,
                errorMessage = UiMessage(
                    R.string.scout_scan_failed,
                    "Could not reach eBay.",
                ),
            ),
            ScoutActions(),
            tripQuickLog = { TripLogStandIn() },
        )
    }

    /**
     * A plan wall. Same shape as the failure above and the retry must be GONE -
     * the shell is already showing the upgrade dialog, and trying again would
     * hit the same wall.
     */
    @Test
    fun planWall_dark() = capture("screen-scout-planwall-dark", dark = true) {
        ScoutContent(
            scanned.copy(
                response = null,
                // A plan wall: OUR sentence with the plan name in it, and
                // no server detail to prefer.
                errorMessage = UiMessage(
                    R.string.scout_plan_locked,
                    args = listOf("Pro"),
                ),
                planWall = ScoutError.PlanLocked(requiredPlan = "pro"),
            ),
            ScoutActions(),
            tripQuickLog = { TripLogStandIn() },
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
private fun TripLogStandIn() {
    TextButton(onClick = {}) { Text("Log a trip") }
}
