package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.ai.AiExtractReview
import com.gradethread.app.ai.AiFillReviewSheet
import com.gradethread.app.ai.FieldSuggestion
import com.gradethread.app.ai.FieldSuggestionEntry
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: the AI draft review, and it needed NO refactor to get here.
 *
 * THE FINDING WORTH KEEPING. AC3 names six screens and assumes all six are
 * ViewModel-bound; two are not. AiFillReviewSheet already takes a Review and
 * three lambdas, holding only local remember state for the checkboxes, so it
 * was screenshot-ready the whole time and nobody had looked. Counting
 * "viewModel." per file before planning the extraction is what turned that up,
 * and it is worth doing before assuming a screen needs surgery.
 *
 * WHAT THESE GOLDENS GUARD. This sheet is the only place a seller sees what the
 * AI changed BEFORE it sticks, and the two tiers must stay visually distinct:
 * applied fields arrive pre-checked and unchecking one is an undo, while
 * low-confidence suggestions arrive UNCHECKED and checking one is an opt-in.
 * The two rows are a few dp apart and mean opposite things. A regression that
 * pre-checks the low-confidence tier would silently apply on-device OCR guesses
 * stamped at 0.4 confidence, which is exactly what AUTO_APPLY_CONFIDENCE = 0.5
 * exists to prevent.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class AiFillReviewScreenshotTest {

    private val applied = listOf(
        AiExtractReview.AppliedField(
            field = "brand",
            value = "Patagonia",
            previousValue = null,
            confidence = 0.94,
            source = "photo",
        ),
        AiExtractReview.AppliedField(
            field = "color",
            value = "Forest green",
            previousValue = "Green",
            confidence = 0.88,
            source = "photo",
        ),
        AiExtractReview.AppliedField(
            field = "material",
            value = "Recycled polyester",
            previousValue = null,
            confidence = 0.71,
            source = "tag",
        ),
    )

    private val lowConfidence = listOf(
        FieldSuggestionEntry(
            field = "size",
            suggestion = FieldSuggestion(value = "M", confidence = 0.40, source = "ocr"),
        ),
        FieldSuggestionEntry(
            field = "department",
            suggestion = FieldSuggestion(value = "Women", confidence = 0.45, source = "photo"),
        ),
    )

    /**
     * ONE base fixture plus copy() at each call site, rather than a builder with
     * a parameter per field. The builder was eight parameters and detekt was
     * right to refuse it: a fixture whose signature has to be read is a fixture
     * that hides what each test is actually varying.
     */
    private val base = AiExtractReview.Review(
        itemId = "item_fixture",
        applied = applied,
        lowConfidence = lowConfidence,
        measurements = mapOf("Chest" to 21.0, "Length" to 28.5, "Sleeve" to 25.0),
        measurementsApplied = true,
        conditionSummary = "Light pilling at the cuffs, no holes or stains.",
        actionsRemaining = 12,
    )

    @Test
    fun bothTiers_light() = capture("screen-aifill-both-light") { Sheet(base) }

    @Test
    fun bothTiers_dark() = capture("screen-aifill-both-dark", dark = true) { Sheet(base) }

    /**
     * Nothing was confident enough to apply. Every row on screen is an opt-in,
     * and none of them may render pre-checked.
     */
    @Test
    fun lowConfidenceOnly_light() = capture("screen-aifill-lowonly-light") {
        Sheet(
            base.copy(
                applied = emptyList(),
                measurements = emptyMap(),
                measurementsApplied = false,
                conditionSummary = null,
            ),
        )
    }

    /**
     * The two banners that explain WHY the result is thin: on-device OCR stood
     * in for the model, and the eBay lookup has not come back yet.
     */
    @Test
    fun fallbackAndPendingBanners_light() = capture("screen-aifill-banners-light") {
        Sheet(
            base.copy(
                lowConfidence = emptyList(),
                measurements = emptyMap(),
                measurementsApplied = false,
                usedLiveTextFallback = true,
                ebayPending = true,
                actionsRemaining = 1,
            ),
        )
    }

    /**
     * Same shape as the other two screenshot files, deliberately.
     */
    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}

/**
 * Top level for the same reason GradeReportScreenshotTest's helper is: an
 * instance composable on a test class trips ComposeUnstableReceiver, and a test
 * class is never going to be @Stable.
 */
@Composable
private fun Sheet(review: AiExtractReview.Review) {
    AiFillReviewSheet(
        review = review,
        onApply = { _, _, _ -> },
        onUndoAll = {},
        onCancel = {},
    )
}
