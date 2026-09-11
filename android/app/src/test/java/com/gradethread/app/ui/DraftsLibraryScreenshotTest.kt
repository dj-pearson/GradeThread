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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant
import java.time.ZoneId

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

    /**
     * ⚠ THE CLOCK AND THE ZONE ARE FIXTURE VALUES, NOT THE MACHINE'S
     * (US-3311). `DraftCard` renders
     * `ScheduledDrops.statusLine(scheduledAt, zone, now)`, which chooses
     * between "Publishes <when>" and "Was due <when> - publishing on the next
     * run", and it formats that timestamp in the reader's zone. Both used to
     * come from the host: `Instant.now()` and `ZoneId.systemDefault()`.
     *
     * That made these eight goldens undrawable twice over. The Carhartt draft
     * is scheduled for 2026-09-02, so the line flipped to "Was due" on
     * 2026-09-03 and the extra wrapped line pushed every card below it down -
     * 10 percent of the image, on every one of them. And the same PNG rendered
     * "9:00 AM" on a UTC-5 developer machine and "2:00 PM" on a UTC runner, so
     * no single recording could ever have been green in both places.
     *
     * Pinning both makes the golden a statement about the layout of a
     * scheduled row rather than about the day it was recorded. The real
     * branching logic is covered by ScheduledDropsTest, which is where a
     * boundary case belongs anyway.
     */
    private val fixedNow: Instant = Instant.parse("2026-09-01T12:00:00Z")
    private val fixedZone: ZoneId = ZoneId.of("UTC")

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
        DraftsLibraryContent(loaded, DraftsLibraryActions(), now = fixedNow, zone = fixedZone)
    }

    @Test
    fun drafts_dark() = capture("screen-drafts-dark", dark = true) {
        DraftsLibraryContent(loaded, DraftsLibraryActions(), now = fixedNow, zone = fixedZone)
    }

    /** Nothing drafted yet. */
    @Test
    fun empty_light() = capture("screen-drafts-empty-light") {
        DraftsLibraryContent(
            AutolisterViewModel.State(),
            DraftsLibraryActions(),
            now = fixedNow,
            zone = fixedZone,
        )
    }

    /** Still loading. */
    @Test
    fun loading_light() = capture("screen-drafts-loading-light") {
        DraftsLibraryContent(
            AutolisterViewModel.State(loading = true),
            DraftsLibraryActions(),
            now = fixedNow,
            zone = fixedZone,
        )
    }

    /** Some rows picked, so the bulk-edit button appears. */
    @Test
    fun selection_light() = capture("screen-drafts-selected-light") {
        DraftsLibraryContent(
            loaded.copy(selected = setOf("d1", "d2")),
            DraftsLibraryActions(),
            now = fixedNow,
            zone = fixedZone,
        )
    }

    /** A batch moving along. Compare with the stalled capture below. */
    @Test
    fun batchRunning_light() = capture("screen-drafts-batch-light") {
        DraftsLibraryContent(
            loaded.copy(batch = running),
            DraftsLibraryActions(),
            now = fixedNow,
            zone = fixedZone,
        )
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
            now = fixedNow,
            zone = fixedZone,
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
            now = fixedNow,
            zone = fixedZone,
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
            now = fixedNow,
            zone = fixedZone,
        )
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-drafts-error-dark", dark = true) {
        DraftsLibraryContent(
            loaded.copy(errorMessage = UiMessage(R.string.autolister_unreachable)),
            DraftsLibraryActions(),
            now = fixedNow,
            zone = fixedZone,
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            ScreenshotTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
