package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.support.SupportMessage
import com.gradethread.app.support.SupportThread
import com.gradethread.app.support.SupportThreadActions
import com.gradethread.app.support.SupportThreadContent
import com.gradethread.app.support.SupportThreadViewModel
import com.gradethread.app.support.SupportTicket
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over one support conversation.
 *
 * ⚠ REPLYING TO A RESOLVED TICKET REOPENS IT, and `reopenNotice` is the only
 * place that is said. Someone adding "thanks, all sorted" to a closed ticket
 * would put it straight back in the queue without that line, and neither they
 * nor support would know why it came back. The resolved thread is captured for
 * exactly that sentence.
 *
 * ⚠ AND WHOSE MESSAGE IS WHOSE RESTS ON ONE LABEL. `fromMe` is
 * `author == "you"`, and the golden shows the bubbles are otherwise identical -
 * same fill, same alignment, same width. The word "You" or "Support" above the
 * text is the entire distinction. A thread that dropped or misassigned it reads
 * as support saying what the seller said, and no assertion on the state can see
 * that. The fixture alternates so the pattern has to hold three times.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class SupportThreadScreenshotTest {

    private val openTicket = SupportTicket(
        id = "t1",
        subject = "A payout is missing from reconciliation",
        status = "open",
        priority = "high",
        lastMessageAt = "2026-08-29T14:02:00Z",
        createdAt = "2026-08-28T09:10:00Z",
    )

    private val messages = listOf(
        message("m1", "you", "eBay says it paid on the 24th and FlipDesk shows nothing that week."),
        message("m2", "support", "Thanks - can you send the payout reference from the eBay report?"),
        message("m3", "you", "It is EBAY-p1. The deposit landed but the sales are still unmatched."),
    )

    private val open = SupportThreadViewModel.State(
        thread = SupportThread(ticket = openTicket, messages = messages),
    )

    @Test
    fun openThread_light() = capture("screen-supportthread-light") {
        SupportThreadContent(open, SupportThreadActions())
    }

    @Test
    fun openThread_dark() = capture("screen-supportthread-dark", dark = true) {
        SupportThreadContent(open, SupportThreadActions())
    }

    /**
     * Resolved. The notice saying a reply reopens it is the whole reason this
     * capture exists.
     */
    @Test
    fun resolvedThread_light() = capture("screen-supportthread-resolved-light") {
        SupportThreadContent(
            open.copy(
                thread = SupportThread(
                    ticket = openTicket.copy(
                        status = "resolved",
                        resolvedAt = "2026-08-29T16:00:00Z",
                    ),
                    messages = messages,
                ),
            ),
            SupportThreadActions(),
        )
    }

    /** A reply typed and ready. */
    @Test
    fun replyTyped_light() = capture("screen-supportthread-reply-light") {
        SupportThreadContent(
            open.copy(reply = "Still nothing on the 30th - anything else I can send?"),
            SupportThreadActions(),
        )
    }

    /** Sending. Nothing may be pressed twice. */
    @Test
    fun sending_light() = capture("screen-supportthread-sending-light") {
        SupportThreadContent(
            open.copy(reply = "Still nothing on the 30th.", sending = true),
            SupportThreadActions(),
        )
    }

    /** Still fetching the thread. */
    @Test
    fun loading_light() = capture("screen-supportthread-loading-light") {
        SupportThreadContent(SupportThreadViewModel.State(loading = true), SupportThreadActions())
    }

    /** The thread could not be loaded. Back and retry, both offered. */
    @Test
    fun loadFailed_dark() = capture("screen-supportthread-error-dark", dark = true) {
        SupportThreadContent(
            SupportThreadViewModel.State(
                loadError = UiMessage(
                    R.string.support_error_load_one,
                    detail = "Could not reach the server.",
                ),
            ),
            SupportThreadActions(),
        )
    }

    /** The thread loaded and the REPLY failed. Two different failures. */
    @Test
    fun sendFailed_dark() = capture("screen-supportthread-send-error-dark", dark = true) {
        SupportThreadContent(
            open.copy(
                reply = "Still nothing on the 30th.",
                // No server detail: the seller sees OUR sentence, which is the
                // case the fixture "That reply did not send." never covered.
                sendError = UiMessage(R.string.support_error_send_reply),
            ),
            SupportThreadActions(),
        )
    }

    private fun message(id: String, author: String, body: String) = SupportMessage(
        id = id,
        author = author,
        body = body,
        createdAt = "2026-08-29T14:02:00Z",
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
