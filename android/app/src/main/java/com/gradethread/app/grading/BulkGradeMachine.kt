package com.gradethread.app.grading

/**
 * US-1339: bulk certified grading — the decisions, pure.
 *
 * The single-item flow and this one look similar and gate DIFFERENTLY, which is
 * the whole point of the story: a batch submits its ready items and reports the
 * rest, instead of refusing wholesale because one item is missing a photo.
 */
object BulkGradeMachine {

    sealed class Phase {
        object Loading : Phase()
        object Ready : Phase()
        object Submitting : Phase()
        data class Done(val summary: Summary) : Phase()
        data class Failed(val message: String) : Phase()

        /**
         * Terminal and NOT retryable — an empty selection can never validate,
         * so offering "Try again" would just re-fail forever (iOS US-1184).
         */
        data class Empty(val message: String) : Phase()
    }

    const val NOTHING_SELECTED =
        "No items selected. Close this and pick at least one item to grade."

    fun readyItems(validation: GradingValidateResponse?): List<GradingValidatedItem> =
        validation?.items.orEmpty().filter { it.ready }

    fun blockedItems(validation: GradingValidateResponse?): List<GradingValidatedItem> =
        validation?.items.orEmpty().filter { !it.ready }

    /**
     * Can the batch be submitted?
     *
     * Deliberately NOT the server's all-or-nothing `can_submit`, which requires
     * EVERY item to be ready. Here one un-photographed item must not hold up
     * the other nineteen — so the gate is "at least one ready item, and the
     * credits cover them". The server still charges and validates per item; we
     * simply stop sending it the ones we already know it will reject.
     */
    fun canSubmit(validation: GradingValidateResponse?, submitting: Boolean): Boolean {
        if (submitting) return false
        val validated = validation ?: return false
        return readyItems(validated).isNotEmpty() && !validated.limitExceeded
    }

    /** What the seller is told after a batch lands. */
    data class Summary(
        val submitted: Int,
        val failedAtSubmit: Int,
        val blockedBeforeSubmit: Int,
    ) {
        /** Items we never sent, plus items the server rejected. */
        val notGraded: Int get() = failedAtSubmit + blockedBeforeSubmit

        val headline: String
            get() = when {
                submitted == 0 -> "Nothing was submitted"
                notGraded == 0 -> "$submitted ${plural(submitted)} submitted"
                else -> "$submitted submitted, $notGraded blocked"
            }

        /**
         * The detail line exists because "blocked" covers two different
         * situations and the seller's next action differs: items we withheld
         * (fix them and retry) versus items the server refused (usually
         * credits or a race).
         */
        val detail: String?
            get() = buildList {
                if (blockedBeforeSubmit > 0) {
                    add("$blockedBeforeSubmit not ready — fix the blockers and try again")
                }
                if (failedAtSubmit > 0) add("$failedAtSubmit rejected at submit")
            }.ifEmpty { null }?.joinToString(" · ")

        private fun plural(n: Int) = if (n == 1) "item" else "items"
    }

    fun summarize(
        response: GradingSubmitResponse,
        blockedBeforeSubmit: Int,
    ): Summary = Summary(
        submitted = response.submitted,
        failedAtSubmit = response.failed,
        blockedBeforeSubmit = blockedBeforeSubmit,
    )
}
