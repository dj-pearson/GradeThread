package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.pricing.RepricingActions
import com.gradethread.app.pricing.RepricingContent
import com.gradethread.app.pricing.RepricingRule
import com.gradethread.app.pricing.RepricingSuggestion
import com.gradethread.app.pricing.RepricingViewModel
import com.gradethread.app.pricing.RuleDraft
import com.gradethread.app.pricing.SuggestionItem
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the rules that cut prices while nobody is looking.
 *
 * ⚠ THIS IS THE ONE SCREEN THAT CHANGES LIVE PRICES ON A TIMER. Every other
 * screen in this sweep reports something that already happened, and even bulk
 * pricing needs a press per batch. A rule here keeps cutting on its own
 * schedule for as long as it is enabled, so the three numbers on a rule card -
 * the drop, the interval and the FLOOR - are the whole safety story.
 *
 * A floor that stops rendering is a rule that looks like it will cut forever.
 * The fixture therefore carries one rule WITH a floor and one WITHOUT, so the
 * two cards have to look different from each other.
 *
 * ⚠ AND THE DELETE DIALOG MAKES A PROMISE. It says prices already changed STAY
 * changed. A seller who reads "delete rule" as "undo what it did" deletes it
 * expecting their old prices back, and gets nothing. That sentence only exists
 * in the layout, so a capture is the only thing that can check it is there.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class RepricingScreenshotTest {

    /** Has a floor. It will stop at $45 and not go lower. */
    private val flooredRule = RepricingRule(
        id = "r1",
        name = "Slow movers, 10% a week",
        enabled = true,
        filterBrand = "Patagonia",
        minAgeDays = 30,
        dropPct = 10.0,
        intervalDays = 7,
        floorPriceCents = 4_500,
    )

    /** No floor. Nothing on this card says where it stops, because nothing does. */
    private val unflooredRule = RepricingRule(
        id = "r2",
        name = "Everything else, 5% a fortnight",
        enabled = false,
        minAgeDays = 60,
        dropPct = 5.0,
        intervalDays = 14,
        floorPriceCents = null,
    )

    private val suggestion = RepricingSuggestion(
        id = "s1",
        currentPriceCents = 12_800,
        suggestedPriceCents = 10_900,
        compMedianCents = 11_200,
        compCount = 14,
        reasonCode = "above_comps",
        message = "Priced above 14 recent comps.",
        confidence = 0.82,
        item = SuggestionItem(
            title = "Patagonia Better Sweater",
            brand = "Patagonia",
            gradeValue = 8.5,
            gradeLabel = "Excellent",
        ),
    )

    private val loaded = RepricingViewModel.State(
        loading = false,
        rules = listOf(flooredRule, unflooredRule),
        suggestions = listOf(suggestion),
    )

    @Test
    fun rulesAndSuggestions_light() = capture("screen-repricing-light") {
        RepricingContent(loaded, RepricingActions())
    }

    @Test
    fun rulesAndSuggestions_dark() = capture("screen-repricing-dark", dark = true) {
        RepricingContent(loaded, RepricingActions())
    }

    /** Nothing set up yet. Must read as "not started", not as "scan failed". */
    @Test
    fun empty_light() = capture("screen-repricing-empty-light") {
        RepricingContent(
            RepricingViewModel.State(loading = false),
            RepricingActions(),
        )
    }

    /**
     * A finished scan, with the caveat it came back with. The caveat is a
     * warning tone on purpose: a scan that ran against thin comp data is not
     * the same answer as one that ran against plenty.
     */
    @Test
    fun scanned_light() = capture("screen-repricing-scanned-light") {
        RepricingContent(
            loaded.copy(
                banner = "Scanned 41 listings and found 1 worth changing.",
                caveat = "12 listings had fewer than 5 comps, so they were skipped.",
            ),
            RepricingActions(),
        )
    }

    /** The rule editor, open on an existing rule. */
    @Test
    fun ruleEditor_light() = capture("screen-repricing-editor-light") {
        RepricingContent(
            loaded,
            RepricingActions(),
            editing = RuleDraft.from(flooredRule),
        )
    }

    /**
     * The delete confirmation, and the sentence that matters: prices already
     * changed stay changed.
     *
     * ⚠ ROBOLECTRIC COMPOSITES A DIALOG WITHOUT ITS SCRIM, so in this golden
     * the panel sits in the middle of the rule list with the page bright behind
     * it. On a device it is centred over a dimmed screen. The capture is
     * checking the dialog's WORDS, not where it sits - do not "fix" a scrim
     * that is already there.
     */
    @Test
    fun deleteConfirmation_dark() = capture("screen-repricing-delete-dark", dark = true) {
        RepricingContent(
            loaded,
            RepricingActions(),
            deleting = flooredRule,
        )
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-repricing-error-dark", dark = true) {
        RepricingContent(
            loaded.copy(errorMessage = "Could not reach the server."),
            RepricingActions(),
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
