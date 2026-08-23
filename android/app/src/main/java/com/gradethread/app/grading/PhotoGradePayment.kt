package com.gradethread.app.grading

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-2815: `POST /api/grade/pay/:id` — charge a submission that is already
 * uploaded.
 *
 * Three outcomes and only one is a problem, which is why this is a sealed class
 * rather than a boolean: "neither covered it" is an OFFER, and rendering it as a
 * failure is precisely the mistake the consumer flow exists to avoid.
 *
 * ⚠ THE WIRE SHAPE IS NESTED AND camelCase, and the first draft of this file got
 * it wrong in both directions — it guessed flat snake_case fields
 * (`paid_from`, `credit_balance`) by paraphrasing the iOS model instead of
 * reading the route. grade.ts nests everything under `payment` and names the
 * fields `paid`, `method`, `newIncludedUsed`, `newBalance`, `suggestedPack`.
 * Held to that by `src/test/native-photo-grade-payment-parity.test.ts`.
 */
object PhotoGradePayment {

    /** The pack the route names when nothing covers the grade. */
    @Serializable
    data class PackOffer(
        val credits: Int = 0,
        val priceCents: Int = 0,
    )

    @Serializable
    data class Payment(
        val paid: Boolean = false,
        /** "included" | "credits" when [paid]; absent otherwise. */
        val method: String? = null,
        val newIncludedUsed: Int? = null,
        val newBalance: Int? = null,
        val checkoutRequired: Boolean = false,
        val suggestedPack: PackOffer? = null,
    )

    @Serializable
    data class Response(
        @SerialName("submissionId") val submissionId: String = "",
        val status: String = "",
        val payment: Payment? = null,
    ) {
        fun outcome(): Outcome {
            val p = payment ?: return Outcome.NeedsCredits(null)
            if (!p.paid) return Outcome.NeedsCredits(p.suggestedPack)
            return when (p.method) {
                "included" -> Outcome.PaidFromIncluded(p.newIncludedUsed ?: 0)
                // `credits` and anything else it might be called: it is PAID,
                // which the route already said. Treating an unrecognised method
                // as unpaid would prompt someone to buy credits they just spent.
                else -> Outcome.PaidFromCredits(p.newBalance ?: 0)
            }
        }
    }

    sealed class Outcome {
        /** A monthly included grade covered it. [used] is the new count. */
        data class PaidFromIncluded(val used: Int) : Outcome()

        /** A credit was spent. [balance] is what is left. */
        data class PaidFromCredits(val balance: Int) : Outcome()

        /**
         * Neither covered it. NOT an error — an offer, and the pack is the one
         * the route named.
         */
        data class NeedsCredits(val offer: PackOffer?) : Outcome()
    }

    @Serializable
    data class Request(val tier: String = "standard")

    fun path(submissionId: String): String = "/api/grade/pay/$submissionId"
}

/**
 * US-2815: `GET /api/grade/status/:id`.
 *
 * The pipeline sends nothing until it is finished, so a caller polls. The
 * terminal states are the interesting part: two of the three are NOT failures
 * and must not be rendered as one.
 */
@Serializable
data class PhotoGradeStatus(
    val id: String = "",
    val status: String = "",
    @SerialName("payment_status") val paymentStatus: String? = null,
    @SerialName("quality_feedback") val qualityFeedback: QualityFeedback? = null,
) {
    /**
     * Written by the pipeline when the gate abstains (grading-pipeline.ts).
     * Null on every other status, so its PRESENCE is the signal.
     */
    @Serializable
    data class QualityFeedback(
        val summary: String? = null,
        /**
         * ALREADY de-duplicated and user-facing: the gate turns its issues into
         * asks a person can act on. Show these. Re-deriving copy from `issues`
         * would be building worse sentences out of better data.
         */
        @SerialName("photo_requests") val photoRequests: List<String>? = null,
        @SerialName("photo_slots") val photoSlots: List<String>? = null,
    )

    val isTerminal: Boolean get() = status in TERMINAL

    companion object {
        /** Nothing more will change without the user doing something. */
        val TERMINAL = setOf("completed", "needs_photos", "failed")

        fun path(submissionId: String): String = "/api/grade/status/$submissionId"

        /**
         * What a terminal status means to a person.
         *
         * `needs_photos` is the one worth getting right: NOTHING WAS CHARGED,
         * and it reads as a wasted purchase unless that is said first.
         */
        fun terminalMessage(status: String): String = when (status) {
            "completed" -> "Your grade is ready."
            "needs_photos" -> "We could not grade this set. You have not been charged."
            "failed" -> "That grade did not finish. You have not been charged."
            else -> "Still working."
        }
    }
}
