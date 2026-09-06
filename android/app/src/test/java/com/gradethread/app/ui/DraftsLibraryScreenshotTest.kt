package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.autolister.AutolisterBatch
import com.gradethread.app.autolister.AutolisterJob
import com.gradethread.app.autolister.AutolisterViewModel
import com.gradethread.app.autolister.BatchStatus
import com.gradethread.app.autolister.DraftListing
import com.gradethread.app.autolister.DraftsLibraryActions
import com.gradethread.app.autolister.DraftsLibraryContent
import com.gradethread.app.autolister.JobStatus
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the draft listings waiting to go live.
 *
 * ⚠ A STALLED BATCH IS THE ONE A PROGRESS BAR HIDES. The bar sits where it
 * stopped and looks exactly like slow work, so the stalled frame has to carry
 * words and a resume button. It is captured beside the moving batch, because
 * those two are otherwise the same picture.
 *
 * ⚠ AN ESTIMATED PRICE IS A GUESS, and the row says so. It came off the AI
 * rather than off comps, and a seller bulk-publishing forty drafts deserves to
 * know which numbers nobody checked.
 *
 * ⚠ AND A SCHEDULED DRAFT GOES LIVE WITHOUT ANYONE PRESSING ANYTHING. That is
 * the whole point of the schedule, and it is also why the row has to show the
 * time - an unnoticed schedule is a listing published at 3am with the wrong
 * price.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class DraftsLibraryScreenshotTest {

    private val drafts = listOf(
        DraftListing(
            id = "d1",
            inventoryItemId = "i1",
            listingTitle = "Patagonia Better Sweater, men's medium, oatmeal",
            listingPrice = 68.0,
            ebayCondition = "USED_EXCELLENT",
            quantity = 1,
        ),
        DraftListing(
            id = "d2",
            inventoryItemId = "i2",
            listingTitle = "Levi's 501 shrink-to-fit, W32 L34",
            listingPrice = 44.0,
            priceIsEstimated = true,
            quantity = 1,
        ),
        DraftListing(
            id = "d3",
            inventoryItemId = "i3",
            listingTitle = "Carhartt Detroit jacket, large, brown duck",
            listingPrice = 125.0,
            scheduledPublishAt = "2026-09-02T14:00:00Z",
            quantity = 1,
        ),
        DraftListing(
            id = "d4",
            inventoryItemId = "i4",
            listingTitle = "Pendleton wool shirt, medium, board plaid",
            listingPrice = 52.0,
            publishError = "eBay rejected the listing: the size aspect is required.",
            quantity = 1,
        ),
    )

    private val loaded = AutolisterViewModel.State(drafts = drafts)

    private val running = AutolisterBatch(
        id = "b1",
        status = BatchStatus.RUNNING,
        itemCount = 12,
        succeededCount = 5,
        failedCount = 0,
    )

    @Test
    fun drafts_light() = capture("screen-drafts-light") {
        DraftsLibraryContent(loaded, DraftsLibraryActions())
    }

    @Test
    fun drafts_dark() = capture("screen-drafts-dark", dark = true) {
        DraftsLibraryContent(loaded, DraftsLibraryActions())
    }

    /** Nothing drafted yet. */
    @Test
    fun empty_light() = capture("screen-drafts-empty-light") {
        DraftsLibraryContent(AutolisterViewModel.State(), DraftsLibraryActions())
    }

    /** Still loading. */
    @Test
    fun loading_light() = capture("screen-drafts-loading-light") {
        DraftsLibraryContent(
            AutolisterViewModel.State(loading = true),
            DraftsLibraryActions(),
        )
    }

    /** Some rows picked, so the bulk-edit button appears. */
    @Test
    fun selection_light() = capture("screen-drafts-selected-light") {
        DraftsLibraryContent(
            loaded.copy(selected = setOf("d1", "d2")),
            DraftsLibraryActions(),
        )
    }

    /** A batch moving along. Compare with the stalled capture below. */
    @Test
    fun batchRunning_light() = capture("screen-drafts-batch-light") {
        DraftsLibraryContent(loaded.copy(batch = running), DraftsLibraryActions())
    }

    /**
     * The same fraction, stopped. Without the words and the resume button this
     * is indistinguishable from the capture above.
     */
    @Test
    fun batchStalled_light() = capture("screen-drafts-stalled-light") {
        DraftsLibraryContent(
            loaded.copy(batch = running, stalled = true),
            DraftsLibraryActions(),
        )
    }

    /** Some of the batch failed, with the reasons and the retry. */
    @Test
    fun batchFailed_light() = capture("screen-drafts-batch-failed-light") {
        DraftsLibraryContent(
            loaded.copy(
                batch = running.copy(
                    status = BatchStatus.COMPLETED,
                    succeededCount = 9,
                    failedCount = 3,
                ),
                jobs = listOf(
                    AutolisterJob(
                        id = "j1",
                        inventoryItemId = "i9",
                        status = JobStatus.FAILED,
                        error = "No photos on this item.",
                        attempts = 2,
                    ),
                    AutolisterJob(
                        id = "j2",
                        inventoryItemId = "i10",
                        status = JobStatus.FAILED,
                        error = "eBay refused the category.",
                        attempts = 2,
                    ),
                ),
            ),
            DraftsLibraryActions(),
        )
    }

    /**
     * Something finished.
     *
     * US-2976: the sentence the app actually produces. The old fixture said
     * "Repriced 2 drafts.", which no code path here has ever generated - the
     * bulk-price banner reads "Updated 2 drafts."
     */
    @Test
    fun banner_light() = capture("screen-drafts-banner-light") {
        DraftsLibraryContent(
            loaded.copy(
                banner = UiMessage.plural(
                    R.plurals.autolister_updated_drafts,
                    args = listOf(2),
                    quantity = 2,
                ),
            ),
            DraftsLibraryActions(),
        )
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-drafts-error-dark", dark = true) {
        DraftsLibraryContent(
            loaded.copy(errorMessage = UiMessage(R.string.autolister_unreachable)),
            DraftsLibraryActions(),
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
