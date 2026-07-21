package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApiError

/**
 * US-1336: every decision the certified-grade flow makes, as pure functions.
 *
 * The poll loop is where this flow gets subtle — four of its states look alike
 * from the outside and mean very different things to a seller who may have just
 * been charged. Keeping the classification here means each one is provable
 * without a network, a clock, or a two-minute wait.
 */
object GradeRequestMachine {

    /**
     * The poll window. The standard SLA is hours, but the AI pipeline usually
     * finishes in seconds, so we poll for the common fast path and let sync
     * deliver the slow one.
     *
     * With [com.gradethread.app.platform.net.Backoff] at base 1s / cap 8s the
     * delays run 1,2,4,8,8,… so 22 polls is 1+2+4+8·19 = **159s, i.e. ~2m40s**.
     *
     * The count matches iOS (US-1409, which cut it from 40) and the behaviour
     * is deliberately identical — but iOS's comment calls this "≈ 2 min", which
     * is simply the wrong sum. The number is stated correctly here and pinned
     * by a test, so the next person to tune it starts from the real figure
     * rather than a stale claim.
     */
    const val MAX_POLLS = 22

    /** What [MAX_POLLS] actually costs in wall-clock sleep. */
    const val POLL_WINDOW_MILLIS = 159_000L

    /**
     * Consecutive unreachable polls before we stop calling it "processing".
     * Below this a blip is absorbed; at it, the seller is told the truth.
     */
    const val MAX_CONSECUTIVE_FAILURES = 4

    const val NEEDS_PHOTOS_FALLBACK =
        "We couldn't grade this item from the current photos. Retake the flagged " +
            "shots — especially the tag — in brighter, sharper focus and try again."

    const val LOST_CONNECTION =
        "Lost connection while checking your grade. Your photos are saved — " +
            "reopen this item to check the result."

    const val NOT_STARTED = "Grading didn't start. Please try again."

    sealed class Phase {
        /** Initial readiness/plan check in flight. */
        object Loading : Phase()

        /** Validation came back — readiness, tier picker, submit. */
        object Ready : Phase()

        object Submitting : Phase()

        /** Submitted; polling the bridge. */
        object Processing : Phase()

        data class Completed(val report: GradeReportDto, val certificateUrl: String?) : Phase()

        /**
         * The AI produced a grade but confidence was below the review floor, so
         * it is withheld until a human finalizes it. NOT completed and NOT
         * failed — the provisional score is shown, no certificate is resolved,
         * and the item is not stamped as graded.
         */
        data class PendingReview(val report: GradeReportDto?) : Phase()

        /**
         * The poll window elapsed with no terminal state. Deliberately not an
         * error: the grade is still coming and will arrive via the next sync.
         */
        object StillProcessing : Phase()

        /**
         * Quality abstention — a core photo is unusable, so the AI declined to
         * grade. Terminal, actionable, and NOT a charge.
         */
        data class NeedsPhotos(val message: String) : Phase()

        data class Failed(val message: String) : Phase()

        val isTerminal: Boolean
            get() = this is Completed || this is PendingReview || this is StillProcessing ||
                this is NeedsPhotos || this is Failed
    }

    /**
     * Classify one status payload. `null` means "not terminal — keep polling".
     *
     * ORDER IS LOAD-BEARING. `needs_photos` sets `error` too (the reason the
     * photos were rejected), so a failure check that ran first would report a
     * hard failure for what is really an actionable retake — and the seller
     * would be told grading broke when it worked exactly as designed.
     */
    fun classify(status: GradingStatusResponse): Phase? = when {
        status.status == "completed" && status.gradeReport != null ->
            Phase.Completed(status.gradeReport, status.item.certificateUrl)

        status.status == "pending_review" -> Phase.PendingReview(status.gradeReport)

        status.status == "needs_photos" ->
            Phase.NeedsPhotos(status.error?.takeIf { it.isNotBlank() } ?: NEEDS_PHOTOS_FALLBACK)

        status.status == "failed" || !status.error.isNullOrBlank() ->
            Phase.Failed(
                status.error?.takeIf { it.isNotBlank() }
                    ?: "Grading failed. You weren't charged — please retake the photos and try again.",
            )

        // Includes `completed` with no report yet: the bridge row flipped
        // before the report row was written. Polling once more costs a second
        // and gets the real thing; treating it as done would show an empty
        // grade card.
        else -> null
    }

    /**
     * Does a poll error mean the server is unreachable?
     *
     * A DECODE failure specifically does NOT count. It means the server
     * answered but the payload didn't parse — typically a report mid-write,
     * with a score column still null. iOS shipped this counting toward the
     * streak, so a grade that had actually landed (and been charged for) was
     * announced as "Lost connection" after four polls.
     */
    fun countsAsConnectionFailure(error: Throwable): Boolean = error !is EdgeApiError.Decoding

    /** What a submit response means: a poll ref, a soft landing, or a failure. */
    sealed class SubmitOutcome {
        data class Poll(val submissionRef: String) : SubmitOutcome()

        /**
         * Submitted, but with no id to poll on. The grade is still coming via
         * sync, so this is the soft terminal state rather than an error — the
         * seller HAS been charged and must not be told it failed.
         */
        object NoPollRef : SubmitOutcome()

        data class Failed(val message: String) : SubmitOutcome()
    }

    fun outcomeFor(response: GradingSubmitResponse): SubmitOutcome {
        val result = response.results.firstOrNull()
            ?: return SubmitOutcome.Failed(NOT_STARTED)
        if (!result.ok) {
            return SubmitOutcome.Failed(
                result.error?.takeIf { it.isNotBlank() }
                    ?: "Grading couldn't start for this item.",
            )
        }
        val ref = result.flipdeskGradingSubmissionId?.takeIf { it.isNotBlank() }
            ?: return SubmitOutcome.NoPollRef
        return SubmitOutcome.Poll(ref)
    }

    /**
     * Can this validation be submitted?
     *
     * Mirrors the server's own `can_submit` rather than re-deriving it, but
     * still checks readiness and the credit wall separately so the UI can say
     * WHICH of the two is blocking.
     */
    fun canSubmit(validation: GradingValidateResponse?): Boolean {
        val item = validation?.item ?: return false
        return item.ready && !validation.limitExceeded
    }

    /** True when the only thing standing in the way is the credit balance. */
    fun isBlockedOnCredits(validation: GradingValidateResponse?): Boolean {
        val item = validation?.item ?: return false
        return item.ready && validation.limitExceeded
    }
}
