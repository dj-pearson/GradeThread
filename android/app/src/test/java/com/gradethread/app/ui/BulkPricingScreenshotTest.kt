package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.marketplaces.pricing.BulkListing
import com.gradethread.app.marketplaces.pricing.BulkPricing
import com.gradethread.app.marketplaces.pricing.BulkPricingActions
import com.gradethread.app.marketplaces.pricing.BulkPricingContent
import com.gradethread.app.marketplaces.pricing.BulkPricingViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over repricing many listings at once.
 *
 * ⚠ THE PREVIEW IS THE SAFETY FEATURE. Every other screen in this sweep shows a
 * seller what already happened. This one shows what is ABOUT to happen to a
 * page of LIVE prices and then does it in a single press, so the per-row new
 * price and the rowErrors beside it are the only thing standing between a
 * mistyped percentage and every listing being repriced wrongly at once.
 *
 * So one row in the fixture FAILED validation while its neighbours passed. A
 * screen that quietly stopped rendering rowErrors would look completely normal,
 * and the seller would press Apply.
 *
 * ⚠ AND THE MULTI-STORE BANNER GETS ITS OWN CAPTURE (US-1216). Every bulk edit
 * routes through the PRIMARY store and `listings` carries no per-store column,
 * so with more than one connected account the editor has to name the target.
 * If that line stops rendering, a seller with two shops reprices the wrong one
 * and nothing on screen says so.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class BulkPricingScreenshotTest {

    private val listings = listOf(
        BulkListing(id = "l1", title = "Levi's 501 Straight Jean", price = 78.0, quantity = 1),
        BulkListing(id = "l2", title = "Barbour Bedale Wax Jacket", price = 210.0, quantity = 1),
        BulkListing(id = "l3", title = "Uniqlo Oxford Shirt", price = 22.0, quantity = 3),
    )

    private val loaded = BulkPricingViewModel.State(
        loading = false,
        listings = listings,
        selected = setOf("l1", "l2"),
        mode = BulkPricing.Mode.REDUCE,
        inputText = "15",
    )

    @Test
    fun preview_light() = capture("screen-bulkpricing-light") {
        BulkPricingContent(loaded, BulkPricingActions())
    }

    @Test
    fun preview_dark() = capture("screen-bulkpricing-dark", dark = true) {
        BulkPricingContent(loaded, BulkPricingActions())
    }

    /**
     * One row rejected by the last push, two accepted. The per-row message is
     * the only place that failure is reported.
     */
    @Test
    fun rowError_dark() = capture("screen-bulkpricing-rowerror-dark", dark = true) {
        BulkPricingContent(
            loaded.copy(
                selected = setOf("l1", "l2", "l3"),
                rowErrors = mapOf(
                    "l2" to UiMessage(
                        R.string.bulkpricing_row_rejected,
                        "eBay rejected this price: below the reserve.",
                    ),
                ),
            ),
            BulkPricingActions(),
        )
    }

    /** Two shops connected, so the editor must name which one it edits. */
    @Test
    fun multiStore_light() = capture("screen-bulkpricing-multistore-light") {
        BulkPricingContent(
            loaded.copy(primaryStoreName = "Thread & Bone", multiStore = true),
            BulkPricingActions(),
        )
    }

    /** Nothing selected: Apply must not offer to change anything. */
    @Test
    fun nothingSelected_light() = capture("screen-bulkpricing-noselection-light") {
        BulkPricingContent(
            loaded.copy(selected = emptySet(), mode = BulkPricing.Mode.NONE, inputText = ""),
            BulkPricingActions(),
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
