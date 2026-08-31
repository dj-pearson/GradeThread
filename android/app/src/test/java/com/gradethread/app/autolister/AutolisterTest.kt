package com.gradethread.app.autolister

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1359: how the client reads a batch it doesn't own.
 *
 * Generation is a durable server job. The two things worth pinning are the
 * states people get wrong: a batch that finished WITH failures is not "done",
 * and a batch whose worker died looks exactly like a slow one until someone
 * checks the clock.
 */
class AutolisterTest {

    private fun batch(status: BatchStatus, items: Int = 20, ok: Int = 0, failed: Int = 0, error: String? = null) =
        AutolisterBatch(
            id = "b1",
            status = status,
            itemCount = items,
            succeededCount = ok,
            failedCount = failed,
            error = error,
        )

    // ── terminal states ──────────────────────────────────────────────────────

    @Test
    fun `polling stops only on a terminal status`() {
        assertTrue(Autolister.shouldPoll(batch(BatchStatus.PENDING)))
        assertTrue(Autolister.shouldPoll(batch(BatchStatus.RUNNING)))
        assertFalse(Autolister.shouldPoll(batch(BatchStatus.COMPLETED)))
        assertFalse(Autolister.shouldPoll(batch(BatchStatus.PARTIAL)))
        assertFalse(Autolister.shouldPoll(batch(BatchStatus.FAILED)))
        assertFalse(Autolister.shouldPoll(null))
    }

    @Test
    fun `progress counts failures as finished`() {
        // 18 done + 2 failed is 20 of 20. Counting only successes leaves the
        // seller watching a bar for two jobs that already stopped.
        val b = batch(BatchStatus.PARTIAL, items = 20, ok = 18, failed = 2)
        assertEquals(20, Autolister.done(b))
        assertEquals(1f, Autolister.progressFraction(b), 1e-6f)
    }

    @Test
    fun `an empty batch has no progress rather than a divide by zero`() {
        assertEquals(0f, Autolister.progressFraction(batch(BatchStatus.PENDING, items = 0)), 1e-6f)
    }

    @Test
    fun `a partial batch is not reported as done`() {
        // US-2976: the resource and its two numbers. "Finished with 2 failures"
        // is a DIFFERENT resource from "Done", which is the distinction this
        // test exists for - and the failure count comes first, because a
        // summary that reads "Finished with 18 failures" is worse than none.
        val summary = Autolister.summary(batch(BatchStatus.PARTIAL, items = 20, ok = 18, failed = 2))
        assertEquals(R.plurals.autolister_partial, summary.res)
        assertEquals(listOf<Any>(2, 18), summary.args)
        assertEquals(2, summary.quantity)
    }

    @Test
    fun `one failure picks the singular form`() {
        val summary = Autolister.summary(batch(BatchStatus.PARTIAL, ok = 19, failed = 1))
        assertEquals(R.plurals.autolister_partial, summary.res)
        assertEquals(1, summary.quantity)
    }

    @Test
    fun `a failed batch surfaces the server's reason when it has one`() {
        val withReason = Autolister.summary(batch(BatchStatus.FAILED, error = "quota exhausted"))
        assertEquals(R.string.autolister_failed_reason, withReason.res)
        assertEquals(listOf<Any>("quota exhausted"), withReason.args)

        // No reason is not a blank reason: a shorter sentence, not a colon
        // with nothing after it.
        assertEquals(R.string.autolister_failed, Autolister.summary(batch(BatchStatus.FAILED)).res)
        assertEquals(
            R.string.autolister_failed,
            Autolister.summary(batch(BatchStatus.FAILED, error = "  ")).res,
        )
    }

    @Test
    fun `retry is offered only when something failed and the batch has stopped`() {
        assertTrue(Autolister.canRetryFailed(batch(BatchStatus.PARTIAL, failed = 2)))
        assertFalse(Autolister.canRetryFailed(batch(BatchStatus.COMPLETED, ok = 20)))
        // Still running: the failures might yet be retried by the server itself.
        assertFalse(Autolister.canRetryFailed(batch(BatchStatus.RUNNING, failed = 1)))
    }

    // ── stalls ───────────────────────────────────────────────────────────────

    @Test
    fun `an open batch that stops moving is called stalled`() {
        val now = 1_000_000L
        val running = batch(BatchStatus.RUNNING, ok = 5)
        assertTrue(Autolister.isStalled(running, now - Autolister.STALL_AFTER_MS, now))
        assertFalse(Autolister.isStalled(running, now - 1_000, now))
    }

    @Test
    fun `a finished batch is never stalled`() {
        // It stopped moving because it's done, which is not a problem to report.
        val now = 1_000_000L
        val done = batch(BatchStatus.COMPLETED, ok = 20)
        assertFalse(Autolister.isStalled(done, now - Autolister.STALL_AFTER_MS * 10, now))
    }

    @Test
    fun `only failed jobs are actionable`() {
        val jobs = listOf(
            AutolisterJob(id = "j1", status = JobStatus.SUCCESS),
            AutolisterJob(id = "j2", status = JobStatus.FAILED, error = "no photos"),
            AutolisterJob(id = "j3", status = JobStatus.RUNNING),
        )
        assertEquals(listOf("j2"), Autolister.failedJobs(jobs).map { it.id })
    }

    // ── photo QA ─────────────────────────────────────────────────────────────

    @Test
    fun `a QA error is not reported as a bad score`() {
        // -1 is the server's "couldn't check" marker. Showing it as a zero would
        // tell a seller their photos are terrible when we simply don't know.
        val errored = PhotoQaResult(itemId = "i1", score = -1, error = "vision timeout")
        assertEquals(Autolister.QaBand.UNKNOWN, Autolister.band(errored))

        val summary = Autolister.qaSummary(errored)
        assertEquals(Autolister.QaBand.UNKNOWN, summary.band)
        assertEquals(R.string.autolister_qa_unchecked_reason, summary.detail.res)
        assertEquals(listOf<Any>("vision timeout"), summary.detail.args)
        // US-2976: and the score is NULL, not -1. A screen that renders a
        // number here prints "-1/100", which is the exact reading this whole
        // branch exists to prevent.
        assertNull(summary.score)
    }

    @Test
    fun `scores band the way the copy claims`() {
        assertEquals(Autolister.QaBand.GREEN, Autolister.band(PhotoQaResult(score = 85)))
        assertEquals(Autolister.QaBand.AMBER, Autolister.band(PhotoQaResult(score = 60)))
        assertEquals(Autolister.QaBand.RED, Autolister.band(PhotoQaResult(score = 20)))
    }

    @Test
    fun `only error-severity issues block`() {
        val result = PhotoQaResult(
            itemId = "i1",
            score = 70,
            issues = listOf(
                PhotoQaIssue(type = "blurry", severity = "error", message = "Cover is blurry"),
                PhotoQaIssue(type = "lighting", severity = "warning", message = "A bit dark"),
            ),
        )
        assertEquals(1, Autolister.blockingIssues(result).size)

        // Two issues in the line, one of them blocking: the summary counts
        // every issue, and only the blocking ones hold a listing back.
        val summary = Autolister.qaSummary(result)
        assertEquals(R.plurals.autolister_qa_issues, summary.detail.res)
        assertEquals(2, summary.detail.quantity)
        assertEquals(70, summary.score)

        // No issues is its own resource rather than a "0 issues" plural.
        assertEquals(
            R.string.autolister_qa_no_issues,
            Autolister.qaSummary(PhotoQaResult(itemId = "i2", score = 90)).detail.res,
        )
    }

    @Test
    fun `items worth a reshoot are the ones surfaced`() {
        val results = listOf(
            PhotoQaResult(itemId = "good", score = 90),
            PhotoQaResult(itemId = "meh", score = 55),
            PhotoQaResult(itemId = "bad", score = 10),
            // An unknown is NOT pushed at the seller as a problem — we don't
            // know that it is one.
            PhotoQaResult(itemId = "unknown", score = -1, error = "timeout"),
        )
        assertEquals(listOf("meh", "bad"), Autolister.needsAttention(results).map { it.itemId })
    }

    // ── classification ───────────────────────────────────────────────────────

    @Test
    fun `an unclassified photo keeps whatever role it had`() {
        // A missing key means the model didn't say. Defaulting it to "detail"
        // would silently relabel a photo the seller had already set.
        val response = ClassifyPhotosResponse(coverId = "p1", roles = mapOf("p1" to "front"))
        assertEquals("front", Autolister.role(response, "p1"))
        assertNull(Autolister.role(response, "p2"))
        assertTrue(Autolister.isCover(response, "p1"))
        assertFalse(Autolister.isCover(response, "p2"))
    }
}
