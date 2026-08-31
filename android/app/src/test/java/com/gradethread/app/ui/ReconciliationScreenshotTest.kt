package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.marketplaces.reconciliation.OrphanEbayListing
import com.gradethread.app.marketplaces.reconciliation.ReconciliationActions
import com.gradethread.app.marketplaces.reconciliation.ReconciliationContent
import com.gradethread.app.marketplaces.reconciliation.ReconciliationViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the eBay listings FlipDesk has no item for.
 *
 * ⚠ CREATE-ALL IS THE ONE THAT CANNOT BE TAKEN BACK. Every other button here
 * touches one listing. That one mints an inventory item for every orphan at
 * once, so it sits behind a confirmation - and the confirmation is captured,
 * because a dialog that quietly stopped rendering turns a two-step decision
 * into a single press on a bulk write.
 *
 * ⚠ AND `rowErrors` IS PER ROW, WHICH IS THE POINT. A create-all that half
 * worked leaves some rows done and some refused, and the message under each
 * card is the only report of which is which. One banner saying "something
 * failed" is the wrong answer to a screen where the useful one is "these two
 * did". The fixture fails ONE of three rows for that reason.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ReconciliationScreenshotTest {

    private val orphans = listOf(
        orphan("o1", "Patagonia Better Sweater, men's medium", price = 78.00, sku = "PAT-BS-M"),
        // No SKU and no title of its own. The hardest row to act on.
        orphan("o2", null, price = 24.00, sku = null),
        orphan("o3", "Barbour Bedale Wax Jacket", price = 210.00, sku = "BAR-BED-L"),
    )

    private val loaded = ReconciliationViewModel.State(loading = false, orphans = orphans)

    @Test
    fun orphans_light() = capture("screen-reconcile-light") {
        ReconciliationContent(loaded, ReconciliationActions())
    }

    @Test
    fun orphans_dark() = capture("screen-reconcile-dark", dark = true) {
        ReconciliationContent(loaded, ReconciliationActions())
    }

    /** Nothing unmatched. Every eBay listing has an item, and it should read that way. */
    @Test
    fun nothingToReconcile_light() = capture("screen-reconcile-empty-light") {
        ReconciliationContent(
            ReconciliationViewModel.State(loading = false),
            ReconciliationActions(),
        )
    }

    /**
     * One row refused, named on the row it belongs to while its neighbours stay
     * clean. That is the whole reason rowErrors is a map.
     *
     * ⚠ NO SUCCESS BANNER HERE, deliberately. The first recording paired this
     * with "Created 2 of 3 items." and left all three rows on screen - a state
     * the app cannot reach, because a created orphan leaves the list. A golden
     * of an impossible screen is a golden nobody can reason from.
     */
    @Test
    fun rowScopedFailure_dark() = capture("screen-reconcile-rowerror-dark", dark = true) {
        ReconciliationContent(
            loaded.copy(
                rowErrors = mapOf(
                    "o2" to UiMessage(
                        // The real shape: our sentence with eBay's behind it.
                        R.string.reconcile_error_create,
                        detail = "eBay would not return this listing's details.",
                    ),
                ),
            ),
            ReconciliationActions(),
        )
    }

    /** The other half of that run: one orphan left, and the banner that fits it. */
    @Test
    fun partiallyCreated_light() = capture("screen-reconcile-partial-light") {
        ReconciliationContent(
            loaded.copy(
                orphans = orphans.filter { it.id == "o2" },
                rowErrors = mapOf(
                    "o2" to UiMessage(
                        // The real shape: our sentence with eBay's behind it.
                        R.string.reconcile_error_create,
                        detail = "eBay would not return this listing's details.",
                    ),
                ),
                banner = "Created 2 of 3 items.",
            ),
            ReconciliationActions(),
        )
    }

    /** Mid-run, with the progress count. */
    @Test
    fun creatingAll_light() = capture("screen-reconcile-progress-light") {
        ReconciliationContent(
            loaded.copy(busy = true, bulkProgress = 2 to 3),
            ReconciliationActions(),
        )
    }

    /** The confirmation that stands between one press and three new items. */
    @Test
    fun confirmCreateAll_dark() = capture("screen-reconcile-confirm-dark", dark = true) {
        ReconciliationContent(loaded, ReconciliationActions(), confirmCreateAll = true)
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-reconcile-error-dark", dark = true) {
        ReconciliationContent(
            loaded.copy(
                errorMessage = UiMessage(
                    R.string.reconcile_error_load,
                    detail = "Could not reach eBay.",
                ),
            ),
            ReconciliationActions(),
        )
    }

    private fun orphan(id: String, title: String?, price: Double, sku: String?) = OrphanEbayListing(
        id = id,
        ebayItemId = "1${id.drop(1)}5544332211",
        customLabel = sku,
        title = title,
        currentPrice = price,
        availableQuantity = 1,
        listingUrl = "https://example.invalid/$id",
        listingFormat = "FIXED_PRICE",
        importedAt = "2026-08-24T10:15:00Z",
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
