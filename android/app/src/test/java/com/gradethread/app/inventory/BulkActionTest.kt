package com.gradethread.app.inventory

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
        assertTrue(BulkAction.forStage(InventoryStage.TO_LIST).contains(BulkAction.CreateDraft))
        assertTrue(
            BulkAction.forStage(InventoryStage.ACTIVE).any { it is BulkAction.DropPrice },
        )
        // Mark-shipped is meaningless on an unsold item.
        assertFalse(BulkAction.forStage(InventoryStage.TO_LIST).contains(BulkAction.MarkShipped))
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
        assertTrue(BulkUndo("x").isEmpty)
        assertFalse(BulkUndo("x", statuses = mapOf("a" to "sold")).isEmpty)
        assertFalse(BulkUndo("x", targetPrices = mapOf("a" to null)).isEmpty)
    }

    // ── the summary ──────────────────────────────────────────────────────

    @Test
    fun `a partial batch says so instead of reporting success`() {
        // A batch that half-worked and reported "Done" is how a seller
        // discovers two unshipped orders a week later.
        val result = BulkActionResult(
            action = BulkAction.MarkShipped,
            succeeded = 7,
            failures = List(2) { BulkActionResult.Failure("i$it", "No target price to drop.") },
        )
        assertEquals("Updated 7 of 9 items; 2 failed.", result.summary)
        assertTrue(result.hasFailures)
    }

    @Test
    fun `a clean batch reads plainly and one item is singular`() {
        assertEquals(
            "Updated 3 items.",
            BulkActionResult(BulkAction.CreateDraft, succeeded = 3).summary,
        )
        assertEquals(
            "Updated 1 item.",
            BulkActionResult(BulkAction.CreateDraft, succeeded = 1).summary,
        )
    }

    @Test
    fun `a total failure is not dressed up`() {
        val result = BulkActionResult(
            action = BulkAction.MarkShipped,
            succeeded = 0,
            failures = List(4) { BulkActionResult.Failure("i$it", "nope") },
        )
        assertEquals("All 4 items failed.", result.summary)
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
        val copy = BulkAction.Delete.confirmationTitle(3)
        assertTrue(copy.contains("photos"))
        assertTrue(copy.contains("can't be undone"))
    }

    @Test
    fun `confirmation copy is singular for one item`() {
        assertEquals(
            "Mark 1 item as shipped?",
            BulkAction.MarkShipped.confirmationTitle(1),
        )
        assertEquals(
            "Drop price -10% on 5 items?",
            BulkAction.DropPrice(10).confirmationTitle(5),
        )
    }
}
