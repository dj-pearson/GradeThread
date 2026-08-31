package com.gradethread.app.grading

import androidx.annotation.StringRes
import com.gradethread.app.R

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1340: why a seller thinks a certified grade is wrong.
 *
 * The `wire` values mirror `DISPUTE_REASONS` in the web constants so a dispute
 * filed from Android reads identically in the admin queue — the reason string
 * is what a human reviewer sorts by.
 */
/**
 * US-2976: THREE fields where there were two, the same split as
 * [com.gradethread.app.feedback.Feedback.Category].
 *
 * [label] is the chip the seller taps and is a resource. [record] is what
 * [DisputeComposer.compose] puts in front of the submitted text, and stays
 * ENGLISH because a GradeThread reviewer reads it - a dispute filed in Spanish
 * would land under a reason nobody can group with the English ones.
 */
enum class DisputeReason(val wire: String, @StringRes val label: Int, val record: String) {
    GRADE_TOO_LOW(
        "grade_too_low",
        R.string.dispute_reason_grade_too_low,
        "Overall grade is too low",
    ),
    DESIGN_AS_DAMAGE(
        "design_as_damage",
        R.string.dispute_reason_design_as_damage,
        "Intentional design counted as damage",
    ),
    DEFECT_NOT_PRESENT(
        "defect_not_present",
        R.string.dispute_reason_defect_not_present,
        "A listed defect isn't actually present",
    ),
    MISSED_DETAIL(
        "missed_detail",
        R.string.dispute_reason_missed_detail,
        "An important detail or flaw was missed",
    ),
    WRONG_CATEGORY(
        "wrong_category",
        R.string.dispute_reason_wrong_category,
        "Wrong garment type or category",
    ),
    FACTOR_SCORE(
        "factor_score",
        R.string.dispute_reason_factor_score,
        "A factor score looks wrong",
    ),
    OTHER("other", R.string.dispute_reason_other, "Other (please explain)"),
}

/**
 * Composes the stored `disputes.reason` text, matching the web and iOS
 * composition exactly so one record format reaches the reviewer.
 */
object DisputeComposer {

    /** "Other" is only useful with a real explanation attached. */
    const val OTHER_MIN_LENGTH = 20

    fun compose(reason: DisputeReason, details: String): String {
        val trimmed = details.trim()
        if (reason == DisputeReason.OTHER) return trimmed
        if (trimmed.isEmpty()) return reason.record
        return "${reason.record} — $trimmed"
    }

    fun canSubmit(reason: DisputeReason, details: String): Boolean = if (reason == DisputeReason.OTHER) {
        details.trim().length >= OTHER_MIN_LENGTH
    } else {
        true
    }
}

/**
 * How long a grade stays disputable.
 *
 * **SEVEN days, not fourteen.** The US-1340 story title says 14, but 7 is what
 * both shipped clients enforce (web `submission-detail.tsx`, iOS
 * `GradeDisputeWindow`), and consistency across surfaces matters more here than
 * the story text: a seller told "you have 14 days" on Android and refused on
 * day 8 by the same product is worse than a shorter window honestly stated.
 *
 * Note the window is advisory. The edge's `/api/grade/dispute` route enforces
 * NO age limit, so this hides an action rather than preventing one.
 */
object GradeDisputeWindow {

    const val DAYS = 7
    private const val MILLIS_PER_DAY = 24L * 60 * 60 * 1000

    /**
     * @param createdAtIso the grade report's `created_at`.
     *
     * An absent or unparseable timestamp is treated as OPEN. Failing the other
     * way would silently withhold the only recourse a seller has over a
     * formatting quirk — and the server accepts the filing regardless.
     */
    fun isOpen(createdAtIso: String?, nowMillis: Long = System.currentTimeMillis()): Boolean {
        val created = parseIsoMillis(createdAtIso) ?: return true
        return created >= nowMillis - DAYS * MILLIS_PER_DAY
    }

    /** Whole days left, floored at 0. Null when the timestamp is unusable. */
    fun daysRemaining(createdAtIso: String?, nowMillis: Long = System.currentTimeMillis()): Int? {
        val created = parseIsoMillis(createdAtIso) ?: return null
        val elapsedDays = (nowMillis - created) / MILLIS_PER_DAY
        return (DAYS - elapsedDays).coerceAtLeast(0).toInt()
    }

    /**
     * Parse an ISO-8601 instant.
     *
     * The edge emits FRACTIONAL seconds, which several strict parsers reject
     * outright, so both shapes are tried. A parse failure returns null and the
     * caller treats the window as open.
     */
    fun parseIsoMillis(value: String?): Long? {
        val raw = value?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return runCatching { java.time.Instant.parse(raw).toEpochMilli() }
            .recoverCatching {
                java.time.OffsetDateTime.parse(raw).toInstant().toEpochMilli()
            }
            .getOrNull()
    }
}

/**
 * Maps a stored `disputes.status` to row-badge presentation (US-819), so the
 * grades list shows dispute state without opening each report.
 */
object DisputeStatusDisplay {

    /**
     * Short badge label, or null for an unknown/empty status.
     *
     * Unknown maps to null on purpose: the server's enum can gain a value
     * before this client knows it, and rendering a blank capsule for it looks
     * like a rendering bug rather than an unrecognized state.
     */
    @StringRes
    fun label(status: String?): Int? = when (status) {
        "open" -> R.string.dispute_status_open
        "under_review" -> R.string.dispute_status_under_review
        "resolved" -> R.string.dispute_status_resolved
        "rejected" -> R.string.dispute_status_rejected
        else -> null
    }

    fun isDisputed(status: String?): Boolean = label(status) != null

    /**
     * US-2976: the resource and the status separately, not a built sentence.
     *
     * This returned "Grade dispute: Under review" - two strings joined with a
     * colon that a translator cannot move. The caller formats it.
     */
    @StringRes
    fun accessibilityLabel(status: String?): Int =
        if (label(status) == null) R.string.dispute_a11y else R.string.dispute_a11y_with_status

    /**
     * Whether a NEW dispute may be filed. A grade already under dispute must
     * not accept a second one — nothing at the server or database layer stops
     * a duplicate, so this gate is the only thing preventing two rows for the
     * same complaint landing in the reviewer's queue.
     */
    fun canFile(status: String?): Boolean = !isDisputed(status)
}

// ── Wire ─────────────────────────────────────────────────────────────────

@Serializable
data class DisputeRequest(
    val gradeReportId: String,
    val reason: String,
    /** Base64 data-URI evidence photos; the edge caps this at 8. */
    val images: List<String> = emptyList(),
)

@Serializable
data class DisputeRow(
    val id: String = "",
    @SerialName("grade_report_id") val gradeReportId: String = "",
    val reason: String = "",
    val status: String = "open",
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class DisputeResponse(
    val dispute: DisputeRow = DisputeRow(),
    /** Evidence photos the server rejected — surfaced, never swallowed. */
    @SerialName("evidence_failures") val evidenceFailures: Int = 0,
)
