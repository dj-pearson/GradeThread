package com.gradethread.app.inventory

import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1348: what a bulk action offers, what it reports, and what it can undo.
 */
class BulkActionTest {

    // ── stage-appropriate sets ───────────────────────────────────────────

    @Test
    fun `a mixed selection gets only actions that work uniformly`() {
        // A status action across mixed statuses either regresses some rows or
        // silently skips them, and both read as a bug rather than a rule.
        val all = BulkAction.forStage(InventoryStage.ALL)
        assertEquals(listOf(BulkAction.Grade, BulkAction.Delete), all)
        assertFalse(all.contains(BulkAction.MarkShipped))
    }

    @Test
    fun `each stage offers the action that fits it`() {
        assertTrue(BulkAction.forStage(InventoryStage.SOLD).contains(BulkAction.MarkShipped))
        assertTrue(BulkAction.forStage(InventoryStage.UNLISTED).contains(BulkAction.CreateDraft))
        assertTrue(
            BulkAction.forStage(InventoryStage.ACTIVE).any { it is BulkAction.DropPrice },
        )
        // Mark-shipped is meaningless on an unsold item.
        assertFalse(BulkAction.forStage(InventoryStage.UNLISTED).contains(BulkAction.MarkShipped))
    }

    @Test
    fun `delete is available everywhere and always destructive`() {
        InventoryStage.entries.forEach { stage ->
            assertTrue(stage.name, BulkAction.forStage(stage).contains(BulkAction.Delete))
        }
        assertTrue(BulkAction.Delete.destructive)
        assertFalse(BulkAction.MarkShipped.destructive)
    }

    // ── reversibility ────────────────────────────────────────────────────

    @Test
    fun `delete is never offered an undo`() {
        // The rows are gone server-side and their photos cascade with them, so
        // an Undo that couldn't restore the images would be a promise we can't
        // keep. It confirms up front instead.
        assertFalse(BulkAction.Delete.reversible)
        assertTrue(BulkAction.Delete.destructive)
    }

    @Test
    fun `status and price changes are reversible`() {
        assertTrue(BulkAction.MarkShipped.reversible)
        assertTrue(BulkAction.CreateDraft.reversible)
        assertTrue(BulkAction.DropPrice(10).reversible)
        // Grading isn't reversible — the credits are spent.
        assertFalse(BulkAction.Grade.reversible)
    }

    @Test
    fun `an undo with nothing to restore is empty`() {
        val label = UiMessage(R.plurals.bulk_undo_label, quantity = 1)
        assertTrue(BulkUndo(label).isEmpty)
        assertFalse(BulkUndo(label, statuses = mapOf("a" to "sold")).isEmpty)
        assertFalse(BulkUndo(label, targetPrices = mapOf("a" to null)).isEmpty)
    }

    // ── the summary ──────────────────────────────────────────────────────

    @Test
    fun `a partial batch says so instead of reporting success`() {
        // A batch that half-worked and reported "Done" is how a seller
        // discovers two unshipped orders a week later.
        val result = BulkActionResult(
            action = BulkAction.MarkShipped,
            succeeded = 7,
            failures = List(2) { BulkActionResult.Failure("i$it", UiMessage(R.string.bulk_error_no_target_price)) },
        )
        // Succeeded, total, failed - in that order. Reversed, "Updated 9 of 7"
        // is nonsense and "2 of 9 failed" is a different batch.
        assertEquals(R.plurals.bulk_result_partial, result.summary.res)
        assertEquals(listOf<Any>(7, 9, 2), result.summary.args)
        // Pluralised on the TOTAL: the sentence is about nine items, not seven.
        assertEquals(9, result.summary.quantity)
        assertTrue(result.hasFailures)
    }

    @Test
    fun `a clean batch reads plainly and one item is singular`() {
        // US-2976: singular versus plural is the plurals resource's job now,
        // which is what Spanish needs - it agrees the verb too, so the two
        // forms differ in more than an "s".
        val many = BulkActionResult(BulkAction.CreateDraft, succeeded = 3).summary
        assertEquals(R.plurals.bulk_result_updated, many.res)
        assertEquals(3, many.quantity)

        val one = BulkActionResult(BulkAction.CreateDraft, succeeded = 1).summary
        assertEquals(R.plurals.bulk_result_updated, one.res)
        assertEquals(1, one.quantity)
    }

    @Test
    fun `a total failure is not dressed up`() {
        val result = BulkActionResult(
            action = BulkAction.MarkShipped,
            succeeded = 0,
            failures = List(4) { BulkActionResult.Failure("i$it", UiMessage(R.string.bulk_error_generic)) },
        )
        // A DIFFERENT resource from the partial case, so "all of them failed"
        // can never be worded as a partial success.
        assertEquals(R.plurals.bulk_result_all_failed, result.summary.res)
        assertEquals(listOf<Any>(4), result.summary.args)
    }

    // ── the price drop ───────────────────────────────────────────────────

    @Test
    fun `a percentage drop rounds to whole cents`() {
        assertEquals(45.0, BulkPricing.dropped(50.0, 10)!!, 1e-9)
        assertEquals(29.7, BulkPricing.dropped(33.0, 10)!!, 1e-9)
    }

    @Test
    fun `a drop can never floor an item to nothing`() {
        // A percentage of a small price otherwise lands on 0, and an item
        // listed at nothing is worse than one that didn't move.
        assertEquals(0.01, BulkPricing.dropped(0.01, 90)!!, 1e-9)
        assertTrue(BulkPricing.dropped(0.02, 99)!! >= 0.01)
    }

    @Test
    fun `an item with no price fails with a reason rather than gaining one`() {
        assertNull(BulkPricing.dropped(null, 10))
        assertNull(BulkPricing.dropped(0.0, 10))
    }

    // ── confirmation copy ────────────────────────────────────────────────

    @Test
    fun `the delete confirmation names both consequences`() {
        // US-2976: the two consequences live in the plurals resource now, and
        // BOTH forms have to carry them - a singular that drops "and this
        // can't be undone" is the whole warning gone for a one-item delete.
        val copy = BulkAction.Delete.confirmationTitle(3)
        assertEquals(R.plurals.bulk_confirm_delete, copy.res)
        assertEquals(3, copy.quantity)
    }

    @Test
    fun `confirmation copy is singular for one item`() {
        // The COUNT is the plural selector, so one item and five items pick
        // different forms without this object choosing between them.
        val one = BulkAction.MarkShipped.confirmationTitle(1)
        assertEquals(R.plurals.bulk_confirm_mark_shipped, one.res)
        assertEquals(1, one.quantity)

        // Count first, percent second: reversed, "Drop price -5% on 10 items"
        // is a different offer from the one the seller chose.
        val many = BulkAction.DropPrice(10).confirmationTitle(5)
        assertEquals(R.plurals.bulk_confirm_drop_price, many.res)
        assertEquals(listOf<Any>(5, 10), many.args)
        assertEquals(5, many.quantity)
    }
}
