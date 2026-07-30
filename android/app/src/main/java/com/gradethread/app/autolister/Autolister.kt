package com.gradethread.app.autolister

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
    fun summary(batch: AutolisterBatch): String = when (batch.status) {
        BatchStatus.PENDING -> "Queued — ${batch.itemCount} items."
        BatchStatus.RUNNING -> "Generating ${done(batch)} of ${batch.itemCount}…"
        BatchStatus.COMPLETED -> "Done — ${batch.succeededCount} drafts ready."
        BatchStatus.PARTIAL ->
            "Finished with ${batch.failedCount} ${failureNoun(batch.failedCount)} — " +
                "${batch.succeededCount} drafts ready."

        BatchStatus.FAILED -> batch.error?.takeIf { it.isNotBlank() }
            ?.let { "The batch failed: $it" }
            ?: "The batch failed."
    }

    private fun failureNoun(count: Int) = if (count == 1) "failure" else "failures"

    /** Retry is worth offering only when something actually failed. */
    fun canRetryFailed(batch: AutolisterBatch): Boolean =
        batch.failedCount > 0 && batch.status.isTerminal

    /**
     * A batch that looks stuck.
     *
     * Open, and untouched for longer than [STALL_AFTER_MS]. This is the failure
     * mode a progress bar hides: the worker died, the row stopped moving, and
     * nothing on screen says so.
     */
    fun isStalled(batch: AutolisterBatch, lastProgressMs: Long, nowMs: Long): Boolean =
        !batch.status.isTerminal && nowMs - lastProgressMs >= STALL_AFTER_MS

    const val STALL_MESSAGE =
        "This batch hasn't moved in a while. It may still finish on its own — " +
            "Resume asks the server to pick the remaining items back up."

    /** Failed jobs, which are the only ones a seller can act on. */
    fun failedJobs(jobs: List<AutolisterJob>): List<AutolisterJob> =
        jobs.filter { it.status == JobStatus.FAILED }

    // ── photo QA ─────────────────────────────────────────────────────────────

    /** How a QA score reads. */
    enum class QaBand(val label: String) {
        /** Good enough to list. */
        GREEN("Ready"),

        /** Listable, but the issues are worth fixing. */
        AMBER("Worth a reshoot"),

        /** Would make a poor listing. */
        RED("Reshoot first"),

        /** QA itself failed — NOT the same as a bad photo. */
        UNKNOWN("Couldn't check"),
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

    fun qaSummary(result: PhotoQaResult): String {
        val band = band(result)
        if (band == QaBand.UNKNOWN) {
            return result.error?.takeIf { it.isNotBlank() }
                ?.let { "Couldn't check these photos: $it" }
                ?: "Couldn't check these photos."
        }
        val issues = result.issues.size
        val tail = if (issues == 0) "no issues" else "$issues ${if (issues == 1) "issue" else "issues"}"
        return "${band.label} · ${result.score}/100 · $tail"
    }

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

    fun isCover(response: ClassifyPhotosResponse, photoId: String): Boolean =
        response.coverId == photoId
}
