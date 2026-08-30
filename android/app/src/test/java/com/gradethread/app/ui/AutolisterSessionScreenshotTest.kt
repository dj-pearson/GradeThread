package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.autolister.AutolisterSessionActions
import com.gradethread.app.autolister.AutolisterSessionContent
import com.gradethread.app.autolister.AutolisterSessionState
import com.gradethread.app.autolister.AutolisterSessionViewModel
import com.gradethread.app.autolister.GroupSuggestion
import com.gradethread.app.autolister.HandoffSummary
import com.gradethread.app.autolister.SessionGroup
import com.gradethread.app.autolister.SessionPhoto
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over sorting a pile of photos into items.
 *
 * ⚠ THE WHOLE POINT IS WHICH PHOTOS BELONG TO WHICH ITEM. A group holds every
 * photo of one garment, and a photo in the wrong group means a listing shows
 * somebody else's jacket. Selection is visible state for that reason, and the
 * goldens capture a selection MID-FLIGHT rather than only the tidy before and
 * after - the moment a seller is about to commit a grouping is the moment the
 * screen has to be readable.
 *
 * ⚠ AND A BATCH ON THE SHELF IS NOT A FAILURE. `waiting` is work already sent,
 * parked until a desktop with the extension opens. A seller who reads that as
 * "nothing happened" sends it again and gets two of everything.
 *
 * ⚠ THE FOUR BUSY STATES ARE FOUR DIFFERENT WAITS. Importing, proposing,
 * verifying and sending each leave the screen unusable for a different reason,
 * and a banner naming the wrong one is a seller waiting on the wrong thing.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class AutolisterSessionScreenshotTest {

    private fun photo(id: String) = SessionPhoto(
        id = id,
        storagePath = "u1/_staging/$id.jpg",
        url = "https://example.invalid/$id.jpg",
        width = 1200,
        height = 1600,
        bytes = 240_000,
    )

    private val photos = (1..6).map { photo("p$it") }

    private val session = AutolisterSessionState(
        stagingSessionId = "sess-1",
        photos = photos,
        groups = listOf(
            SessionGroup(id = "g1", photoIds = listOf("p1", "p2", "p3"), coverId = "p1"),
            SessionGroup(id = "g2", photoIds = listOf("p4"), coverId = "p4"),
        ),
        suggestions = listOf(
            GroupSuggestion(
                type = "merge",
                groupIds = listOf("g1", "g2"),
                photoIds = listOf("p1", "p4"),
                confidence = 0.71,
                reason = "Same garment from two angles.",
            ),
        ),
        createdAt = 1_756_000_000_000,
    )

    private val ready = AutolisterSessionViewModel.State(loading = false, session = session)

    @Test
    fun grouped_light() = capture("screen-autolister-light") {
        AutolisterSessionContent(ready, AutolisterSessionActions())
    }

    @Test
    fun grouped_dark() = capture("screen-autolister-dark", dark = true) {
        AutolisterSessionContent(ready, AutolisterSessionActions())
    }

    /**
     * Two photos picked and not yet grouped. The moment before a seller
     * commits a grouping, which is when the screen most needs to be readable.
     */
    @Test
    fun selectionInFlight_light() = capture("screen-autolister-selecting-light") {
        AutolisterSessionContent(
            ready,
            AutolisterSessionActions(),
            selected = setOf("p5", "p6"),
        )
    }

    /** An empty session. Nothing imported yet. */
    @Test
    fun empty_light() = capture("screen-autolister-empty-light") {
        AutolisterSessionContent(
            AutolisterSessionViewModel.State(loading = false),
            AutolisterSessionActions(),
        )
    }

    /** Still loading the session. */
    @Test
    fun loading_light() = capture("screen-autolister-loading-light") {
        AutolisterSessionContent(AutolisterSessionViewModel.State(), AutolisterSessionActions())
    }

    /** Importing, with the done-of-total and the photos it had to skip. */
    @Test
    fun importing_light() = capture("screen-autolister-importing-light") {
        AutolisterSessionContent(
            ready.copy(
                busy = AutolisterSessionViewModel.Busy.IMPORTING,
                done = 4,
                total = 9,
                skipped = 1,
            ),
            AutolisterSessionActions(),
        )
    }

    /** Sending to the desktop. A different wait from importing. */
    @Test
    fun sending_light() = capture("screen-autolister-sending-light") {
        AutolisterSessionContent(
            ready.copy(busy = AutolisterSessionViewModel.Busy.SENDING),
            AutolisterSessionActions(),
        )
    }

    /**
     * A batch already on the shelf. NOT a failure - it is waiting for a
     * desktop, and re-sending would produce two of everything.
     */
    @Test
    fun waitingOnDesktop_light() = capture("screen-autolister-waiting-light") {
        AutolisterSessionContent(
            ready.copy(
                waiting = listOf(
                    HandoffSummary(
                        id = "h1",
                        source = "android",
                        status = "pending",
                        photoCount = 12,
                        groupCount = 4,
                        createdAt = "2026-08-29T18:00:00Z",
                    ),
                ),
                sentPhotoCount = 12,
            ),
            AutolisterSessionActions(),
        )
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-autolister-error-dark", dark = true) {
        AutolisterSessionContent(
            ready.copy(errorMessage = "Could not reach the server."),
            AutolisterSessionActions(),
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
