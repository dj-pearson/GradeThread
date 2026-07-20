package com.gradethread.app.inventory

/**
 * US-1342: the kanban board model (iOS `PipelineBoard`).
 *
 * Pure — grouping and move planning have no UI dependency.
 */
object PipelineBoard {

    data class Column(val status: String, val label: String, val nextAction: String)

    /** 13 columns, mirroring the web `FLIPDESK_PIPELINE`. */
    val columns: List<Column> = listOf(
        Column("sourced", "Sourced", "Catalog basic info"),
        Column("cataloged", "Cataloged", "Measure"),
        Column("measured", "Measured", "Photograph"),
        Column("photographed", "Photographed", "Send to GradeThread"),
        Column("grading", "Grading", "Awaiting grade"),
        Column("graded", "Graded", "Run comps"),
        Column("comped", "Comped", "Draft listing"),
        Column("drafted", "Drafted", "Push to eBay"),
        Column("listed", "Listed", "Wait for sale"),
        Column("sold", "Sold", "Ship"),
        Column("shipped", "Shipped", "Confirm delivery"),
        Column("completed", "Completed", "Archive"),
        Column("returned", "Returned", "Relist or write off"),
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
