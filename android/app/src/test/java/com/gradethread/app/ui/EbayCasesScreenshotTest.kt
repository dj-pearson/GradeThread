package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.marketplaces.postsale.EbayCancellation
import com.gradethread.app.marketplaces.postsale.EbayCasesActions
import com.gradethread.app.marketplaces.postsale.EbayCasesContent
import com.gradethread.app.marketplaces.postsale.EbayCasesViewModel
import com.gradethread.app.marketplaces.postsale.EbayPaymentDispute
import com.gradethread.app.marketplaces.postsale.EbayReturn
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the desk where a seller answers eBay.
 *
 * ⚠ `busyIds` IS PER CASE AND THE GOLDEN PROVES IT. These buttons issue
 * refunds. One global busy flag would freeze every other case while one waited,
 * and worse, a row whose refund is still travelling has to be the only one
 * locked - a second tap sends the money twice. One fixture row is in flight
 * while its neighbours stay live.
 *
 * ⚠ A CLOSED CASE GETS NO BUTTONS, NOT GREY ONES. Closed rows render through
 * the same cards with `closed = true` and the actions simply absent. A greyed
 * Refund on a case eBay has already settled looks like one tap from working,
 * and the difference is invisible to anything but a capture.
 *
 * ⚠ THE OPEN / CLOSED SPLIT IS DERIVED, not a field. `openDisputes` is
 * `disputes.filterNot(EbayCases::isClosed)`, matched on words like CLOSED and
 * REFUNDED inside the status string. The fixture therefore sets one list per
 * tab and lets the split compute, which also pins that the matcher still works
 * - a fixture that fed the two lists directly would pass over a broken one.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class EbayCasesScreenshotTest {

    /** Open, and the deadline is the only real one in this feature. */
    private val openDispute = EbayPaymentDispute(
        paymentDisputeId = "d1",
        orderId = "17-12345-67890",
        status = "ACTION_NEEDED",
        reason = "Item not as described",
        amount = 128.00,
        currency = "USD",
        openedDate = "2026-08-26T09:00:00.000Z",
        respondByDate = "2026-09-02T09:00:00.000Z",
        buyerUsername = "buyer_mk",
    )

    /** Settled by eBay. Must show no actions at all. */
    private val closedDispute = openDispute.copy(
        paymentDisputeId = "d2",
        status = "CLOSED",
        reason = "Unauthorised transaction",
        amount = 42.00,
        buyerUsername = "buyer_rr",
    )

    private val openReturn = EbayReturn(
        returnId = "r1",
        state = "RETURN_REQUESTED",
        itemId = "125544332211",
        reason = "Doesn't fit",
        creationDate = "2026-08-27T14:20:00.000Z",
    )

    private val closedReturn = EbayReturn(
        returnId = "r2",
        state = "REFUNDED",
        itemId = "125544332212",
        reason = "Changed mind",
        creationDate = "2026-08-19T11:05:00.000Z",
    )

    private val openCancellation = EbayCancellation(
        cancelId = "x1",
        state = "CANCEL_REQUESTED",
        orderId = "17-99999-11111",
        reason = "Ordered by mistake",
        requestorType = "BUYER",
        creationDate = "2026-08-28T08:00:00.000Z",
    )

    private val loaded = EbayCasesViewModel.State(
        loading = false,
        disputes = listOf(openDispute, closedDispute),
        returns = listOf(openReturn, closedReturn),
        cancellations = listOf(openCancellation),
    )

    @Test
    fun disputes_light() = capture("screen-cases-disputes-light") {
        EbayCasesContent(loaded, EbayCasesActions(), nowMs = NOW_MS)
    }

    @Test
    fun disputes_dark() = capture("screen-cases-disputes-dark", dark = true) {
        EbayCasesContent(loaded, EbayCasesActions(), nowMs = NOW_MS)
    }

    /** One refund in flight. Its neighbours must stay pressable. */
    @Test
    fun oneCaseInFlight_light() = capture("screen-cases-busy-light") {
        EbayCasesContent(
            loaded.copy(tab = EbayCasesViewModel.Tab.RETURNS, busyIds = setOf("r1")),
            EbayCasesActions(),
            nowMs = NOW_MS,
        )
    }

    /** Closed rows revealed. Same cards, no action buttons. */
    @Test
    fun closedRevealed_light() = capture("screen-cases-closed-light") {
        EbayCasesContent(loaded.copy(showClosed = true), EbayCasesActions(), nowMs = NOW_MS)
    }

    @Test
    fun cancellations_light() = capture("screen-cases-cancellations-light") {
        EbayCasesContent(
            loaded.copy(tab = EbayCasesViewModel.Tab.CANCELLATIONS),
            EbayCasesActions(),
            nowMs = NOW_MS,
        )
    }

    /** Nothing open on this tab. Not a failure, and it must not read as one. */
    @Test
    fun nothingOpen_light() = capture("screen-cases-empty-light") {
        EbayCasesContent(EbayCasesViewModel.State(loading = false), EbayCasesActions(), nowMs = NOW_MS)
    }

    /** The contest dialog, which is how a seller answers a dispute. */
    @Test
    fun contestDialog_dark() = capture("screen-cases-contest-dark", dark = true) {
        EbayCasesContent(loaded, EbayCasesActions(), contesting = openDispute, nowMs = NOW_MS)
    }

    /** An upload that failed with the bytes still held, so it can be retried. */
    @Test
    fun evidenceFailed_dark() = capture("screen-cases-evidence-error-dark", dark = true) {
        EbayCasesContent(
            loaded.copy(
                errorMessage = "eBay refused the upload.",
                pendingEvidence = EbayCasesViewModel.PendingEvidence(
                    disputeId = "d1",
                    image = ByteArray(0),
                    fileName = "evidence.jpg",
                ),
            ),
            EbayCasesActions(),
            nowMs = NOW_MS,
        )
    }

    private companion object {
        /**
         * A FIXED instant, 2026-08-30T09:00Z. DisputeCard used to call
         * System.currentTimeMillis() itself, so a golden of a deadline expired
         * rather than failed: it went red on a later date with nothing changed.
         * The clock is a parameter now and this pins it.
         */
        const val NOW_MS = 1_788_080_400_000L
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
