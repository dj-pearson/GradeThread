package com.gradethread.app.grading

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * US-2815: the consumer grade journey as a state machine.
 *
 * submit -> pay -> poll -> result, with two states that must say the MONEY part
 * first. The walk-around screen learned that lesson first and its comment says
 * why: "we couldn't grade it" reads like a wasted purchase until you know it
 * was not one. An abstain and a credits prompt are both no-charge states, and
 * both are commonly mistaken for failures.
 *
 * A STATE MACHINE RATHER THAN A SCREEN WITH FLAGS, because the flow has a real
 * order and two of its steps bounce back: paying can send you to buy credits and
 * return, and an abstain sends you back to the camera. Booleans for
 * isSubmitting / isPaying / isPolling make those legal transitions look like
 * edge cases.
 *
 * Every collaborator is a function parameter with a real default. That is what
 * lets the whole journey — including the credits detour and the poll timeout —
 * be tested without a network, a clock, or a store.
 */
class ConsumerGradeFlow(
    private val submit: suspend (List<PhotoGradeImage>, PhotoGradeRequest, (Double) -> Unit) -> PhotoSubmitResponse,
    private val pay: suspend (String) -> PhotoGradePayment.Outcome,
    private val status: suspend (String) -> PhotoGradeStatus,
    private val sleep: suspend (Long) -> Unit,
) {

    sealed class Step {
        object Ready : Step()

        /** Bytes moving. [fraction] is the upload only. */
        data class Uploading(val fraction: Double) : Step()

        /** Uploaded; charging against included grades or credits. */
        data class Paying(val submissionId: String) : Step()

        /**
         * Neither covered it. NOT an error — an offer, and the pack is the one
         * the route named.
         */
        data class NeedsCredits(
            val submissionId: String,
            val offer: PhotoGradePayment.PackOffer?,
        ) : Step()

        /**
         * The purchase went through and the server has not credited the account
         * YET.
         *
         * ⚠ THIS STATE IS THE WHOLE POINT OF THE TOP-UP DETOUR. A store purchase
         * completing on the device does not mean the balance has moved: the
         * grant arrives through the server, and there is a gap. Paying again
         * during that gap returns "out of credits" a SECOND time — the same wall
         * the customer just paid to clear.
         */
        data class AwaitingCredits(val submissionId: String) : Step()

        /**
         * The grant did not appear inside the poll window. NOT a failure and NOT
         * a refusal: it may still land, so the user gets "check again" rather
         * than an error.
         */
        data class CreditsDelayed(val submissionId: String) : Step()

        /**
         * Paid, grading. The server sends nothing until it is done, so the UI
         * must render this indeterminately rather than invent a number.
         */
        data class Grading(val submissionId: String, val statusText: String) : Step()

        /** The gate abstained. Nothing was charged. */
        data class NeedsPhotos(
            val submissionId: String,
            val messages: List<String>,
            val slots: List<String>,
        ) : Step()

        data class Graded(val submissionId: String) : Step()

        data class Failed(val message: String) : Step()
    }

    private val stepFlow = MutableStateFlow<Step>(Step.Ready)
    val step: StateFlow<Step> = stepFlow.asStateFlow()

    suspend fun start(images: List<PhotoGradeImage>, request: PhotoGradeRequest) {
        // Refuse here rather than after the upload: the route's abstain costs a
        // charge and a vision call per image before the refund.
        PhotoGradeUploader.validate(images)?.let {
            stepFlow.value = Step.Failed(it.message)
            return
        }

        stepFlow.value = Step.Uploading(0.0)
        val submissionId = try {
            val response = submit(images, request) { fraction ->
                stepFlow.value = Step.Uploading(fraction)
            }
            response.submissionId
        } catch (error: Throwable) {
            stepFlow.value = Step.Failed(message(error))
            return
        }

        if (submissionId.isNullOrEmpty()) {
            stepFlow.value = Step.Failed("That upload did not complete. Try again.")
            return
        }
        charge(submissionId)
    }

    /** After the top-up sheet reports a grant. */
    suspend fun creditsPurchased(submissionId: String) {
        stepFlow.value = Step.AwaitingCredits(submissionId)
        charge(submissionId)
    }

    /** The "check again" affordance behind [Step.CreditsDelayed]. */
    suspend fun recheckCredits(submissionId: String) = charge(submissionId)

    private suspend fun charge(submissionId: String) {
        stepFlow.value = Step.Paying(submissionId)
        val outcome = try {
            pay(submissionId)
        } catch (error: Throwable) {
            stepFlow.value = Step.Failed(message(error))
            return
        }
        when (outcome) {
            is PhotoGradePayment.Outcome.NeedsCredits ->
                stepFlow.value = Step.NeedsCredits(submissionId, outcome.offer)
            else -> poll(submissionId)
        }
    }

    private suspend fun poll(submissionId: String) {
        stepFlow.value = Step.Grading(submissionId, "")
        for (attempt in 0 until MAX_POLLS) {
            val current = try {
                status(submissionId)
            } catch (error: Throwable) {
                stepFlow.value = Step.Failed(message(error))
                return
            }
            if (current.isTerminal) {
                stepFlow.value = terminalStep(current, submissionId)
                return
            }
            stepFlow.value = Step.Grading(
                submissionId,
                PhotoGradeStatus.terminalMessage(current.status),
            )
            if (attempt < MAX_POLLS - 1) sleep(POLL_DELAY_MS)
        }
        // Ran out of polls. NOT a failure: the grade is still running and the
        // certificate will exist. Saying "failed" here would be a lie that
        // invites a second charge.
        stepFlow.value = Step.Grading(submissionId, "Still grading. This one is taking a while.")
    }

    private fun terminalStep(status: PhotoGradeStatus, submissionId: String): Step =
        when (status.status) {
            "completed" -> Step.Graded(submissionId)
            "needs_photos" -> Step.NeedsPhotos(
                submissionId,
                // The gate's own wording. Re-deriving copy from `issues` would
                // be building worse sentences out of better data.
                status.qualityFeedback?.photoRequests
                    ?: listOfNotNull(status.qualityFeedback?.summary),
                status.qualityFeedback?.photoSlots ?: emptyList(),
            )
            else -> Step.Failed(PhotoGradeStatus.terminalMessage(status.status))
        }

    private fun message(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: "Something went wrong. Try again."

    companion object {
        /** ~2 minutes at 4s, which covers a normal grade with room to spare. */
        const val MAX_POLLS = 30
        const val POLL_DELAY_MS = 4_000L
    }
}
