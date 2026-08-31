package com.gradethread.app.autolister

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

/**
 * US-1359: how the client reads a batch it doesn't own.
 *
 * Generation runs server-side on a durable job queue. Everything here is about
 * reporting that honestly — including the two states people get wrong: a batch
 * that finished with failures is NOT "done", and a batch whose worker died
 * looks exactly like a slow one until you look at the clock.
 */
object Autolister {

    /** The server's own ceiling on one batch. */
    const val MAX_BATCH_ITEMS = 100

    /** Poll cadence while a batch is open. */
    const val POLL_INTERVAL_MS = 3_000L

    /**
     * How long a batch can sit with no progress before we say so.
     *
     * Not a failure — the reclaim sweeper picks up dead workers on its own
     * schedule. But a spinner that never resolves teaches sellers the feature is
     * broken, so past this we name it and offer Resume.
     */
    const val STALL_AFTER_MS = 120_000L

    /** Whether polling should continue. */
    fun shouldPoll(batch: AutolisterBatch?): Boolean = batch != null && !batch.status.isTerminal

    /**
     * Progress as done-out-of-total.
     *
     * Counts both outcomes: a batch of 20 with 18 successes and 2 failures is
     * finished, and showing 18/20 would leave a seller waiting for two jobs that
     * already stopped.
     */
    fun done(batch: AutolisterBatch): Int = batch.succeededCount + batch.failedCount

    fun progressFraction(batch: AutolisterBatch): Float =
        if (batch.itemCount <= 0) 0f else (done(batch).toFloat() / batch.itemCount).coerceIn(0f, 1f)

    /**
     * One line for the batch.
     *
     * "Finished with 2 failures" rather than "completed", because the failures
     * are the part that still needs the seller.
     */
    fun summary(batch: AutolisterBatch): UiMessage = when (batch.status) {
        BatchStatus.PENDING ->
            UiMessage(R.string.autolister_queued, args = listOf(batch.itemCount))

        BatchStatus.RUNNING -> UiMessage(
            R.string.autolister_generating,
            args = listOf(done(batch), batch.itemCount),
        )

        BatchStatus.COMPLETED ->
            UiMessage(R.string.autolister_done, args = listOf(batch.succeededCount))

        // US-2976: "failure" versus "failures" was an `if (count == 1)` written
        // in English. A plurals resource is the only form that survives a
        // language with more than two.
        BatchStatus.PARTIAL -> UiMessage(
            R.plurals.autolister_partial,
            args = listOf(batch.failedCount, batch.succeededCount),
            quantity = batch.failedCount,
        )

        BatchStatus.FAILED -> batch.error?.takeIf { it.isNotBlank() }
            ?.let { UiMessage(R.string.autolister_failed_reason, args = listOf(it)) }
            ?: UiMessage(R.string.autolister_failed)
    }

    /** Retry is worth offering only when something actually failed. */
    fun canRetryFailed(batch: AutolisterBatch): Boolean = batch.failedCount > 0 && batch.status.isTerminal

    /**
     * A batch that looks stuck.
     *
     * Open, and untouched for longer than [STALL_AFTER_MS]. This is the failure
     * mode a progress bar hides: the worker died, the row stopped moving, and
     * nothing on screen says so.
     */
    fun isStalled(batch: AutolisterBatch, lastProgressMs: Long, nowMs: Long): Boolean =
        !batch.status.isTerminal && nowMs - lastProgressMs >= STALL_AFTER_MS

    @StringRes
    val STALL_MESSAGE: Int = R.string.autolister_stalled

    /** Failed jobs, which are the only ones a seller can act on. */
    fun failedJobs(jobs: List<AutolisterJob>): List<AutolisterJob> = jobs.filter { it.status == JobStatus.FAILED }

    // ── photo QA ─────────────────────────────────────────────────────────────

    /** How a QA score reads. */
    enum class QaBand(@StringRes val label: Int) {
        /** Good enough to list. */
        GREEN(R.string.autolister_qa_ready),

        /** Listable, but the issues are worth fixing. */
        AMBER(R.string.autolister_qa_worth_reshoot),

        /** Would make a poor listing. */
        RED(R.string.autolister_qa_reshoot_first),

        /** QA itself failed — NOT the same as a bad photo. */
        UNKNOWN(R.string.autolister_qa_unknown),
    }

    fun band(result: PhotoQaResult): QaBand = when {
        // -1 is the server's "this errored" marker. Reporting it as a zero
        // score would tell a seller their photos are terrible when we simply
        // don't know.
        result.score < 0 || result.error != null -> QaBand.UNKNOWN
        result.score >= 80 -> QaBand.GREEN
        result.score >= 50 -> QaBand.AMBER
        else -> QaBand.RED
    }

    /** Issues serious enough to hold a listing back. */
    fun blockingIssues(result: PhotoQaResult): List<PhotoQaIssue> =
        result.issues.filter { it.severity.equals("error", ignoreCase = true) }

    /**
     * The QA line: the band, the score, and how many issues.
     *
     * US-2976: the tail clause ("no issues" / "2 issues") is its own message,
     * because it is a plural in the middle of a sentence and the two cannot be
     * one resource. The screen resolves both and joins with
     * R.string.autolister_qa_score.
     */
    fun qaSummary(result: PhotoQaResult): QaSummary {
        val band = band(result)
        if (band == QaBand.UNKNOWN) {
            return QaSummary(
                band,
                result.error?.takeIf { it.isNotBlank() }
                    ?.let { UiMessage(R.string.autolister_qa_unchecked_reason, args = listOf(it)) }
                    ?: UiMessage(R.string.autolister_qa_unchecked),
            )
        }
        val issues = result.issues.size
        return QaSummary(
            band,
            if (issues == 0) {
                UiMessage(R.string.autolister_qa_no_issues)
            } else {
                UiMessage(
                    R.plurals.autolister_qa_issues,
                    args = listOf(issues),
                    quantity = issues,
                )
            },
            score = result.score,
        )
    }

    /**
     * A QA read.
     *
     * [score] is null when the check itself failed, which is the one case the
     * screen must not render as a number - a -1 shown as a score reads as
     * "your photos are terrible" rather than "we could not tell".
     */
    data class QaSummary(val band: QaBand, val detail: UiMessage, val score: Int? = null)

    /** Items a seller should look at before spending generation quota on them. */
    fun needsAttention(results: List<PhotoQaResult>): List<PhotoQaResult> =
        results.filter { band(it) == QaBand.RED || band(it) == QaBand.AMBER }

    // ── classification ───────────────────────────────────────────────────────

    /**
     * The role for one photo, or null when the model didn't say.
     *
     * Null is left alone rather than defaulted: an unclassified photo keeping
     * whatever role it already had beats one silently relabelled "detail".
     */
    fun role(response: ClassifyPhotosResponse, photoId: String): String? =
        response.roles[photoId]?.takeIf { it.isNotBlank() }

    fun isCover(response: ClassifyPhotosResponse, photoId: String): Boolean = response.coverId == photoId
}
