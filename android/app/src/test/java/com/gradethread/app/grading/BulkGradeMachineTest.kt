package com.gradethread.app.grading

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1339: the batch gate, which is deliberately NOT the single-item gate.
 */
class BulkGradeMachineTest {

    private fun item(id: String, ready: Boolean, blocker: String? = null) =
        GradingValidatedItem(
            inventoryItemId = id,
            ready = ready,
            blockers = listOfNotNull(blocker),
            title = "Item $id",
        )

    private fun validation(
        items: List<GradingValidatedItem>,
        limitExceeded: Boolean = false,
    ) = GradingValidateResponse(
        items = items,
        limitExceeded = limitExceeded,
        // The SERVER's all-or-nothing verdict. The batch flow must not consult
        // it; asserting it is false here is the point of the next test.
        canSubmit = items.all { it.ready } && !limitExceeded,
        creditsRequired = items.count { it.ready },
    )

    @Test
    fun `one blocked item does not stop the rest`() {
        // The single-item flow gates on the server's can_submit, which requires
        // EVERY item to be ready. A batch that refused because one of twenty is
        // missing a photo would be useless.
        val v = validation(
            listOf(item("a", true), item("b", false, "Missing back photo"), item("c", true)),
        )
        assertFalse("server verdict is all-or-nothing", v.canSubmit)
        assertTrue("batch gate is not", BulkGradeMachine.canSubmit(v, submitting = false))
        assertEquals(listOf("a", "c"), BulkGradeMachine.readyItems(v).map { it.inventoryItemId })
        assertEquals(listOf("b"), BulkGradeMachine.blockedItems(v).map { it.inventoryItemId })
    }

    @Test
    fun `a selection with nothing ready cannot submit`() {
        val v = validation(listOf(item("a", false, "No photos"), item("b", false, "No photos")))
        assertFalse(BulkGradeMachine.canSubmit(v, submitting = false))
    }

    @Test
    fun `the credit wall still blocks the whole batch`() {
        // Unlike readiness, affordability is not per-item — the server prices
        // the batch as a unit, so a shortfall stops all of it.
        val v = validation(listOf(item("a", true), item("b", true)), limitExceeded = true)
        assertFalse(BulkGradeMachine.canSubmit(v, submitting = false))
    }

    @Test
    fun `an in-flight submit cannot be submitted again`() {
        // Folded into the gate rather than only the button's enabled state, so
        // a double-tap can't consume the included grades twice (iOS US-1497).
        val v = validation(listOf(item("a", true)))
        assertTrue(BulkGradeMachine.canSubmit(v, submitting = false))
        assertFalse(BulkGradeMachine.canSubmit(v, submitting = true))
    }

    @Test
    fun `no validation means no submit`() {
        assertFalse(BulkGradeMachine.canSubmit(null, submitting = false))
        assertTrue(BulkGradeMachine.readyItems(null).isEmpty())
    }

    // ── the summary ──────────────────────────────────────────────────────

    @Test
    fun `a clean batch reads as a plain count`() {
        val summary = BulkGradeMachine.summarize(
            GradingSubmitResponse(submitted = 3, failed = 0),
            blockedBeforeSubmit = 0,
        )
        assertEquals("3 items submitted", summary.headline)
        assertNull(summary.detail)
    }

    @Test
    fun `one item is not "1 items"`() {
        val summary = BulkGradeMachine.summarize(
            GradingSubmitResponse(submitted = 1),
            blockedBeforeSubmit = 0,
        )
        assertEquals("1 item submitted", summary.headline)
    }

    @Test
    fun `withheld and rejected are counted together but explained apart`() {
        // Both are "blocked" to the seller, but the next action differs: fix
        // the blockers versus look at why the server refused.
        val summary = BulkGradeMachine.summarize(
            GradingSubmitResponse(submitted = 5, failed = 2),
            blockedBeforeSubmit = 3,
        )
        assertEquals("5 submitted, 5 blocked", summary.headline)
        assertEquals(
            "3 not ready — fix the blockers and try again · 2 rejected at submit",
            summary.detail,
        )
    }

    @Test
    fun `a batch that submitted nothing says so plainly`() {
        val summary = BulkGradeMachine.summarize(
            GradingSubmitResponse(submitted = 0, failed = 4),
            blockedBeforeSubmit = 0,
        )
        assertEquals("Nothing was submitted", summary.headline)
        assertEquals("4 rejected at submit", summary.detail)
    }

    // ── the request body ─────────────────────────────────────────────────

    @Test
    fun `the batch body is capped at the edge's own limit`() {
        // The schema is `.max(200)`, and it rejects the whole array — sending
        // 201 items fails all 201, so the cap belongs here, not in a 400.
        val body = GradingRequestBody.batch(
            (1..250).map { "item-$it" },
            GradeTier.STANDARD,
        )
        assertEquals(GradingRequestBody.MAX_BATCH, body.items.size)
        assertEquals("item-1", body.items.first().inventoryItemId)
    }

    @Test
    fun `every batch item carries the chosen tier`() {
        val body = GradingRequestBody.batch(listOf("a", "b"), GradeTier.EXPRESS)
        assertTrue(body.items.all { it.tier == "express" })
    }

    @Test
    fun `an empty selection encodes to an empty batch, not a malformed one`() {
        assertTrue(GradingRequestBody.batch(emptyList(), GradeTier.STANDARD).items.isEmpty())
    }
}
