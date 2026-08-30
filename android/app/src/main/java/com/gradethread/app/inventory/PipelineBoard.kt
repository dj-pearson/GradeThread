package com.gradethread.app.inventory

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1342: the kanban board model (iOS `PipelineBoard`).
 *
 * Pure — grouping and move planning have no UI dependency.
 */
object PipelineBoard {

    /**
     * US-2976: [label] and [nextAction] are string RESOURCES. They were
     * literals, so the whole kanban board - thirteen column headings and
     * the thirteen next steps under them - was English in a Spanish app.
     * [status] is the persisted value and stays a String.
     */
    data class Column(val status: String, @StringRes val label: Int, @StringRes val nextAction: Int)

    /** 13 columns, mirroring the web `FLIPDESK_PIPELINE`. */
    val columns: List<Column> = listOf(
        Column("sourced", R.string.pipeline_sourced_label, R.string.pipeline_sourced_next),
        Column("cataloged", R.string.pipeline_cataloged_label, R.string.pipeline_cataloged_next),
        Column("measured", R.string.pipeline_measured_label, R.string.pipeline_measured_next),
        Column("photographed", R.string.pipeline_photographed_label, R.string.pipeline_photographed_next),
        Column("grading", R.string.pipeline_grading_label, R.string.pipeline_grading_next),
        Column("graded", R.string.pipeline_graded_label, R.string.pipeline_graded_next),
        Column("comped", R.string.pipeline_comped_label, R.string.pipeline_comped_next),
        Column("drafted", R.string.pipeline_drafted_label, R.string.pipeline_drafted_next),
        Column("listed", R.string.pipeline_listed_label, R.string.pipeline_listed_next),
        Column("sold", R.string.pipeline_sold_label, R.string.pipeline_sold_next),
        Column("shipped", R.string.pipeline_shipped_label, R.string.pipeline_shipped_next),
        Column("completed", R.string.pipeline_completed_label, R.string.pipeline_completed_next),
        Column("returned", R.string.pipeline_returned_label, R.string.pipeline_returned_next),
    )

    val statusOrder: List<String> = columns.map { it.status }
    val columnStatuses: Set<String> = statusOrder.toSet()

    /**
     * Statuses with no column, carried over from iOS deliberately.
     * `acquired` is the surprising one: it appears in the To-list TAB but is
     * invisible on the BOARD.
     */
    val statusesWithoutAColumn: Set<String> =
        InventoryStage.allKnownStatuses - columnStatuses

    /**
     * Bucket items by status.
     *
     * Every column is pre-seeded so empty ones still render — a board that
     * hides empty columns loses the sense of a pipeline. Items whose status
     * has no column are dropped.
     */
    fun <T> group(items: List<T>, status: (T) -> String): Map<String, List<T>> {
        val buckets = LinkedHashMap<String, MutableList<T>>()
        for (column in statusOrder) buckets[column] = mutableListOf()
        for (item in items) buckets[status(item)]?.add(item)
        return buckets
    }

    data class Move(val from: String, val to: String)

    /**
     * @return null when the move is a no-op or the target isn't a column.
     *
     * Movement is unrestricted in both directions — dragging backwards is
     * legitimate (a listing pulled back to re-photograph). [Move.from] is
     * retained so a failed optimistic write can be reverted.
     */
    fun planMove(from: String, to: String): Move? {
        if (from == to) return null
        if (to !in columnStatuses) return null
        return Move(from, to)
    }
}
