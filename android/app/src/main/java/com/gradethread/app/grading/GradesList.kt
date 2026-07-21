package com.gradethread.app.grading

import com.gradethread.app.sync.db.InventoryItemEntity

/**
 * US-1341: the grades history — which items count, how they sort, and what the
 * summary may claim.
 *
 * Pure over the denormalized inventory columns, so the "certified" rule below
 * is provable without Room.
 */
object GradesList {

    enum class Sort(val label: String) {
        RECENT("Most recent"),
        HIGHEST("Highest grade"),
        LOWEST("Lowest grade"),
    }

    /** Every item carrying a grade, provisional ones included. */
    fun graded(items: List<InventoryItemEntity>): List<InventoryItemEntity> =
        items.filter { it.gradeValue != null }

    /**
     * Is this grade still awaiting human review?
     *
     * Derived from the DENORMALIZED row rather than the report, because the
     * list must render offline from Room alone. A finalized grade always has a
     * certificate URL or a report id; a provisional one has a score and
     * neither, since both are withheld until a reviewer clears it (US-1209).
     */
    fun isPendingReview(item: InventoryItemEntity): Boolean =
        item.gradeValue != null &&
            item.certificateUrl.isNullOrBlank() &&
            item.gradeReportId.isNullOrBlank()

    /**
     * Items whose grade has actually certified.
     *
     * The distinction matters for the average: a provisional score can still be
     * revised or withdrawn by the reviewer, so averaging it in would quote a
     * portfolio number partly built on grades that do not yet officially exist.
     */
    fun certified(items: List<InventoryItemEntity>): List<InventoryItemEntity> =
        graded(items).filter { !isPendingReview(it) }

    /** Null when nothing has certified yet — never 0.0, which reads as a grade. */
    fun averageGrade(items: List<InventoryItemEntity>): Double? {
        val values = certified(items).mapNotNull { it.gradeValue }
        if (values.isEmpty()) return null
        return values.sum() / values.size
    }

    fun sorted(items: List<InventoryItemEntity>, sort: Sort): List<InventoryItemEntity> {
        val graded = graded(items)
        return when (sort) {
            // Recency is `updatedAt`, matching iOS. It is not strictly "graded
            // at" — the column moves on any edit — but it is the only date the
            // denormalized row carries, and pretending otherwise would need a
            // join the offline list can't do.
            Sort.RECENT -> graded.sortedByDescending { it.updatedAt }
            Sort.HIGHEST -> graded.sortedByDescending { it.gradeValue ?: 0.0 }
            Sort.LOWEST -> graded.sortedBy { it.gradeValue ?: 0.0 }
        }
    }

    /** The header line above the list. */
    data class Summary(val total: Int, val certified: Int, val average: Double?) {
        val averageLabel: String
            get() = average?.let { String.format(java.util.Locale.US, "%.1f", it) } ?: "—"

        /**
         * Only mentions provisional grades when there are some — a permanent
         * "0 pending" is noise that trains people to stop reading the line.
         */
        val label: String
            get() = buildString {
                append("$total graded")
                val pending = total - certified
                if (pending > 0) append(" · $pending pending review")
                if (average != null) append(" · avg $averageLabel")
            }
    }

    fun summarize(items: List<InventoryItemEntity>): Summary {
        val graded = graded(items)
        return Summary(
            total = graded.size,
            certified = certified(items).size,
            average = averageGrade(items),
        )
    }
}
