package com.gradethread.app.grading

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1337: the five weighted condition factors that compose an overall grade.
 *
 * Weights mirror `GRADE_FACTORS` in the web constants and the grading spec:
 * Fabric 30 / Structural 25 / Cosmetic 20 / Functional 15 / Odor 10. They are
 * used for DISPLAY only — the server computes the overall score. If these ever
 * disagree with the server, the bars would explain a number that wasn't
 * arrived at this way, so the sum is pinned by a test.
 *
 * US-2976: [label] is a string RESOURCE. It was a literal, and the five
 * factor names are Title Case single phrases, which the localization guard's
 * sentence rule could not see - so a Spanish seller read the whole grade
 * report in Spanish except the five things it is a report ABOUT. An enum
 * cannot call stringResource, so it carries the id and the screen resolves it.
 */
enum class GradeFactor(@StringRes val label: Int, val weight: Double) {
    FABRIC_CONDITION(R.string.grade_factor_fabric, 0.30),
    STRUCTURAL_INTEGRITY(R.string.grade_factor_structural, 0.25),
    COSMETIC_APPEARANCE(R.string.grade_factor_cosmetic, 0.20),
    FUNCTIONAL_ELEMENTS(R.string.grade_factor_functional, 0.15),
    ODOR_CLEANLINESS(R.string.grade_factor_odor, 0.10),
    ;

    /** This factor's 1–10 sub-score from a decoded report. */
    fun score(report: GradeReportDto): Double = when (this) {
        FABRIC_CONDITION -> report.fabricConditionScore
        STRUCTURAL_INTEGRITY -> report.structuralIntegrityScore
        COSMETIC_APPEARANCE -> report.cosmeticAppearanceScore
        FUNCTIONAL_ELEMENTS -> report.functionalElementsScore
        ODOR_CLEANLINESS -> report.odorCleanlinessScore
    }

    /** "(30%)" — the contribution suffix on each bar. */
    val weightLabel: String get() = "${Math.round(weight * 100)}%"
}

/**
 * Score and confidence presentation, shared so the report, the request sheet
 * and the inventory chip can never disagree.
 */
object GradeScale {

    /**
     * Confidence floor (inclusive) for a grade to certify automatically.
     *
     * Below this the server routes the grade to a human reviewer, so the app
     * must treat it as PROVISIONAL — not certified, not shareable — until
     * review clears. Matches the grading spec's 0.75 (US-1209); one constant
     * so the ring, the report, and the request flow agree.
     */
    const val REVIEW_CONFIDENCE_THRESHOLD: Double = 0.75

    fun requiresReview(confidence: Double): Boolean = confidence < REVIEW_CONFIDENCE_THRESHOLD

    /**
     * Is this grade still awaiting review — and therefore NOT shareable?
     *
     * US-1409: a certificate is only ever attached to a FINALIZED grade, so a
     * present certificate is the authoritative "certified" signal. Re-deriving
     * "pending" from raw confidence alone would suppress sharing on a
     * low-confidence grade a human reviewer had already APPROVED — the seller
     * would be told to wait for a review that already happened, with the
     * certificate sitting right there.
     */
    fun isPendingReview(certificateUrl: String?, confidence: Double): Boolean =
        certificateUrl.isNullOrBlank() && requiresReview(confidence)

    /**
     * Qualitative confidence bucket; "Low" is the review band.
     *
     * US-2976: found by the display-declaration rule, not by either of the
     * first two. Three Title Case single words inside a `when` - too short for
     * the sentence detector, and a function body has no constructor position
     * for the positional one.
     */
    @StringRes
    fun confidenceLabel(confidence: Double): Int = when {
        confidence > 0.85 -> R.string.grade_confidence_high
        confidence >= REVIEW_CONFIDENCE_THRESHOLD -> R.string.grade_confidence_medium
        else -> R.string.grade_confidence_low
    }
}

/** Public certificate links. */
object CertificateLink {

    const val SITE_ORIGIN = "https://gradethread.com"

    fun url(certificateId: String): String = "$SITE_ORIGIN/cert/$certificateId"

    /**
     * The best available certificate URL: a server-provided absolute URL wins,
     * otherwise one is built from the certificate id.
     *
     * The explicit value is only trusted when it actually carries a scheme —
     * a bare path stored by an older writer would otherwise be handed to the
     * share sheet as if it were a link.
     */
    fun resolve(explicit: String?, certificateId: String?): String? {
        val trimmed = explicit?.trim()
        if (!trimmed.isNullOrEmpty() && trimmed.contains("://")) return trimmed
        return certificateId?.takeIf { it.isNotBlank() }?.let(::url)
    }
}
