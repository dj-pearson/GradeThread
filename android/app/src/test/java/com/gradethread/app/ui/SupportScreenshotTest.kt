package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.support.SupportActions
import com.gradethread.app.support.SupportContent
import com.gradethread.app.support.SupportTicket
import com.gradethread.app.support.SupportViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over asking a human for help.
 *
 * ⚠ AN EMPTY LIST AND A FAILED LOAD SIT SIDE BY SIDE. Most people never open a
 * ticket, so empty is the ordinary case - and it renders next to the state
 * where the load failed. Telling someone "no tickets" when the truth is "we
 * could not fetch them" hides the one they are waiting on a reply to.
 *
 * ⚠ AND THE VALIDATION ONLY APPEARS ONCE TYPING STARTS. subjectError and
 * bodyError are null while a field is empty, so an untouched form is not
 * telling anyone off - canSend is false regardless. A composer that showed both
 * errors on open would read as broken before anyone did anything, so both the
 * untouched and the invalid forms are captured.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class SupportScreenshotTest {

    private val tickets = listOf(
        SupportTicket(
            id = "t1",
            subject = "A payout is missing from reconciliation",
            status = "open",
            priority = "high",
            lastMessageAt = "2026-08-29T14:02:00Z",
            createdAt = "2026-08-28T09:10:00Z",
        ),
        // Answered and closed. Must look different from the open one above.
        SupportTicket(
            id = "t2",
            subject = "How do I connect a second eBay account?",
            status = "resolved",
            priority = "normal",
            lastMessageAt = "2026-08-21T11:30:00Z",
            resolvedAt = "2026-08-21T11:30:00Z",
            createdAt = "2026-08-20T16:45:00Z",
        ),
    )

    private val loaded = SupportViewModel.State(tickets = tickets)

    @Test
    fun tickets_light() = capture("screen-support-light") {
        SupportContent(loaded, SupportActions())
    }

    @Test
    fun tickets_dark() = capture("screen-support-dark", dark = true) {
        SupportContent(loaded, SupportActions())
    }

    /** Nobody has ever asked for help. The ordinary case, not a failure. */
    @Test
    fun noTickets_light() = capture("screen-support-empty-light") {
        SupportContent(SupportViewModel.State(), SupportActions())
    }

    /**
     * The load failed. Compare with the capture above: saying "no tickets"
     * here would hide the one somebody is waiting on a reply to.
     */
    @Test
    fun loadFailed_dark() = capture("screen-support-error-dark", dark = true) {
        SupportContent(
            SupportViewModel.State(loadError = "Could not reach the server."),
            SupportActions(),
        )
    }

    /** Still fetching. */
    @Test
    fun loading_light() = capture("screen-support-loading-light") {
        SupportContent(SupportViewModel.State(loading = true), SupportActions())
    }

    /** The composer, untouched. No errors yet, and Send is not pressable. */
    @Test
    fun composerUntouched_light() = capture("screen-support-composer-light") {
        SupportContent(loaded.copy(composerOpen = true), SupportActions())
    }

    /**
     * Typed, and both fields too short. THIS is where the errors belong -
     * compare with the untouched form above.
     */
    @Test
    fun composerInvalid_dark() = capture("screen-support-composer-invalid-dark", dark = true) {
        SupportContent(
            loaded.copy(composerOpen = true, subject = "hi", body = "help"),
            SupportActions(),
        )
    }

    /** Sending. Nothing may be pressed twice. */
    @Test
    fun sending_light() = capture("screen-support-sending-light") {
        SupportContent(
            loaded.copy(
                composerOpen = true,
                subject = "A payout is missing from reconciliation",
                body = "eBay says it paid on the 24th and FlipDesk shows nothing for that week.",
                sending = true,
            ),
            SupportActions(),
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
