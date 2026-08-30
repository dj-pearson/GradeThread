package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.scout.ProspectActions
import com.gradethread.app.scout.ProspectCategory
import com.gradethread.app.scout.ProspectContent
import com.gradethread.app.scout.ProspectDecision
import com.gradethread.app.scout.ProspectGrade
import com.gradethread.app.scout.ProspectItem
import com.gradethread.app.scout.ProspectResponse
import com.gradethread.app.scout.ProspectSellThrough
import com.gradethread.app.scout.ProspectStats
import com.gradethread.app.scout.ProspectViewModel
import com.gradethread.app.scout.ScoutError
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * US-2902 AC3: goldens over the screen a seller reads with the garment in hand.
 *
 * ⚠ THIS IS A BUY-OR-WALK DECISION MADE IN A SHOP. The verdict, the estimated
 * margin and the caveat are the whole product, and they are the sort of thing
 * that reads fine in a unit test and lands wrong on a phone.
 *
 * ⚠ A PLAN WALL IS NOT AN ERROR, and the two are one field apart. Both render
 * an InfoCard over the same layout; the wall gets the WARNING tone, a different
 * heading, and a disabled check button, because the shell is already offering
 * the upgrade and a second tap hits the same wall. Captured side by side, since
 * nothing but the tone and the wording separates them.
 *
 * ⚠ AND THE COST IS OPTIONAL, which changes what the result can say. Without a
 * cost there is no margin and no breakeven, so the same response renders as a
 * different screen. Both are here.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ProspectScreenshotTest {

    private val photos = listOf(File("front_0001.jpg"), File("tag_0002.jpg"))

    private val response = ProspectResponse(
        identified = true,
        item = ProspectItem(
            brand = "Patagonia",
            title = "Better Sweater fleece jacket",
            keywords = listOf("patagonia", "better sweater", "fleece"),
        ),
        category = ProspectCategory(id = "57988", path = "Clothing > Men > Sweaters"),
        grade = ProspectGrade(value = 8.5, tier = "Excellent", confidence = 0.86),
        stats = ProspectStats(
            count = 41,
            lowCents = 5_400,
            medianCents = 8_200,
            highCents = 11_000,
            confidence = 0.81,
            sufficient = true,
        ),
        sellThrough = ProspectSellThrough(
            sellThroughPct = 0.72,
            daysLow = 9,
            daysHigh = 21,
            label = "brisk",
            sampleSize = 41,
        ),
        costCents = 2_400,
        decision = ProspectDecision(
            recommendation = "buy",
            estProceedsCents = 6_540,
            estMarginCents = 4_140,
            roiPct = 172.5,
            breakevenCents = 3_180,
            reason = "41 comps, median $82.00, and it sells in about two weeks.",
            // ⚠ DEFAULTS TO FALSE, and the first recording of this golden left
            // it there: a verdict backed by 41 comps and 86% grade confidence
            // rendered with "the numbers behind this verdict are thin" under
            // it. That is the caveat doing its job on a fixture that had not
            // said the decision was confident, not the app hedging a strong
            // answer - but the golden read as the latter.
            confident = true,
        ),
        ebaySoldSearchUrl = "https://example.invalid/sold",
        source = "sold",
        disclaimer = "Grades are estimated from your photos and are not certified.",
    )

    private val answered = ProspectViewModel.State(
        photos = photos,
        costText = "24.00",
        response = response,
    )

    @Test
    fun verdict_light() = capture("screen-prospect-light") {
        ProspectContent(answered, ProspectActions())
    }

    @Test
    fun verdict_dark() = capture("screen-prospect-dark", dark = true) {
        ProspectContent(answered, ProspectActions())
    }

    /**
     * The same answer with NO cost entered. There is no margin to quote and no
     * breakeven, so this is a different screen, not a smaller one.
     */
    @Test
    fun noCostEntered_light() = capture("screen-prospect-nocost-light") {
        ProspectContent(
            answered.copy(
                costText = "",
                response = response.copy(costCents = null, decision = null),
            ),
            ProspectActions(),
        )
    }

    /** Nothing photographed yet. The resting state. */
    @Test
    fun idle_light() = capture("screen-prospect-idle-light") {
        ProspectContent(ProspectViewModel.State(), ProspectActions())
    }

    /** Mid-check, with both photos attached. */
    @Test
    fun checking_light() = capture("screen-prospect-checking-light") {
        ProspectContent(
            ProspectViewModel.State(photos = photos, costText = "24.00", running = true),
            ProspectActions(),
        )
    }

    /** A real failure. Retryable, so Check it stays enabled. */
    @Test
    fun retryableError_dark() = capture("screen-prospect-error-dark", dark = true) {
        ProspectContent(
            ProspectViewModel.State(
                photos = photos,
                errorMessage = "Could not reach the server.",
            ),
            ProspectActions(),
        )
    }

    /**
     * A plan wall. Warning tone, different heading, and Check it disabled -
     * trying again would hit the same wall.
     */
    @Test
    fun planWall_dark() = capture("screen-prospect-planwall-dark", dark = true) {
        ProspectContent(
            ProspectViewModel.State(
                photos = photos,
                errorMessage = "Prospect is on Pro and above.",
                planWall = ScoutError.PlanLocked(requiredPlan = "pro"),
            ),
            ProspectActions(),
        )
    }

    /**
     * The same verdict when the numbers behind it are thin. The caveat is the
     * only difference, and it is the line that decides whether a seller trusts
     * the answer, so it gets its own capture rather than riding along.
     */
    @Test
    fun thinNumbers_light() = capture("screen-prospect-thin-light") {
        ProspectContent(
            answered.copy(
                response = response.copy(
                    stats = response.stats?.copy(count = 4, sufficient = false),
                    decision = response.decision?.copy(confident = false),
                ),
            ),
            ProspectActions(),
        )
    }

    /** Bought. The check button is done and the way into inventory appears. */
    @Test
    fun boughtIt_light() = capture("screen-prospect-bought-light") {
        ProspectContent(answered.copy(boughtItemId = "i1"), ProspectActions())
    }

    /** Camera permission refused. A warning, not a dead end. */
    @Test
    fun cameraDenied_light() = capture("screen-prospect-camera-denied-light") {
        ProspectContent(
            ProspectViewModel.State(),
            ProspectActions(),
            cameraDenied = true,
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
