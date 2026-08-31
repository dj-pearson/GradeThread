package com.gradethread.app.inventory

import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

/**
 * US-1348: one action offered in the multi-select bar.
 *
 * DELIBERATELY NARROWER THAN iOS. The iOS set includes Publish, End listing
 * and the eBay-backed price drop.
 *
 * The original reason given here — "Android has no listing composer yet" —
 * stopped being true when PublishSheet was wired into the item canvas, and
 * US-2490 has since added reprice, resubmit and end as PER-LISTING actions on
 * the listing card. What remains true is the reason to keep them off the BULK
 * bar: each of these pushes to a live marketplace, and a multi-select that
 * ends forty listings on one tap is a different risk from ending one after a
 * confirmation. Bulk versions want the same treatment the web gives them
 * (selection, confirm, per-row result), which is its own story.
 */
sealed class BulkAction {

    /** Move the selection to `drafted`. */
    object CreateDraft : BulkAction()

    object MarkShipped : BulkAction()

    /** Reduce TARGET price by [percent] — the local price, not a live listing. */
    data class DropPrice(val percent: Int) : BulkAction()

    /**
     * Grading is intercepted by the list, not run here: it needs a tier,
     * readiness and credits, which is the US-1339 sheet's whole job.
     */
    object Grade : BulkAction()

    object Delete : BulkAction()

    val id: String
        get() = when (this) {
            CreateDraft -> "create_draft"
            MarkShipped -> "mark_shipped"
            is DropPrice -> "drop_price_$percent"
            Grade -> "grade"
            Delete -> "delete"
        }

    val label: UiMessage
        get() = when (this) {
            CreateDraft -> UiMessage(R.string.bulk_label_create_draft)
            MarkShipped -> UiMessage(R.string.bulk_label_mark_shipped)
            is DropPrice -> UiMessage(R.string.bulk_label_drop_price, args = listOf(percent))
            Grade -> UiMessage(R.string.bulk_label_grade)
            Delete -> UiMessage(R.string.bulk_label_delete)
        }

    /** A plurals resource whose count is also the number in the sentence. */
    private fun plural(res: Int, count: Int) = UiMessage(res, args = listOf(count), quantity = count)

    /** Destructive actions confirm before running. */
    val destructive: Boolean get() = this == Delete

    /**
     * Whether the action can be taken back within the undo window.
     *
     * Delete is NOT reversible: the rows are gone server-side and their photos
     * cascade with them, so an "Undo" that couldn't restore the images would
     * be a promise we can't keep. It confirms up front instead.
     */
    val reversible: Boolean
        get() = when (this) {
            CreateDraft, MarkShipped -> true
            is DropPrice -> true
            Grade, Delete -> false
        }

    /**
     * US-2976: a plurals resource per action, with the COUNT as both the
     * selector and the number in the sentence.
     *
     * The old `if (count == 1) "item" else "items"` is exactly the shape that
     * does not survive translation - Spanish agrees the verb and the adjective
     * with the noun too, so "Marcar 1 artículo como enviado" and "Marcar 3
     * artículos como enviados" differ in three places, not one.
     */
    fun confirmationTitle(count: Int): UiMessage = when (this) {
        CreateDraft -> plural(R.plurals.bulk_confirm_create_draft, count)
        MarkShipped -> plural(R.plurals.bulk_confirm_mark_shipped, count)
        is DropPrice -> UiMessage(
            R.plurals.bulk_confirm_drop_price,
            args = listOf(count, percent),
            quantity = count,
        )

        Grade -> plural(R.plurals.bulk_confirm_grade, count)
        Delete -> plural(R.plurals.bulk_confirm_delete, count)
    }

    companion object {

        /**
         * Stage-appropriate sets, mirroring the iOS bottom-bar predicate minus
         * the eBay-backed actions.
         *
         * A MIXED selection (the All tab) gets nothing but Delete and Grade,
         * because a status action across mixed statuses either regresses some
         * rows or silently skips them — and both read as a bug.
         */
        fun forStage(stage: InventoryStage): List<BulkAction> = when (stage) {
            InventoryStage.TO_LIST -> listOf(Grade, CreateDraft, Delete)
            InventoryStage.DRAFTS -> listOf(Grade, Delete)
            InventoryStage.ACTIVE -> listOf(DropPrice(10), Delete)
            InventoryStage.SOLD -> listOf(MarkShipped, Delete)
            InventoryStage.SHIPPED -> listOf(Delete)
            InventoryStage.RETURNED -> listOf(Delete)
            InventoryStage.ALL -> listOf(Grade, Delete)
        }
    }
}

/** What a batch did. */
data class BulkActionResult(val action: BulkAction, val succeeded: Int, val failures: List<Failure> = emptyList()) {
    /**
     * US-2976: [message] is a UiMessage because the two sources of this
     * sentence are different. A skip we decided ("No target price to drop.")
     * is our copy and translates; a server rejection is the server's own words
     * and rides as `detail`. Flattening both to String made the second look
     * like the first.
     */
    data class Failure(val itemId: String, val message: UiMessage)

    val total: Int get() = succeeded + failures.size

    /**
     * The summary line.
     *
     * Partial success is named explicitly — "Updated 7 of 9" — because a batch
     * that half-worked and reported "Done" is how a seller discovers two
     * unshipped orders a week later.
     */
    val summary: UiMessage
        get() = when {
            failures.isEmpty() -> UiMessage(
                R.plurals.bulk_result_updated,
                args = listOf(succeeded),
                quantity = succeeded,
            )

            succeeded == 0 -> UiMessage(
                R.plurals.bulk_result_all_failed,
                args = listOf(failures.size),
                quantity = failures.size,
            )

            // The partial case pluralises on the TOTAL, which is the noun the
            // sentence is about - "Updated 1 of 9 items" is nine items, not one.
            else -> UiMessage(
                R.plurals.bulk_result_partial,
                args = listOf(succeeded, total, failures.size),
                quantity = total,
            )
        }

    val hasFailures: Boolean get() = failures.isNotEmpty()
}

/**
 * What an undo needs to put back.
 *
 * Snapshots are taken BEFORE the batch runs, and only for the items that
 * actually succeeded — reverting an item whose update failed would write a
 * value it never had.
 */
data class BulkUndo(
    val label: UiMessage,
    val statuses: Map<String, String> = emptyMap(),
    val targetPrices: Map<String, Double?> = emptyMap(),
) {
    val isEmpty: Boolean get() = statuses.isEmpty() && targetPrices.isEmpty()

    companion object {
        /** How long the undo affordance stays up (iOS US-972). */
        const val WINDOW_SECONDS = 6
    }
}

object BulkPricing {

    /**
     * Apply a percentage drop.
     *
     * Rounded to whole cents and floored at one cent: a percentage of a small
     * price can otherwise land on 0, and an item listed at nothing is worse
     * than one that didn't move. Returns null when there is no price to drop,
     * so the item fails with a reason rather than silently gaining one.
     */
    fun dropped(current: Double?, percent: Int): Double? {
        if (current == null || current <= 0.0) return null
        val next = current * (100 - percent) / 100.0
        return (Math.round(next * 100) / 100.0).coerceAtLeast(0.01)
    }
}
