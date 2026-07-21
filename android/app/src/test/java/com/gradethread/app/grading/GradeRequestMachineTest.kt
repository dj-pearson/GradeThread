package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1336: the four poll outcomes that look alike from the outside and are not.
 */
class GradeRequestMachineTest {

    private val report = GradeReportDto(id = "r1", overallScore = 8.2, gradeTier = "excellent")

    private fun status(
        status: String,
        error: String? = null,
        gradeReport: GradeReportDto? = null,
        certificateUrl: String? = null,
    ) = GradingStatusResponse(
        id = "sub-1",
        status = status,
        error = error,
        gradeReport = gradeReport,
        item = GradingStatusItem(certificateUrl = certificateUrl),
    )

    // ── classify ─────────────────────────────────────────────────────────

    @Test
    fun `a completed status with a report resolves the certificate`() {
        val phase = GradeRequestMachine.classify(
            status("completed", gradeReport = report, certificateUrl = "https://gt/cert/abc"),
        )
        assertTrue(phase is GradeRequestMachine.Phase.Completed)
        assertEquals("https://gt/cert/abc", (phase as GradeRequestMachine.Phase.Completed).certificateUrl)
        assertEquals(8.2, phase.report.overallScore, 0.001)
    }

    @Test
    fun `completed without a report yet keeps polling`() {
        // The bridge row can flip before the report row is written. Calling it
        // done here would render an empty grade card for a real grade.
        assertNull(GradeRequestMachine.classify(status("completed")))
    }

    @Test
    fun `pending review is terminal but carries no certificate`() {
        val phase = GradeRequestMachine.classify(status("pending_review", gradeReport = report))
        assertTrue(phase is GradeRequestMachine.Phase.PendingReview)
        assertEquals(report, (phase as GradeRequestMachine.Phase.PendingReview).report)
    }

    @Test
    fun `needs_photos beats the failure check even though it sets error`() {
        // THE ordering rule. `needs_photos` populates `error` with the reason
        // the shots were rejected; a failure check running first would call a
        // working abstention a broken grade.
        val phase = GradeRequestMachine.classify(
            status("needs_photos", error = "The tag photo is too blurry to read."),
        )
        assertTrue(phase is GradeRequestMachine.Phase.NeedsPhotos)
        assertEquals(
            "The tag photo is too blurry to read.",
            (phase as GradeRequestMachine.Phase.NeedsPhotos).message,
        )
    }

    @Test
    fun `needs_photos with no reason still says something useful`() {
        val phase = GradeRequestMachine.classify(status("needs_photos", error = "  "))
        assertEquals(
            GradeRequestMachine.NEEDS_PHOTOS_FALLBACK,
            (phase as GradeRequestMachine.Phase.NeedsPhotos).message,
        )
    }

    @Test
    fun `an error on a non-terminal status is still a failure`() {
        val phase = GradeRequestMachine.classify(status("processing", error = "pipeline crashed"))
        assertTrue(phase is GradeRequestMachine.Phase.Failed)
        assertEquals("pipeline crashed", (phase as GradeRequestMachine.Phase.Failed).message)
    }

    @Test
    fun `an in-flight status keeps polling`() {
        assertNull(GradeRequestMachine.classify(status("pending")))
        assertNull(GradeRequestMachine.classify(status("processing")))
    }

    // ── the lost-connection streak ───────────────────────────────────────

    @Test
    fun `a decode failure does not count as a lost connection`() {
        // The server answered; the payload was mid-write. Counting this is how
        // iOS announced "Lost connection" for a grade that had landed and been
        // charged for.
        assertFalse(
            GradeRequestMachine.countsAsConnectionFailure(
                EdgeApiError.Decoding("overall_score was null"),
            ),
        )
    }

    @Test
    fun `real transport failures do count`() {
        assertTrue(
            GradeRequestMachine.countsAsConnectionFailure(EdgeApiError.Network("timed out")),
        )
        assertTrue(
            GradeRequestMachine.countsAsConnectionFailure(EdgeApiError.ServerError("502")),
        )
        assertTrue(GradeRequestMachine.countsAsConnectionFailure(IllegalStateException("boom")))
    }

    // ── submit outcomes ──────────────────────────────────────────────────

    @Test
    fun `a successful submit yields the bridge id to poll on`() {
        val outcome = GradeRequestMachine.outcomeFor(
            GradingSubmitResponse(
                submitted = 1,
                results = listOf(
                    GradingSubmitResult(
                        ok = true,
                        inventoryItemId = "i1",
                        submissionId = "s1",
                        flipdeskGradingSubmissionId = "bridge-1",
                    ),
                ),
            ),
        )
        assertEquals(
            "bridge-1",
            (outcome as GradeRequestMachine.SubmitOutcome.Poll).submissionRef,
        )
    }

    @Test
    fun `submitted with no poll ref is a soft landing, never a failure`() {
        // The seller HAS been charged at this point. Reporting a failure would
        // be both wrong and expensive.
        val outcome = GradeRequestMachine.outcomeFor(
            GradingSubmitResponse(
                submitted = 1,
                results = listOf(GradingSubmitResult(ok = true, inventoryItemId = "i1")),
            ),
        )
        assertEquals(GradeRequestMachine.SubmitOutcome.NoPollRef, outcome)
    }

    @Test
    fun `a blank poll ref is treated as absent`() {
        val outcome = GradeRequestMachine.outcomeFor(
            GradingSubmitResponse(
                results = listOf(
                    GradingSubmitResult(ok = true, flipdeskGradingSubmissionId = "   "),
                ),
            ),
        )
        assertEquals(GradeRequestMachine.SubmitOutcome.NoPollRef, outcome)
    }

    @Test
    fun `a rejected item reports the server reason`() {
        val outcome = GradeRequestMachine.outcomeFor(
            GradingSubmitResponse(
                failed = 1,
                results = listOf(
                    GradingSubmitResult(ok = false, error = "Item is missing a back photo"),
                ),
            ),
        )
        assertEquals(
            "Item is missing a back photo",
            (outcome as GradeRequestMachine.SubmitOutcome.Failed).message,
        )
    }

    @Test
    fun `an empty results array is a failure, not a silent success`() {
        val outcome = GradeRequestMachine.outcomeFor(GradingSubmitResponse())
        assertEquals(
            GradeRequestMachine.NOT_STARTED,
            (outcome as GradeRequestMachine.SubmitOutcome.Failed).message,
        )
    }

    // ── submit gating ────────────────────────────────────────────────────

    private fun validation(ready: Boolean, limitExceeded: Boolean) = GradingValidateResponse(
        items = listOf(GradingValidatedItem(inventoryItemId = "i1", ready = ready)),
        limitExceeded = limitExceeded,
        creditsRequired = 3,
    )

    @Test
    fun `submit needs both readiness and affordability`() {
        assertTrue(GradeRequestMachine.canSubmit(validation(ready = true, limitExceeded = false)))
        assertFalse(GradeRequestMachine.canSubmit(validation(ready = false, limitExceeded = false)))
        assertFalse(GradeRequestMachine.canSubmit(validation(ready = true, limitExceeded = true)))
        assertFalse(GradeRequestMachine.canSubmit(null))
    }

    @Test
    fun `blocked-on-credits is only claimed when the item is otherwise ready`() {
        // Otherwise an item missing photos would be offered a credit top-up
        // that fixes nothing.
        assertTrue(
            GradeRequestMachine.isBlockedOnCredits(validation(ready = true, limitExceeded = true)),
        )
        assertFalse(
            GradeRequestMachine.isBlockedOnCredits(validation(ready = false, limitExceeded = true)),
        )
    }

    // ── poll window ──────────────────────────────────────────────────────

    @Test
    fun `the documented poll window is the one the backoff actually produces`() {
        // 1,2,4 then 8s forever = 159s for 22 polls. Pinned exactly, because
        // the number in the comment is the only thing anyone reads before
        // changing MAX_POLLS — and on iOS that number is wrong ("≈ 2 min").
        val total = (0 until GradeRequestMachine.MAX_POLLS).sumOf { attempt ->
            com.gradethread.app.platform.net.Backoff.delayMillis(attempt, 1_000, 8_000)
        }
        assertEquals(GradeRequestMachine.POLL_WINDOW_MILLIS, total)
    }
}
